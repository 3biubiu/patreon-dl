import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
// Type-only, so this does not close the import cycle with the detector.
import type { TimeRange } from './VoiceActivityDetector.js';

/** Silero is trained at this rate; feeding it anything else degrades it. */
export const SAMPLE_RATE = 16000;

/** How a clip is encoded for whichever provider is going to be given it. */
export interface AudioFormat {
  /** ffmpeg encoder name. */
  codec: string;
  /** Extension, dot included, so the container matches the codec. */
  ext: string;
  /** What the provider is told the bytes are. */
  mimeType: string;
  bitrateKbps: number;
}

/**
 * Opus at 24 kbps is about 11 MB per hour - well inside what an endpoint will
 * accept, and far above what a speech model needs given it resamples to 16 kHz
 * regardless.
 */
export const OPUS_FORMAT: AudioFormat = {
  codec: 'libopus',
  ext: '.ogg',
  mimeType: 'audio/ogg',
  bitrateKbps: 24
};

/**
 * For providers whose documented format list does not include Opus. MP3 is on
 * every such list, and 48 kbps is chosen over Opus's 24 because the codec is
 * two decades older and needs the room to say the same thing.
 */
export const MP3_FORMAT: AudioFormat = {
  codec: 'libmp3lame',
  ext: '.mp3',
  mimeType: 'audio/mp3',
  bitrateKbps: 48
};

/**
 * What a clip too long for a single filtergraph is spliced through. WAV at
 * the splice rate carries every sample it was handed, so a batch re-read is
 * bit for bit the audio it wrote and joining batches costs nothing.
 */
const PCM_PART_FORMAT: AudioFormat = {
  codec: 'pcm_s16le',
  ext: '.wav',
  mimeType: 'audio/wav',
  bitrateKbps: 256
};

/**
 * How many pieces may go into one `aselect` expression.
 *
 * ffmpeg evaluates an expression by walking a tree, and `a + b + c + ...`
 * is one branch per term, so a clip's piece count is the recursion depth.
 * Past a few hundred terms that dies inside ffmpeg - some builds report
 * `Cannot allocate memory` while initializing the filters, others overflow
 * the stack - and a long video whose detection settings produce many short
 * intervals reaches those counts easily.
 *
 * Thirty-two rather than a hundred: builds vary widely in what they survive
 * (one server in the field failed inside this range while another ran four
 * thousand terms), and the batch count only costs re-decoding the source
 * per extra batch, so the safe margin is worth more than the pass count.
 * The join is lossless, so the spliced timeline is the same either way.
 */
const MAX_PIECES_PER_GRAPH = 32;

/**
 * The resolution a spliced clip's cut points are rounded to, in seconds.
 *
 * Ten milliseconds is far finer than the third of a second of padding either
 * side of a piece, so nothing is lost at a boundary, and coarse enough that
 * an hour of audio is only a few hundred thousand frames to step through.
 */
export const SPLICE_GRID = 0.01;

/**
 * Rounds a cut point onto the splice grid, where ffmpeg can hit it exactly.
 *
 * Every boundary that ends up in a clip goes through this - here and in the
 * caller both - so that the duration the caller adds up and the duration
 * ffmpeg writes are the same number. They have to be: the caller reads a
 * timestamp back by counting piece durations, and a millisecond of
 * disagreement per piece is a subtitle that slides as the clip goes on.
 */
export function snapToSpliceGrid(seconds: number) {
  return Math.round(seconds / SPLICE_GRID) * SPLICE_GRID;
}

/**
 * The two ffmpeg passes transcription needs: raw PCM for the voice detector,
 * and compressed clips for upload.
 *
 * `child_process` rather than fluent-ffmpeg: the detector wants PCM off
 * stdout a frame at a time, and buffering a whole film to hand it over in
 * one piece would cost a couple of hundred megabytes.
 */
export default class AudioExtractor {
  name = 'AudioExtractor';

  #ffmpegPath: string;
  #ffprobePath: string;
  #logger?: Logger | null;

  constructor(pathToFFmpeg?: string | null, logger?: Logger | null) {
    this.#ffmpegPath = pathToFFmpeg || 'ffmpeg';
    this.#ffprobePath = 'ffprobe';
    if (pathToFFmpeg) {
      // ffprobe normally sits next to the ffmpeg binary.
      const probe = path.resolve(
        path.dirname(pathToFFmpeg),
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      );
      if (fs.existsSync(probe)) {
        this.#ffprobePath = probe;
      }
    }
    this.#logger = logger;
  }

  /** Length of the file in seconds, or `null` when ffprobe cannot tell. */
  async probeDuration(videoPath: string): Promise<number | null> {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ];
    try {
      const out = await this.#run(this.#ffprobePath, args);
      const duration = Number.parseFloat(out.trim());
      return Number.isFinite(duration) ? duration : null;
    }
    catch (error) {
      this.log('debug', `Could not probe duration of "${videoPath}":`, error);
      return null;
    }
  }

  /**
   * Decodes the whole file to 16 kHz mono and hands it to `onFrame` in
   * `frameSize`-sample pieces. A trailing partial frame is zero-padded so the
   * detector always sees the shape it expects.
   *
   * Resolves with the number of samples decoded.
   */
  streamPCM(
    videoPath: string,
    frameSize: number,
    onFrame: (frame: Float32Array, offsetSamples: number) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const args = [
      '-v', 'error',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      '-'
    ];

    return new Promise<number>((resolve, reject) => {
      const child = spawn(this.#ffmpegPath, args, { stdio: [ 'ignore', 'pipe', 'pipe' ] });
      const frameBytes = frameSize * 4;
      // Carries the bytes left over when a chunk does not divide into frames.
      let carry = Buffer.alloc(0);
      let samples = 0;
      let stderr = '';
      let settled = false;

      const abort = () => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(Error('Aborted'));
        }
      };
      signal?.addEventListener('abort', abort, { once: true });

      const cleanup = () => signal?.removeEventListener('abort', abort);

      child.stdout.on('data', (chunk: Buffer) => {
        let buffer = carry.length ? Buffer.concat([ carry, chunk ]) : chunk;
        let offset = 0;
        while (buffer.length - offset >= frameBytes) {
          const frame = new Float32Array(frameSize);
          for (let i = 0; i < frameSize; i++) {
            frame[i] = buffer.readFloatLE(offset + i * 4);
          }
          try {
            onFrame(frame, samples);
          }
          catch (error) {
            if (!settled) {
              settled = true;
              child.kill();
              cleanup();
              reject(error instanceof Error ? error : Error(String(error)));
            }
            return;
          }
          samples += frameSize;
          offset += frameBytes;
        }
        carry = offset < buffer.length ? Buffer.from(buffer.subarray(offset)) : Buffer.alloc(0);
        buffer = Buffer.alloc(0);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        // Keep only the tail; ffmpeg is chatty and only the last error matters.
        stderr = (stderr + chunk.toString()).slice(-2000);
      });

      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (code !== 0) {
          reject(Error(`ffmpeg exited with ${code}: ${stderr.trim()}`));
          return;
        }
        if (carry.length >= 4) {
          const remaining = Math.floor(carry.length / 4);
          const frame = new Float32Array(frameSize);
          for (let i = 0; i < remaining; i++) {
            frame[i] = carry.readFloatLE(i * 4);
          }
          try {
            onFrame(frame, samples);
          }
          catch (error) {
            reject(error instanceof Error ? error : Error(String(error)));
            return;
          }
          samples += remaining;
        }
        resolve(samples);
      });
    });
  }

  /**
   * Writes `pieces` to `outPath` as one continuous mono 16 kHz audio file,
   * with everything between them left out.
   *
   * This is what lets a request carry half an hour of speech instead of half
   * an hour of video: the silence the detector found never reaches the wire,
   * so nothing is paid for it and Whisper is never given the empty stretches
   * it invents captions to fill. What comes back is on the spliced file's own
   * timeline, and the caller has to map it back.
   *
   * A clip with more pieces than one expression survives - see
   * `MAX_PIECES_PER_GRAPH` - is spliced in batches and joined, which leaves
   * that timeline exactly where a single pass would have put it.
   *
   * The codec is the provider's choice rather than this file's, because not
   * every one of them accepts Opus - see `AudioFormat`.
   */
  async extractPieces(
    videoPath: string,
    pieces: TimeRange[],
    outPath: string,
    format: AudioFormat = OPUS_FORMAT,
    signal?: AbortSignal
  ) {
    if (pieces.length === 0) {
      throw Error('A clip needs at least one piece of audio');
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (pieces.length <= MAX_PIECES_PER_GRAPH) {
      await this.#splice(videoPath, pieces, outPath, format, signal);
    }
    else {
      this.log('debug',
        `Splicing ${pieces.length} pieces in ` +
        `${Math.ceil(pieces.length / MAX_PIECES_PER_GRAPH)} batches`
      );
      const parts: string[] = [];
      try {
        for (let from = 0; from < pieces.length; from += MAX_PIECES_PER_GRAPH) {
          const part = `${outPath}.part${parts.length}${PCM_PART_FORMAT.ext}`;
          parts.push(part);
          await this.#splice(
            videoPath,
            pieces.slice(from, from + MAX_PIECES_PER_GRAPH),
            part,
            PCM_PART_FORMAT,
            signal
          );
        }
        await this.#joinParts(parts, outPath, format, signal);
      }
      finally {
        for (const part of parts) {
          fs.rmSync(part, { force: true });
        }
      }
    }
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      const first = pieces[0].start;
      const last = pieces[pieces.length - 1].end;
      throw Error(`ffmpeg produced no audio for ${first.toFixed(1)}s-${last.toFixed(1)}s`);
    }
  }

  /**
   * One ffmpeg pass: the given pieces, and nothing else, into `outPath`.
   */
  async #splice(
    videoPath: string,
    pieces: TimeRange[],
    outPath: string,
    format: AudioFormat,
    signal?: AbortSignal
  ) {
    // Written to a file rather than passed as an argument: a sparse hour can
    // run to hundreds of pieces, which is past the command-line length
    // Windows allows.
    const scriptPath = `${outPath}.filtergraph`;
    fs.writeFileSync(scriptPath, this.#spliceGraph(pieces), 'utf8');
    const args = [
      '-v', 'error',
      '-y',
      // No -ss to seek to the first piece: with the timeline shifted under
      // it, every offset in the graph would have to be corrected by however
      // much ffmpeg actually skipped, which is a packet boundary rather than
      // the number asked for. Decoding from the start costs seconds and is
      // exact.
      '-i', videoPath,
      '-vn',
      '-filter_complex_script', scriptPath,
      '-map', '[spliced]',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-c:a', format.codec,
      '-b:a', `${format.bitrateKbps}k`,
      outPath
    ];
    try {
      await this.#run(this.#ffmpegPath, args, signal);
    }
    finally {
      fs.rmSync(scriptPath, { force: true });
    }
  }

  /**
   * Encodes the batch files, joined end to end, into one clip.
   *
   * The batches already are the clip, sample for sample, so this pass
   * neither decodes the video again nor moves a boundary: it chains the
   * parts and compresses the result once.
   */
  #joinParts(parts: string[], outPath: string, format: AudioFormat, signal?: AbortSignal) {
    const args = [ '-v', 'error', '-y' ];
    for (const part of parts) {
      args.push('-i', part);
    }
    const links = parts.map((_, index) => `[${index}:a]`).join('');
    args.push(
      '-filter_complex', `${links}concat=n=${parts.length}:v=0:a=1[spliced]`,
      '-map', '[spliced]',
      '-c:a', format.codec,
      '-b:a', `${format.bitrateKbps}k`,
      outPath
    );
    return this.#run(this.#ffmpegPath, args, signal);
  }

  /**
   * The filtergraph that keeps `pieces` and drops the rest.
   *
   * `aselect` decides frame by frame, so the frames are cut down to the
   * grid first: whatever length they arrive at is the resolution every boundary
   * would otherwise be rounded to, and the rounding is what the caller's
   * timestamps drift by. On a 10 ms frame the offsets in `SPLICE_GRID`
   * multiples land exactly, so a clip's duration is the sum of its pieces
   * and stays that way however many pieces it has.
   *
   * The comparisons are made against the middle of a frame rather than its
   * edge, which is the same thing said in a way that does not depend on
   * `t` and the offset rounding to the same double.
   */
  #spliceGraph(pieces: TimeRange[]) {
    const edge = SPLICE_GRID / 2;
    const keep = pieces
      .map(({ start, end }) =>
        `between(t,${(snapToSpliceGrid(start) - edge).toFixed(3)},` +
        `${(snapToSpliceGrid(end) - edge).toFixed(3)})`)
      .join('+');
    return (
      `[0:a]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=mono,` +
      `asetnsamples=n=${Math.round(SPLICE_GRID * SAMPLE_RATE)}:p=0,` +
      `aselect=expr='${keep}',` +
      // The kept frames still carry the timestamps they had in the source, so
      // without this the file plays as one piece with long gaps in it.
      `asetpts=N/SR/TB[spliced]`
    );
  }

  #run(command: string, args: string[], signal?: AbortSignal) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { stdio: [ 'ignore', 'pipe', 'pipe' ] });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const abort = () => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(Error('Aborted'));
        }
      };
      signal?.addEventListener('abort', abort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener('abort', abort);
          reject(error);
        }
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (code === 0) {
          resolve(stdout);
        }
        else {
          reject(Error(`${path.basename(command)} exited with ${code}: ${stderr.trim()}`));
        }
      });
    });
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }
}
