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
import HistoryAPIRequestHandler from './handler/HistoryAPIRequestHandler.js';
import type HistoryStore from './HistoryStore.js';
import { createTranscriptionServices, type TranscriptionConfig } from './transcription/Config.js';
import TranslationAPIRequestHandler from './handler/TranslationAPIRequestHandler.js';
import { createTranslationServices, type TranslationConfig } from './translation/Config.js';
import {
  byCampaignParam,
  byCollectionParam,
  byContentParam,
  byMediaParam,
  requireCampaignAccess
} from './CampaignAccessGuard.js';

interface RequestHandlers {
  campaignAPI: CampaignAPIRequestHandler;
  contentAPI: ContentAPIRequestHandler;
  media: MediaRequestHandler;
  settingsAPI: SettingsAPIRequestHandler;
  mediaAPI: MediaAPIRequestHandler;
  auth: AuthAPIRequestHandler;
  transcription: TranscriptionAPIRequestHandler;
  translation: TranslationAPIRequestHandler;
  history: HistoryAPIRequestHandler;
}

class _Router {
  #handlers: RequestHandlers;
  #authStore: AuthStore;
  #db: DBInstance;
  #router: Router;

  constructor(handlers: RequestHandlers, authStore: AuthStore, db: DBInstance) {
    this.#handlers = handlers;
    this.#authStore = authStore;
    this.#db = db;
    this.#router = express.Router();
    this.initializeRoutes();
  }

  initializeRoutes() {
    // Resolve the session once, up front, so everything downstream - the
    // campaign permissions included - can simply read `req.authUser`.
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

    // A user restricted to certain creators is refused everything belonging to
    // the others, whichever way the route names it. The campaign listing is
    // narrowed by its handler instead, in SQL, so that its paging counts only
    // what the user may see.
    const inScope = (resolve: Parameters<typeof requireCampaignAccess>[1]) =>
      requireCampaignAccess(this.#db, resolve);

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

    // Watch history. Recording is guarded the same way the content itself is,
    // so an account cannot build up - or read back - entries for a creator it
    // was never allowed to see.
    this.#router.get('/api/history/videos', (req, res) =>
      this.#handlers.history.handleListVideosRequest(req, res)
    );

    this.#router.get('/api/history/posts', (req, res) =>
      this.#handlers.history.handleListPostsRequest(req, res)
    );

    this.#router.get('/api/history/videos/:id', inScope(byMediaParam), (req, res) =>
      this.#handlers.history.handleGetVideoRequest(req, res, req.params.id)
    );

    this.#router.put('/api/history/videos/:id', inScope(byMediaParam), (req, res) =>
      this.#handlers.history.handleRecordVideoRequest(req, res, req.params.id)
    );

    this.#router.put('/api/history/posts/:id', inScope(byContentParam('post')), (req, res) =>
      this.#handlers.history.handleRecordPostRequest(req, res, req.params.id)
    );

    // Favorites: a saved-post list the user builds by hand. Guarded the same
    // way as the viewed-post history, so an account cannot save - or read
    // back - a post for a creator it was never allowed to see.
    this.#router.get('/api/history/favorites', (req, res) =>
      this.#handlers.history.handleListFavoritesRequest(req, res)
    );

    this.#router.get('/api/history/favorites/:id', inScope(byContentParam('post')), (req, res) =>
      this.#handlers.history.handleGetFavoriteRequest(req, res, req.params.id)
    );

    this.#router.put('/api/history/favorites/:id', inScope(byContentParam('post')), (req, res) =>
      this.#handlers.history.handleAddFavoriteRequest(req, res, req.params.id)
    );

    this.#router.delete('/api/history/favorites/:id', inScope(byContentParam('post')), (req, res) =>
      this.#handlers.history.handleRemoveFavoriteRequest(req, res, req.params.id)
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

    this.#router.get('/api/media/:id/transcription', inScope(byMediaParam), (req, res) =>
      this.#handlers.transcription.handleJobRequest(req, res, req.params.id)
    );

    this.#router.get('/api/media/:id/subtitles', inScope(byMediaParam), (req, res) =>
      this.#handlers.transcription.handleSubtitleListRequest(req, res, req.params.id)
    );

    this.#router.get('/api/media/:id/subtitles/:filename', inScope(byMediaParam), (req, res) =>
      this.#handlers.transcription.handleSubtitleRequest(req, res, req.params.id, req.params.filename)
    );

    // Translation is an administrator's job for the same reasons transcription
    // is: it spends a metered API and writes into the library. What comes out
    // is served by the subtitle endpoints above, to anyone whose player asks.
    this.#router.post('/api/media/:id/translate', requireAdmin, (req, res) =>
      this.#handlers.translation.handleTranslateRequest(req, res, req.params.id)
    );

    this.#router.delete('/api/media/:id/translate', requireAdmin, (req, res) =>
      this.#handlers.translation.handleCancelRequest(req, res, req.params.id)
    );

    // POST rather than DELETE: this stops work, it does not remove anything.
    this.#router.post('/api/translations/stop', requireAdmin, (req, res) =>
      this.#handlers.translation.handleCancelAllRequest(req, res)
    );

    this.#router.get('/api/translation/status', requireAdmin, (req, res) =>
      this.#handlers.translation.handleStatusRequest(req, res)
    );

    // The Gemini key is set and cleared here. Administrators only, and the key
    // itself is never in a response - see the handler.
    this.#router.get('/api/translation/settings', requireAdmin, (req, res) =>
      this.#handlers.translation.handleGetSettingsRequest(req, res)
    );

    this.#router.put('/api/translation/settings', requireAdmin, (req, res) =>
      this.#handlers.translation.handleSaveSettingsRequest(req, res)
    );

    this.#router.delete('/api/translation/cache', requireAdmin, (req, res) =>
      this.#handlers.translation.handleClearCacheRequest(req, res)
    );

    this.#router.post('/api/translation/requests/reset', requireAdmin, (req, res) =>
      this.#handlers.translation.handleResetRequestCountRequest(req, res)
    );

    this.#router.get([
      '/api/campaigns/:id/posts/filter_options',
      '/api/campaigns/:id/products/filter_options',
      '/api/campaigns/:id/media/filter_options'
    ], inScope(byCampaignParam), (req, res) => {
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
    ], inScope(byCampaignParam), (req, res) => {
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

    this.#router.get('/api/collections/:id', inScope(byCollectionParam), (req, res) => {
      return this.#handlers.contentAPI.handleCollectionRequest(req, res, req.params.id);
    });

    this.#router.get('/api/campaigns/:id', (req, res) =>
      this.#handlers.campaignAPI.handleGetRequest(req, res, req.params.id)
    );

    this.#router.get('/api/campaigns', (req, res) =>
      this.#handlers.campaignAPI.handleListRequest(req, res)
    );

    this.#router.get('/api/posts/:id', inScope(byContentParam('post')), (req, res) =>
      this.#handlers.contentAPI.handleGetRequest(req, res, 'post', req.params.id)
    );

    this.#router.get('/api/products/:id', inScope(byContentParam('product')), (req, res) =>
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

    // The media route answers in plain text, so it refuses an out-of-scope file
    // the same way it already refuses one that genuinely is not there.
    const mediaInScope = requireCampaignAccess(
      this.#db,
      byMediaParam,
      (res) => { res.status(404).send('Media not found'); }
    );

    this.#router.get('/media/:id', mediaInScope, (req, res) => {
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
  historyStore: HistoryStore,
  pathToFFmpeg?: string | null,
  transcriptionConfig?: TranscriptionConfig | null,
  logger?: Logger | null,
  translationConfig?: TranslationConfig | null
) {
  const videoThumbnailer = new VideoThumbnailer(dataDir, pathToFFmpeg, logger);
  const transcription = createTranscriptionServices(dataDir, transcriptionConfig, pathToFFmpeg, logger);
  // After transcription, and given its index and queue: a translation reads
  // the subtitle a transcription wrote, and follows one when asked to.
  const translation = createTranslationServices(
    dataDir, transcription.index, transcription.queue, translationConfig, logger
  );
  return new _Router({
    campaignAPI: new CampaignAPIRequestHandler(api, logger),
    contentAPI: new ContentAPIRequestHandler(api, logger),
    media: new MediaRequestHandler(db, dataDir, videoThumbnailer, logger),
    settingsAPI: new SettingsAPIRequestHandler(api, logger),
    mediaAPI: new MediaAPIRequestHandler(api, dataDir, logger),
    auth: new AuthAPIRequestHandler(authStore, historyStore, logger),
    history: new HistoryAPIRequestHandler(db, historyStore, logger),
    transcription: new TranscriptionAPIRequestHandler(
      db, dataDir,
      transcription.index, transcription.queue, transcription.vad, transcription.settings,
      logger
    ),
    translation: new TranslationAPIRequestHandler(
      transcription.index, translation.queue, translation.settings, translation.cache,
      logger
    )
  }, authStore, db).router;
}
