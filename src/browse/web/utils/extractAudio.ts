import { FFmpeg } from "@ffmpeg/ffmpeg";

/**
 * Turns a video into the audio the transcription actually reads, in the
 * browser, before anything is uploaded.
 *
 * The server only ever looks at 16 kHz mono audio - the speech detector
 * decodes to exactly that, and the clips it uploads to the model are built
 * from it - so sending the video would be sending two gigabytes to have a few
 * megabytes taken out of it. Doing the extraction here instead costs the
 * uploader some CPU and saves them the entire upload: an hour of video leaves
 * as about five megabytes of Opus.
 *
 * ffmpeg runs as WebAssembly, from files served by this application rather
 * than from a CDN, because this is an offline tool and has to work with no
 * outside network at all - the same reason the PDF reader's worker is bundled.
 * It is the single-threaded build on purpose: the multi-threaded one needs
 * `SharedArrayBuffer`, which needs cross-origin isolation, which would change
 * how every other page here loads its media.
 */

/** Where `vite-plugin-static-copy` puts the core, mirroring the pdf.js one. */
const CORE_BASE = '/assets/ffmpeg';

/**
 * What the audio is encoded as.
 *
 * Opus at 24 kbps mono is well above what speech recognition needs and about a
 * thousandth of a typical video. 16 kHz because that is the rate everything
 * downstream resamples to anyway, so this is not a loss - it is the same
 * resampling done once, here, instead of again on every pass.
 */
const AUDIO_ARGS = [
  '-vn',
  '-ac', '1',
  '-ar', '16000',
  '-c:a', 'libopus',
  '-b:a', '24k',
  // Opus's own speech mode: at this bitrate it is audibly better on voice, and
  // voice is the only thing being sent.
  '-application', 'voip'
];

const OUTPUT_NAME = 'audio.ogg';
/**
 * The name the input is mounted under.
 *
 * Fixed rather than the file's own: a name arriving from someone's disk can
 * hold quotes, newlines or a leading dash, and it is about to be an argument
 * to a command line. ffmpeg reads the container from the bytes, so the
 * extension is not load-bearing.
 */
const INPUT_NAME = 'input.bin';
const MOUNT_POINT = '/mount';

export interface ExtractProgress {
  /** 0 to 1, as ffmpeg reports it. */
  fraction: number;
}

let loading: Promise<FFmpeg> | null = null;

/**
 * The one ffmpeg instance, loaded on first use.
 *
 * Kept between extractions: the core is a 31 MB download and a slow
 * instantiation, and a second video should not pay for either. It is not
 * loaded when the page opens - somebody who never uploads anything never
 * fetches it.
 */
function getFFmpeg(): Promise<FFmpeg> {
  if (!loading) {
    loading = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: `${CORE_BASE}/ffmpeg-core.js`,
        wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`
      });
      return ffmpeg;
    })().catch((error: unknown) => {
      // A failed load must not be cached as the instance: the next attempt
      // should try again rather than reject forever.
      loading = null;
      throw error;
    });
  }
  return loading;
}

/** Whether the browser can run this at all. */
export function canExtractAudio() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

/**
 * Extracts `file`'s audio and hands back what to upload.
 *
 * The video is mounted rather than copied in: `WORKERFS` gives ffmpeg a view
 * of the file on disk, so a two gigabyte film is read in pieces instead of
 * being loaded into WebAssembly memory, which it would not fit in.
 *
 * Throws when the file has no audio track, when ffmpeg cannot read it, or when
 * it runs out of memory trying. There is deliberately no falling back to
 * uploading the video itself - that is the bandwidth this page exists to
 * avoid.
 */
export async function extractAudio(
  file: File,
  onProgress?: (progress: ExtractProgress) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const onFFmpegProgress = ({ progress }: { progress: number }) => {
    // ffmpeg reports against the duration it guessed, which can overshoot on a
    // stream whose header lies; a fraction above one reads as finished.
    onProgress?.({ fraction: Math.max(0, Math.min(1, progress)) });
  };
  ffmpeg.on('progress', onFFmpegProgress);

  const abort = () => ffmpeg.terminate();
  signal?.addEventListener('abort', abort, { once: true });

  // Renamed rather than copied: a `File` built from another one references the
  // same bytes on disk instead of reading them.
  const mounted = new File([ file ], INPUT_NAME, { type: file.type });
  let mountedOk = false;
  try {
    try {
      await ffmpeg.createDir(MOUNT_POINT);
    }
    catch {
      // Left over from a previous extraction in this page's lifetime.
    }
    await ffmpeg.mount('WORKERFS' as Parameters<typeof ffmpeg.mount>[0], {
      files: [ mounted ]
    }, MOUNT_POINT);
    mountedOk = true;

    const code = await ffmpeg.exec([
      '-i', `${MOUNT_POINT}/${INPUT_NAME}`,
      ...AUDIO_ARGS,
      OUTPUT_NAME
    ]);
    if (code !== 0) {
      throw Error(
        'This video could not be converted in the browser. It may use a format ' +
        'ffmpeg cannot read here, or be too large for the browser to handle.'
      );
    }
    const data = await ffmpeg.readFile(OUTPUT_NAME);
    if (typeof data === 'string' || data.length === 0) {
      throw Error('No audio came out of that file - does it have a soundtrack?');
    }
    // Copied out of the wasm heap, so freeing the file below cannot pull the
    // bytes out from under the upload.
    return new Blob([ data.slice() ], { type: 'audio/ogg' });
  }
  finally {
    ffmpeg.off('progress', onFFmpegProgress);
    signal?.removeEventListener('abort', abort);
    if (!signal?.aborted) {
      // Both are best-effort: the extraction is over either way, and a file
      // that cannot be deleted is a few megabytes in a tab, not a failure to
      // report to whoever is watching the progress bar.
      try {
        await ffmpeg.deleteFile(OUTPUT_NAME);
      }
      catch { /* empty */ }
      if (mountedOk) {
        try {
          await ffmpeg.unmount(MOUNT_POINT);
        }
        catch { /* empty */ }
      }
    }
    else {
      // The instance was terminated; the next extraction loads a new one.
      loading = null;
    }
  }
}

/**
 * How long the file is, read by the browser itself rather than by ffmpeg.
 *
 * Only for showing a length beside the row - a video whose duration cannot be
 * read is still perfectly transcribable, so this answers `null` rather than
 * failing.
 */
export function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement('video');
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    element.preload = 'metadata';
    element.onloadedmetadata = () => done(
      Number.isFinite(element.duration) ? element.duration : null
    );
    element.onerror = () => done(null);
    element.src = url;
  });
}
