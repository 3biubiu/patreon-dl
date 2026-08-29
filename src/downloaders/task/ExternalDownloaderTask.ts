import { type ChildProcess } from 'child_process';
import { type PostEmbed } from '../../entities/Post.js';
import { type Downloadable } from '../../entities/Downloadable.js';
import Formatter, { type FormatFieldValues } from '../../utils/Formatter.js';
import URLHelper from '../../utils/URLHelper.js';
import {type LogLevel} from '../../utils/logging/Logger.js';
import type Logger from '../../utils/logging/Logger.js';
import { type EmbedDownloader } from '../DownloaderOptions.js';
import DownloadTask, { type DownloadTaskCallbacks, type DownloadTaskParams } from './DownloadTask.js';
import spawn from '@patrickkfkan/cross-spawn';
import split from 'argv-split'; // Switched from 'string-argv' which does not split nested quotes properly
import { type DownloaderConfig } from '../Downloader.js';
import fs from 'fs';
import { fileTypeFromFile } from 'file-type';
import path from 'path';

export interface ExternalDownloaderTaskParams extends DownloadTaskParams {
  name: string;
  destDir: string;
  exec: {
    command: string;
    args: string[];
  };
  /**
   * Basename, without extension, that the command was asked to write.
   *
   * Only a hint - the command owns the filename and may sanitise it differently
   * - but where it holds it makes attribution exact instead of "whichever video
   * in this directory was touched last".
   */
  expectFilename?: string | null;
}

/**
 * Turns a configured `exec` line into a command plus argv.
 *
 * Tokenising happens before interpolation, which is what lets a placeholder
 * expand to a path containing spaces without any quoting: the token is already
 * one argv element by the time `{dest.dir}` becomes
 * "/vol00/WDC WD10SPCX-24HWST1/...", and nothing re-splits it afterwards.
 */
function buildExecCommand(
  exec: string,
  dict: FormatFieldValues<string>,
  log: (level: LogLevel, ...message: any[]) => void
) {
  const args = split(exec);
  const command = args.shift();
  if (!command) {
    log('warn', 'Could not create task: no command specified');
    return null;
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const interpolated = Formatter.format(arg, dict).result.trim();
    if (!interpolated && arg !== '{cookie}') {
      log('warn', `Could not create task: got empty string for command arg '${arg}'`);
      return null;
    }
    args[i] = interpolated;
  }
  return { command, args };
}

export default class ExternalDownloaderTask extends DownloadTask {

  protected name: string;

  #destDir: string;
  #expectFilename: string | null;
  #exec: ExternalDownloaderTaskParams['exec'];
  #proc: ChildProcess | null;
  #abortController: AbortController | null;
  #abortingCallback: (() => void) | null;

  constructor(params: ExternalDownloaderTaskParams) {
    super(params);
    this.#destDir = params.destDir;
    this.#expectFilename = params.expectFilename || null;
    this.#exec = params.exec;
    this.#abortController = null;
    this.#abortingCallback = null;
    this.#proc = null;
    this.name = params.name;
  }

  protected resolveDestPath() {
    return Promise.resolve('(not applicable)');
  }  

  protected doStart() {
    return new Promise<void>((resolve) => {

      if (this.status === 'aborted') {
        resolve();
        return;
      }

      try {
        this.#abortController = new AbortController();
        const commandStr = this.#getCommandString();

        if (this.dryRun) {
          this.notifyStart();
          this.log('debug', `(dry-run) -> Skip command "${commandStr}"`);
          this.notifyComplete();
          resolve();
          return;
        }

        this.log('debug', `Going to execute "${commandStr}"`);
        const proc = spawn(this.#exec.command, this.#exec.args);
        this.log('debug', `[pid: ${proc.pid}] Exec "${commandStr}"`);
        let resolved = false;
        let lastErrMsg: string | null = null;

        proc.stdout?.on('data', (data) => {
          this.log('debug', `[pid ${proc.pid}] stdout:`, data.toString());
        });

        proc.stderr?.on('data', (data) => {
          this.log('warn', `[pid ${proc.pid}] stderr:`, data.toString());
          lastErrMsg = data;
        });

        proc.on('error', (err) => {
          resolved = true;
          if (this.#abortingCallback) {
            this.#abortingCallback();
            return;
          }
          this.notifyError(err);
          resolve();
        });

        proc.on('exit', (code, signal) => {
          if (resolved) {
            return;
          }
          resolved = true;
          if (this.#abortingCallback) {
            this.log('debug', `[pid: ${proc.pid}] Process exit due to abort`);
            this.#abortingCallback();
            return;
          }
          const signalStr = signal !== null ? `; signal: ${signal}` : '';
          this.log('debug', `[pid: ${proc.pid}] Process exit (code: ${code}${signalStr})`);
          if (code === 0) {
            void this.#findAndSetDownloaded().then(() => {
              this.notifyComplete();
              resolve();
            });
            return;
          }
          else {
            const e = lastErrMsg ? `. Last captured error message: ${lastErrMsg}` : '';
            this.notifyError(`Process failed with exit code ${code} (pid: ${proc.pid})${e}`);
          }
          resolve();
        });

        this.#proc = proc;
        this.notifyStart();

        this.#abortController.signal.onabort = () => {
          if (proc.pid) {
            proc.kill('SIGKILL');
          }
          else if (this.#abortingCallback) {
            this.#abortingCallback();
            resolve();
          }
        };
      }
      catch (error: any) {
        if (this.#abortingCallback) {
          this.#abortingCallback();
          return;
        }
        this.notifyError(error);
        resolve();
      }
    })
      .finally(() => {
        if (this.#proc) {
          this.#proc.removeAllListeners();
          this.#proc.stdout?.removeAllListeners();
          this.#proc.stderr?.removeAllListeners();
          this.#proc = null;
        }
        this.#abortController = null;
      });
  }

  protected async doAbort() {
    return new Promise<void>((resolve) => {
      if (this.#abortController) {
        this.#abortingCallback = () => {
          this.#abortingCallback = null;
          this.notifyAbort();
          resolve();
        };
        this.#abortController.abort();
      }
      else {
        resolve();
      }
    });
  }

  protected async doDestroy() {
    this.#proc?.removeAllListeners();
    this.#proc = null;
    return Promise.resolve();
  }

  protected doGetProgress() {
    return undefined;
  }

  #getCommandString() {
    const quotedArgs = this.#exec.args.map((arg) => {
      const _arg = arg.trim();
      if (_arg.startsWith('"') && _arg.endsWith('"')) {
        return _arg;
      }
      if (_arg.includes('=') && _arg.startsWith('-')) {
        const equalPosition = _arg.indexOf('=');
        const argKey = _arg.substring(0, equalPosition);
        let argValue = _arg.substring(equalPosition);
        if (argValue.includes(' ')) {
          argValue = `"${argValue}"`;
        }
        return `${argKey}=${argValue}`;
      }
      if (_arg.includes(' ')) {
        return `"${_arg}"`;
      }
      return _arg;
    });
    return [
      this.#exec.command,
      ...quotedArgs
    ].join(' ');
  }

  async #findAndSetDownloaded() {
    if (!fs.existsSync(this.#destDir)) {
      return null;
    }
    try {
      this.log('debug', `Find video files in "${this.#destDir}"`);
      const files = fs.readdirSync(this.#destDir)
        .reduce<{ path: string; modified: number; }[]>((result, file) => {
          const filePath = path.resolve(this.#destDir, file);
          const stats = fs.statSync(filePath);
          if (stats.isFile()) {
            result.push({
              path: filePath,
              modified: stats.mtime.getTime()
            });
          }
          return result;
        }, [])
        .sort((f1, f2) => f2.modified - f1.modified);

      // Spawned tasks are started without going through the batch limiter, so
      // several of them can be writing into this same directory at once. When
      // that happens "the most recently modified video" is not reliably this
      // task's own file - it can be a sibling's, or a sibling's part file,
      // which is still a readable video header. Matching the name we asked for
      // takes that race out of it.
      if (this.#expectFilename) {
        const named = files.filter((f) => path.parse(f.path).name === this.#expectFilename);
        for (const file of named) {
          const fileType = await fileTypeFromFile(file.path);
          if (fileType?.mime.startsWith('video/')) {
            this.log('debug', `Found video file "${file.path}" by expected name`);
            await this.setDownloaded(file.path);
            return;
          }
        }
        this.log('debug',
          `No video file named "${this.#expectFilename}" in "${this.#destDir}" - ` +
          'falling back to the most recently modified one'
        );
      }

      for (const file of files) {
        const filePath = file.path;
        const fileType = await fileTypeFromFile(filePath);
        if (fileType?.mime.startsWith('video/')) {
          this.log('debug', `Found video file "${filePath}"`);
          await this.setDownloaded(filePath);
          return;
        }
      }
      this.log('debug', `No video file found in "${this.#destDir}"`);
    }
    catch (error) {
      this.log('warn', `Error finding files in "${this.#destDir}":`, error);
    }
  }

  static fromEmbedDownloader(
    config: DownloaderConfig<any>,
    dl: EmbedDownloader,
    embed: PostEmbed,
    destDir: string,
    callbacks: DownloadTaskCallbacks | null,
    logger: Logger | null | undefined
  ) {
    if (!embed.url) {
      return null;
    }
    const originator = `embed.downloader.${embed.provider}`;
    const __log = (level: LogLevel, ...message: any[]) => {
      logger?.log({
        level,
        originator,
        message
      });
    };
    if (!URLHelper.validateURL(embed.url)) {
      __log('warn', `Could not create task: invalid URL "${embed.url}"`);
      return null;
    }
    const dict = {
      'post.id': embed.postId,
      'post.url': embed.postURL,
      'embed.provider': embed.provider,
      'embed.provider.url': embed.providerURL,
      'embed.url': embed.url,
      'embed.subject': embed.subject,
      'embed.html': embed.html,
      'cookie': config.cookie || '',
      'dest.dir': destDir
    };

    const exec = buildExecCommand(dl.exec, dict, __log);
    if (!exec) {
      return null;
    }

    return new ExternalDownloaderTask({
      downloadType: 'main',
      name: originator,
      destDir,
      exec,
      config,
      callbacks,
      logger,
      src: embed.url,
      srcEntity: embed
    });
  }

  /**
   * The same mechanism as `fromEmbedDownloader`, but for a video Patreon hosts
   * itself rather than one embedded from elsewhere.
   *
   * Those arrive as an HLS playlist, which `M3U8DownloadTask` hands to FFmpeg -
   * and FFmpeg fetches the segments strictly one after another. A downloader
   * that fetches them concurrently is far quicker over a high-latency or
   * proxied link, which is the reason this hook exists at all.
   *
   * What is handed over is the playlist URL, already signed, so the command
   * needs no cookie to fetch it. `{cookie}` is offered regardless, for parity
   * with the embed downloaders and for commands that resolve the post instead.
   *
   * Note that taking this path gives up what `M3U8DownloadTask` does with the
   * manifest - `maxVideoResolution`, the protected-stream check, and the
   * "(1920x1080)" / "drm" filename suffixes. The external command owns format
   * selection now.
   */
  static fromVideoDownloader(
    config: DownloaderConfig<any>,
    execLine: string,
    params: {
      src: string;
      srcEntity: Downloadable;
      destDir: string;
      destFilename: string;
      callbacks: DownloadTaskCallbacks | null;
      logger?: Logger | null;
    }
  ) {
    const { src, srcEntity, destDir, destFilename, callbacks, logger } = params;
    const originator = 'downloader.video';
    const __log = (level: LogLevel, ...message: any[]) => {
      logger?.log({
        level,
        originator,
        message
      });
    };
    if (!URLHelper.validateURL(src)) {
      __log('warn', `Could not create task: invalid URL "${src}"`);
      return null;
    }
    const dict = {
      'dest.dir': destDir,
      // Without an extension: the command decides the container, and a
      // template ending in ".mp4.mp4" is the obvious way to get that wrong.
      'dest.filename': destFilename,
      'media.id': srcEntity.id,
      'media.url': src,
      'cookie': config.cookie || ''
    };

    const exec = buildExecCommand(execLine, dict, __log);
    if (!exec) {
      return null;
    }

    return new ExternalDownloaderTask({
      downloadType: 'main',
      name: originator,
      destDir,
      expectFilename: destFilename,
      exec,
      config,
      callbacks,
      logger,
      src,
      srcEntity
    });
  }
}
