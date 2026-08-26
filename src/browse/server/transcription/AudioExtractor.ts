import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { commonLog, type LogLevel } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';

/** Silero is trained at this rate; feeding it anything else degrades it. */
export const SAMPLE_RATE = 16000;

/**
 * The two ffmpeg passes transcription needs: raw PCM for the voice detector,
 * and compressed clips for upload.
 *
 * `child_process` rather than fluent-ffmpeg, which the poster frames use: the
 * detector wants PCM off stdout a frame at a time, and buffering a whole film
 * to hand it over in one piece would cost a couple of hundred megabytes.
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
   * Writes `[start, start + duration)` to `outPath` as mono 16 kHz Opus.
   *
   * Opus at this bitrate is about 11 MB per hour, which keeps a chunk well
   * inside the 25 MB the transcription endpoint accepts while staying far
   * above what Whisper actually needs - it resamples to 16 kHz regardless.
   */
  async extractClip(
    videoPath: string,
    start: number,
    duration: number,
    outPath: string,
    bitrateKbps = 24,
    signal?: AbortSignal
  ) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const args = [
      '-v', 'error',
      '-y',
      // Before -i, so ffmpeg seeks instead of decoding up to the start point.
      '-ss', start.toFixed(3),
      '-t', duration.toFixed(3),
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-c:a', 'libopus',
      '-b:a', `${bitrateKbps}k`,
      outPath
    ];
    await this.#run(this.#ffmpegPath, args, signal);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      throw Error(`ffmpeg produced no audio for ${start.toFixed(1)}s-${(start + duration).toFixed(1)}s`);
    }
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
