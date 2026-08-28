import express from 'express';
import path from 'path';
import fs from 'fs';
import DB, { type DBInstance } from '../db/index.js';
import { type Server } from 'http';
import getPort from 'get-port';
import { type Logger } from '../../utils/logging/index.js';
import { getRouter } from './Router.js';
import API from '../api/index.js';
import AuthStore from './AuthStore.js';
import HistoryStore from './HistoryStore.js';
import QuotaStore from './QuotaStore.js';
import LoginLogStore from './LoginLogStore.js';
import { type TranscriptionConfig } from './transcription/Config.js';
import { type TranslationConfig } from './translation/Config.js';

export const DEFAULT_WEB_SERVER_PORT = 3000;

/**
 * How many reverse proxies to believe about who the client is.
 *
 * One by default, because that is how this is nearly always run - a proxy
 * terminating the domain and forwarding to this port. With it, `req.ip` is the
 * address at the far end rather than the proxy's own, which is the difference
 * between a sign-in log worth reading and a column of `127.0.0.1`.
 *
 * Set it to `0` when nothing sits in front, so that a forged
 * `X-Forwarded-For` on a request straight to the port cannot write a fictional
 * address into the log.
 */
export const DEFAULT_TRUST_PROXY_HOPS = 1;

export interface WebServerConfig {
  dataDir?: string;
  port?: number | null;
  /**
   * Path to the FFmpeg executable. Used to generate poster frames for videos
   * that have no downloaded thumbnail, and to prepare audio for transcription.
   * Falls back to FFmpeg on PATH.
   */
  pathToFFmpeg?: string | null;
  /**
   * Subtitle generation. Left out, the feature stays off and only subtitles
   * already sitting beside a video are served.
   */
  transcription?: TranscriptionConfig | null;
  /**
   * How many reverse proxies sit in front of this server, or an Express
   * `trust proxy` setting of any other form. Defaults to
   * `DEFAULT_TRUST_PROXY_HOPS`; use `0` when the port is reached directly.
   */
  trustProxy?: number | boolean | string | null;
  /**
   * AI translation of what transcription produces. Left out, the feature stays
   * off and transcription is unaffected.
   */
  translation?: TranslationConfig | null;
  logger?: Logger | null;
}

export class WebServer {
  name = 'WebServer';

  #config: WebServerConfig;
  #app: express.Express;
  #server: Server | null;
  #status: 'stopped' | 'started';
  #port: number | null;

  #db: DBInstance | null;

  constructor(config: WebServerConfig) {
    this.#config = config;
    this.#app = express();
    this.#server = null;
    this.#status = 'stopped';
    this.#port = config.port || null;
    this.#db = null;
  }

  async start() {
    if (this.#status === 'started') {
      return;
    }

    const dataDir = this.#config.dataDir || process.cwd();
    if (!fs.existsSync(dataDir)) {
      throw Error(`Data directory "${this.#config.dataDir}" does not exist`);
    }
    if (!fs.statSync(dataDir).isDirectory()) {
      throw Error(`"${this.#config.dataDir}" is not a directory`);
    }

    const dbFile = path.resolve(dataDir, '.patreon-dl', 'db.sqlite');
    if (!fs.existsSync(dbFile)) {
      throw Error(`DB file "${dbFile}" does not exist`);
    }
    const db = await DB.getInstance(dbFile, false, this.#config.logger);
    const api = API.getInstance(db, this.#config.logger);
    // Accounts live beside the content DB but in a file of their own - see
    // `AuthStore` for why they are not in it.
    const authStore = AuthStore.load(
      path.resolve(dataDir, '.patreon-dl', 'auth.json'),
      this.#config.logger
    );
    // What each account has watched. Its own file again, and for the opposite
    // reason to the accounts': it is rewritten constantly and losing it costs
    // nothing worse than a video starting from the beginning.
    const historyStore = HistoryStore.load(
      path.resolve(dataDir, '.patreon-dl', 'history.json'),
      this.#config.logger
    );
    // How much each account has read today. Its own file for the same reason
    // the history is: worthless once the day turns over at 08:00 Beijing time,
    // so one that cannot be read is started over rather than fatal.
    const quotaStore = QuotaStore.load(
      path.resolve(dataDir, '.patreon-dl', 'quota.json'),
      this.#config.logger
    );
    // Who signed in and from where. Its own file again, and kept even when an
    // account is deleted - see `LoginLogStore` for why.
    const loginLogStore = LoginLogStore.load(
      path.resolve(dataDir, '.patreon-dl', 'login-log.json'),
      this.#config.logger
    );
    const router = getRouter(
      db, api, dataDir, authStore, historyStore, quotaStore, loginLogStore,
      this.#config.pathToFFmpeg,
      this.#config.transcription,
      this.#config.logger,
      this.#config.translation
    );

    // Before anything reads `req.ip`: without this, every request behind a
    // reverse proxy appears to come from the proxy.
    this.#app.set(
      'trust proxy',
      this.#config.trustProxy ?? DEFAULT_TRUST_PROXY_HOPS
    );
    this.#app.use(express.json());
    this.#app.use(express.urlencoded({ extended: true }));
    this.#app.use('/assets', express.static(path.resolve(import.meta.dirname, '../web/assets')));
    this.#app.use('/themes', express.static(path.resolve(import.meta.dirname, '../web/themes')));
    this.#app.use('/images', express.static(path.resolve(import.meta.dirname, '../web/images')));
    this.#app.use(router);

    this.#db = db;
    this.#port = await this.#getPort();

    return new Promise<void>((resolve, reject) => {
      this.#server = this.#app.listen(this.#port, (error) => {
        if (error) {
          reject(error);
          return;
        }
        this.#status = 'started';
        resolve();
      });
    });
  }

  stop() {
    if (this.#status === 'stopped') {
      return;
    }
    return new Promise<void>((resolve, reject) => {
      if (this.#server) {
        this.#server.close((error) => {
          if (error) {
            return reject(error);;
          }
          this.#server = null;
          this.#port = null;
          this.#status = 'stopped';
          if (this.#db) {
            try {
              this.#db.close();
            }
            catch (error) {
              return reject(error instanceof Error ? error : Error(String(error)));
            }
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  #getPort() {
    if (typeof this.#config.port === 'number') {
      return this.#config.port;
    }
    return getPort({ port: DEFAULT_WEB_SERVER_PORT });
  }

  getConfig(): WebServerConfig {
    return {
      ...this.#config,
      port: this.#port
    };
  }
}
