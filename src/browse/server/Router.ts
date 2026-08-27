import express, { type RequestHandler, type Router } from 'express';
import path from 'path';
import CampaignAPIRequestHandler from './handler/CampaignAPIRequesthandler.js';
import { type DBInstance } from '../db/index.js';
import { type Logger } from '../../utils/logging/index.js';
import { type APIInstance } from '../api/index.js';
import ContentAPIRequestHandler from './handler/ContentAPIRequestHandler.js';
import MediaRequestHandler from './handler/MediaRequestHandler.js';
import SettingsAPIRequestHandler from './handler/SettingsAPIRequestHandler.js';
import MediaAPIRequestHandler from './handler/MediaAPIRequestHandler.js';
import VideoThumbnailer from './VideoThumbnailer.js';
import { checkMediaAccess } from './MediaAccessGuard.js';
import AuthAPIRequestHandler from './handler/AuthAPIRequestHandler.js';
import type AuthStore from './AuthStore.js';
import { getSessionUser, refreshSessionIfStale, type AuthenticatedRequest } from './AuthGuard.js';
import TranscriptionAPIRequestHandler from './handler/TranscriptionAPIRequestHandler.js';
import { createTranscriptionServices, type TranscriptionConfig } from './transcription/Config.js';

interface RequestHandlers {
  campaignAPI: CampaignAPIRequestHandler;
  contentAPI: ContentAPIRequestHandler;
  media: MediaRequestHandler;
  settingsAPI: SettingsAPIRequestHandler;
  mediaAPI: MediaAPIRequestHandler;
  auth: AuthAPIRequestHandler;
  transcription: TranscriptionAPIRequestHandler;
}

class _Router {
  #handlers: RequestHandlers;
  #authStore: AuthStore;
  #router: Router;

  constructor(handlers: RequestHandlers, authStore: AuthStore) {
    this.#handlers = handlers;
    this.#authStore = authStore;
    this.#router = express.Router();
    this.initializeRoutes();
  }

  initializeRoutes() {
    // Resolve the session once, up front, so everything downstream - including
    // the content permissions that will come later - can simply read
    // `req.authUser`.
    this.#router.use((req, res, next) => {
      const user = getSessionUser(req, this.#authStore);
      if (user) {
        (req as AuthenticatedRequest).authUser = user;
        refreshSessionIfStale(req, res, this.#authStore, user);
      }
      next();
    });

    // Reachable while signed out - otherwise there would be no way in.
    this.#router.post('/api/auth/login', (req, res) =>
      this.#handlers.auth.handleLoginRequest(req, res)
    );

    this.#router.post('/api/auth/logout', (req, res) =>
      this.#handlers.auth.handleLogoutRequest(req, res)
    );

    this.#router.get('/api/auth/me', (req, res) =>
      this.#handlers.auth.handleSessionRequest(req, res)
    );

    // Everything that serves data sits behind the sign-in. The catch-all that
    // serves index.html deliberately does not, so the login page can load.
    this.#router.use((req, res, next) => {
      const isProtected = req.path.startsWith('/api/') || req.path.startsWith('/media/');
      if (isProtected && !(req as AuthenticatedRequest).authUser) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });

    const requireAdmin: RequestHandler = (req, res, next) => {
      if ((req as AuthenticatedRequest).authUser?.role !== 'admin') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      next();
    };

    this.#router.get('/api/auth/users', requireAdmin, (req, res) =>
      this.#handlers.auth.handleListUsersRequest(req, res)
    );

    this.#router.post('/api/auth/users', requireAdmin, (req, res) =>
      this.#handlers.auth.handleCreateUserRequest(req, res)
    );

    this.#router.patch('/api/auth/users/:id', requireAdmin, (req, res) =>
      this.#handlers.auth.handleUpdateUserRequest(req, res, req.params.id)
    );

    this.#router.delete('/api/auth/users/:id', requireAdmin, (req, res) =>
      this.#handlers.auth.handleDeleteUserRequest(req, res, req.params.id)
    );

    // Making captions is an administrator's job; reading them is not, so an
    // ordinary viewer's player can still list and load what is already there.
    this.#router.post('/api/media/:id/transcribe', requireAdmin, (req, res) =>
      this.#handlers.transcription.handleTranscribeRequest(req, res, req.params.id)
    );

    this.#router.delete('/api/media/:id/transcribe', requireAdmin, (req, res) =>
      this.#handlers.transcription.handleCancelRequest(req, res, req.params.id)
    );

    this.#router.get('/api/transcriptions', requireAdmin, (req, res) =>
      this.#handlers.transcription.handleListJobsRequest(req, res)
    );

    // POST rather than DELETE: this stops work, it does not remove anything.
    this.#router.post('/api/transcriptions/stop', requireAdmin, (req, res) =>
      this.#handlers.transcription.handleCancelAllRequest(req, res)
    );

    this.#router.delete('/api/transcriptions', requireAdmin, (req, res) =>
      this.#handlers.transcription.handleClearHistoryRequest(req, res)
    );

    this.#router.delete('/api/transcriptions/:id', requireAdmin, (req, res) =>
      this.#handlers.transcription.handleForgetRequest(req, res, req.params.id)
    );

    this.#router.get('/api/transcription/status', (req, res) =>
      this.#handlers.transcription.handleStatusRequest(req, res)
    );

    // The API key is set and cleared here. Administrators only, and the key
    // itself is never in a response - see the handler.
    this.#router.get('/api/transcription/settings', requireAdmin, (req, res) =>
      this.#handlers.transcription.handleGetSettingsRequest(req, res)
    );

    this.#router.put('/api/transcription/settings', requireAdmin, (req, res) =>
      this.#handlers.transcription.handleSaveSettingsRequest(req, res)
    );

    this.#router.get('/api/media/:id/transcription', (req, res) =>
      this.#handlers.transcription.handleJobRequest(req, res, req.params.id)
    );

    this.#router.get('/api/media/:id/subtitles', (req, res) =>
      this.#handlers.transcription.handleSubtitleListRequest(req, res, req.params.id)
    );

    this.#router.get('/api/media/:id/subtitles/:filename', (req, res) =>
      this.#handlers.transcription.handleSubtitleRequest(req, res, req.params.id, req.params.filename)
    );

    this.#router.get([
      '/api/campaigns/:id/posts/filter_options',
      '/api/campaigns/:id/products/filter_options',
      '/api/campaigns/:id/media/filter_options'
    ], (req, res) => {
      const paramContentType = req.path.split('/')[4];
      const contentType =
        paramContentType === 'posts' ? 'post'
        : paramContentType === 'products' ? 'product'
        : 'media';
      switch (contentType) {
        case 'media':
          return this.#handlers.mediaAPI.handleFilterOptionsRequest(req, res, req.params.id);
        default:
          return this.#handlers.contentAPI.handleFilterOptionsRequest(req, res, req.params.id, contentType)
      }
    });

    this.#router.get([
      '/api/campaigns/:id/posts',
      '/api/campaigns/:id/products',
      '/api/campaigns/:id/media',
      '/api/campaigns/:id/content',
      '/api/campaigns/:id/collections',
      '/api/campaigns/:id/post_tags'
    ], (req, res) => {
      const paramContentType = req.path.split('/')[4];
      const contentType =
        paramContentType === 'posts' ? 'post'
        : paramContentType === 'products' ? 'product'
        : paramContentType === 'media' ? 'media'
        : paramContentType === 'collections' ? 'collections'
        : paramContentType === 'post_tags' ? 'post_tags'
        : undefined;
      switch (contentType) {
        case 'media':
          return this.#handlers.mediaAPI.handleListRequest(req, res, req.params.id);
        case 'collections':
          return this.#handlers.contentAPI.handleCollectionListRequest(req, res, req.params.id);
        case 'post_tags':
          return this.#handlers.contentAPI.handlePostTagListRequest(req, res, req.params.id);
        default:
          return this.#handlers.contentAPI.handleListRequest(req, res, req.params.id, contentType)
      }
    });

    this.#router.get('/api/collections/:id', (req, res) => {
      return this.#handlers.contentAPI.handleCollectionRequest(req, res, req.params.id);
    });

    this.#router.get('/api/campaigns/:id', (req, res) =>
      this.#handlers.campaignAPI.handleGetRequest(req, res, req.params.id)
    );

    this.#router.get('/api/campaigns', (req, res) =>
      this.#handlers.campaignAPI.handleListRequest(req, res)
    );

    this.#router.get('/api/posts/:id', (req, res) =>
      this.#handlers.contentAPI.handleGetRequest(req, res, 'post', req.params.id)
    );

    this.#router.get('/api/products/:id', (req, res) =>
      this.#handlers.contentAPI.handleGetRequest(req, res, 'product', req.params.id)
    );

    this.#router.get('/api/settings/browse/options', (req, res) =>
      this.#handlers.settingsAPI.handleBrowseSettingOptionsRequest(req, res)
    );

    this.#router.get('/api/settings/browse', (req, res) =>
      this.#handlers.settingsAPI.handleGetBrowseSettingsRequest(req, res)
    );

    this.#router.post('/api/settings/browse', (req, res) =>
      this.#handlers.settingsAPI.handleSaveBrowseSettingsRequest(req, res)
    );

    this.#router.get('/media/:id', (req, res) => {
      const denied = checkMediaAccess(req);
      if (denied) {
        res.status(403).send('Forbidden');
        return;
      }
      return this.#handlers.media.handleMediaRequest(req, res, req.params.id);
    });

    this.#router.get(/(.*)/, (_req, res) => {
      res.sendFile(
        path.resolve(import.meta.dirname, '../web/index.html'),
        { dotfiles: 'allow' }
      )
    });
  }

  get router() {
    return this.#router;
  }
}

export function getRouter(
  db: DBInstance,
  api: APIInstance,
  dataDir: string,
  authStore: AuthStore,
  pathToFFmpeg?: string | null,
  transcriptionConfig?: TranscriptionConfig | null,
  logger?: Logger | null
) {
  const videoThumbnailer = new VideoThumbnailer(dataDir, pathToFFmpeg, logger);
  const transcription = createTranscriptionServices(dataDir, transcriptionConfig, pathToFFmpeg, logger);
  return new _Router({
    campaignAPI: new CampaignAPIRequestHandler(api, logger),
    contentAPI: new ContentAPIRequestHandler(api, logger),
    media: new MediaRequestHandler(db, dataDir, videoThumbnailer, logger),
    settingsAPI: new SettingsAPIRequestHandler(api, logger),
    mediaAPI: new MediaAPIRequestHandler(api, dataDir, logger),
    auth: new AuthAPIRequestHandler(authStore, logger),
    transcription: new TranscriptionAPIRequestHandler(
      db, dataDir,
      transcription.index, transcription.queue, transcription.vad, transcription.settings,
      logger
    )
  }, authStore).router;
}
