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
import AuthAPIRequestHandler from './handler/AuthAPIRequestHandler.js';
import type AuthStore from './AuthStore.js';
import {
  clearSession,
  getSessionUser,
  refreshSessionIfStale,
  type AuthenticatedRequest
} from './AuthGuard.js';
import LoginRegionGuard, { clientIP } from './LoginRegionGuard.js';
import { resolveDownloadTicket, type DownloadTicketRequest } from './DownloadTicket.js';
import PdfTranslationRequestHandler from './handler/PdfTranslationRequestHandler.js';
import { createPdfTranslationServices, type PdfTranslationConfig } from './pdf/Config.js';
import TranscriptionAPIRequestHandler from './handler/TranscriptionAPIRequestHandler.js';
import HistoryAPIRequestHandler from './handler/HistoryAPIRequestHandler.js';
import type HistoryStore from './HistoryStore.js';
import type QuotaStore from './QuotaStore.js';
import type LoginLogStore from './LoginLogStore.js';
import { requirePostQuota } from './QuotaGuard.js';
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
  pdfTranslation: PdfTranslationRequestHandler;
}

class _Router {
  #handlers: RequestHandlers;
  #authStore: AuthStore;
  #quotaStore: QuotaStore;
  #regionGuard: LoginRegionGuard;
  #db: DBInstance;
  #router: Router;

  constructor(
    handlers: RequestHandlers,
    authStore: AuthStore,
    quotaStore: QuotaStore,
    regionGuard: LoginRegionGuard,
    db: DBInstance
  ) {
    this.#handlers = handlers;
    this.#authStore = authStore;
    this.#quotaStore = quotaStore;
    this.#regionGuard = regionGuard;
    this.#db = db;
    this.#router = express.Router();
    this.initializeRoutes();
  }

  initializeRoutes() {
    // Resolve the session once, up front, so everything downstream - the
    // campaign permissions included - can simply read `req.authUser`.
    //
    // The region restriction is applied here rather than only at the sign-in
    // form, because a rule checked once at the door is not a rule: a cookie is
    // good for a week, so a session opened before the restriction was put on -
    // or carried somewhere it does not allow - would otherwise go on working
    // regardless of it.
    //
    // A session that fails the check is *signed out* rather than answered with
    // a 403 on every route. It costs nothing, since the cookie is worthless to
    // them now anyway, and it puts them at the login form, which is the one
    // place equipped to tell them why they cannot get in.
    this.#router.use((req, res, next) => {
      const user = getSessionUser(req, this.#authStore);
      if (!user) {
        next();
        return;
      }
      const admit = () => {
        (req as AuthenticatedRequest).authUser = user;
        refreshSessionIfStale(req, res, this.#authStore, user);
      };
      // Every unrestricted account and every administrator leaves here, having
      // cost this middleware a comparison. Only an account that is actually
      // pinned to somewhere goes on to the asynchronous path below, and even
      // then it is answered from the guard's memo after the first request.
      if (!this.#regionGuard.applies(user)) {
        admit();
        next();
        return;
      }
      this.#regionGuard.check(clientIP(req), user)
        .then((verdict) => {
          if (verdict.allowed) {
            admit();
            return;
          }
          this.#regionGuard.log('warn',
            `Signed out "${user.username}" mid-session - ${clientIP(req)} is ` +
            `${verdict.place || (verdict.unplaceable ? 'an address that could not be placed' : 'not an allowed region')}.`
          );
          clearSession(res);
        })
        .catch((error: unknown) => {
          // The guard answers rather than throws, so this is the check itself
          // having gone wrong. It is still not a reason to admit somebody.
          this.#regionGuard.log('error', 'Sign-in region check failed - signing the session out:', error);
          clearSession(res);
        })
        .finally(() => next());
    });

    // Reachable while signed out - otherwise there would be no way in.
    //
    // The only route here that is asynchronous: an account restricted to
    // certain regions cannot be answered until the server knows where the
    // request came from. Anything that escapes the handler is answered rather
    // than left to hang - a sign-in that never comes back is worse than one
    // that fails.
    this.#router.post('/api/auth/login', (req, res) => {
      this.#handlers.auth.handleLoginRequest(req, res).catch(() => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Could not sign in' });
        }
      });
    });

    // Reachable while signed out for the same reason the sign-in is: this is
    // the way to ask for an account when you have none. It creates an
    // application and nothing else - no account, no session.
    this.#router.post('/api/auth/register', (req, res) =>
      this.#handlers.auth.handleRegisterRequest(req, res)
    );

    this.#router.post('/api/auth/logout', (req, res) =>
      this.#handlers.auth.handleLogoutRequest(req, res)
    );

    this.#router.get('/api/auth/me', (req, res) =>
      this.#handlers.auth.handleSessionRequest(req, res)
    );

    // A download ticket, resolved before the sign-in gate because the client
    // it is meant for - a download manager the administrator handed the URL
    // to - has no session cookie to be let through on. See `DownloadTicket`.
    this.#router.use((req, _res, next) => {
      const userId = resolveDownloadTicket(req, this.#authStore.secret);
      if (userId) {
        (req as DownloadTicketRequest).downloadTicketUserId = userId;
      }
      next();
    });

    // Everything that serves data sits behind the sign-in. The catch-all that
    // serves index.html deliberately does not, so the login page can load.
    this.#router.use((req, res, next) => {
      const isProtected = req.path.startsWith('/api/') || req.path.startsWith('/media/');
      const admitted = (req as AuthenticatedRequest).authUser ||
        (req as DownloadTicketRequest).downloadTicketUserId;
      if (isProtected && !admitted) {
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

    // Where the signed-in account stands against its daily limits. Not an
    // administrator's route: it is the account's own standing, and the sidebar
    // asks for it on every page.
    this.#router.get('/api/quota', (req, res) =>
      this.#handlers.auth.handleQuotaRequest(req, res)
    );

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

    // The way back in for an account the sign-in anomaly rule banned.
    this.#router.post('/api/auth/users/:id/unban', requireAdmin, (req, res) =>
      this.#handlers.auth.handleUnbanUserRequest(req, res, req.params.id)
    );

    // The applications waiting on an administrator, and the two ways one is
    // answered. Approving is what creates the account; until then there is
    // nothing to sign in as.
    this.#router.get('/api/auth/registrations', requireAdmin, (req, res) =>
      this.#handlers.auth.handleListRegistrationsRequest(req, res)
    );

    this.#router.post('/api/auth/registrations/:id/approve', requireAdmin, (req, res) =>
      this.#handlers.auth.handleApproveRegistrationRequest(req, res, req.params.id)
    );

    this.#router.delete('/api/auth/registrations/:id', requireAdmin, (req, res) =>
      this.#handlers.auth.handleRejectRegistrationRequest(req, res, req.params.id)
    );

    // Who signed in, from where. An administrator's route: it is everybody's
    // addresses, not the asking account's own.
    this.#router.get('/api/auth/login-log', requireAdmin, (req, res) =>
      this.#handlers.auth.handleLoginLogRequest(req, res)
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

    // Spans every creator, so there is no ":id" for `inScope` to check. The
    // handler narrows the query by the account's campaign scope instead.
    this.#router.get('/api/search', (req, res) =>
      this.#handlers.contentAPI.handleSearchRequest(req, res)
    );

    this.#router.get('/api/collections/:id', inScope(byCollectionParam), (req, res) => {
      return this.#handlers.contentAPI.handleCollectionRequest(req, res, req.params.id);
    });

    this.#router.get('/api/campaigns/:id', (req, res) =>
      this.#handlers.campaignAPI.handleGetRequest(req, res, req.params.id)
    );

    this.#router.get('/api/campaigns', (req, res) =>
      this.#handlers.campaignAPI.handleListRequest(req, res)
    );

    // Opening a post is what spends the day's allowance for posts - the
    // listings above are free to page through, and a post already opened
    // today costs nothing to go back to. The creator check runs first, so a
    // post the user was never allowed to see is refused rather than counted.
    this.#router.get('/api/posts/:id',
      inScope(byContentParam('post')),
      requirePostQuota(this.#quotaStore),
      (req, res) => this.#handlers.contentAPI.handleGetRequest(req, res, 'post', req.params.id)
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

    // The PDF reader's own translation - Google Translate, free, and nothing
    // to do with the Gemini routes above. Open to anyone who may see the file:
    // there is no key being spent, only a page being read.
    this.#router.get('/api/pdf-translation/availability', (req, res) =>
      this.#handlers.pdfTranslation.handleAvailabilityRequest(req, res)
    );

    this.#router.post(
      '/api/media/:id/pdf-translation',
      inScope(byMediaParam),
      (req, res) => {
        this.#handlers.pdfTranslation.handleTranslateRequest(req, res, req.params.id)
          .catch(() => {
            if (!res.headersSent) {
              res.status(500).json({ error: 'Could not translate this page' });
            }
          });
      }
    );

    // The one sanctioned way past `MediaAccessGuard`: an administrator who can
    // also produce the download code gets a short-lived ticket for one file.
    this.#router.post('/api/media/:id/download-ticket', requireAdmin, (req, res) =>
      this.#handlers.media.handleDownloadTicketRequest(req, res, req.params.id)
    );

    // The handler applies `checkMediaAccess` itself - it has the logger, and a
    // refusal is worth a line naming the headers that caused it.
    this.#router.get('/media/:id', mediaInScope, (req, res) =>
      this.#handlers.media.handleMediaRequest(req, res, req.params.id)
    );

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
  quotaStore: QuotaStore,
  loginLogStore: LoginLogStore,
  pathToFFmpeg?: string | null,
  transcriptionConfig?: TranscriptionConfig | null,
  logger?: Logger | null,
  translationConfig?: TranslationConfig | null,
  pdfTranslationConfig?: PdfTranslationConfig | null
) {
  const transcription = createTranscriptionServices(dataDir, transcriptionConfig, pathToFFmpeg, logger);
  // After transcription, and given its index and queue: a translation reads
  // the subtitle a transcription wrote, and follows one when asked to.
  const translation = createTranslationServices(
    dataDir, transcription.index, transcription.queue, translationConfig, logger,
    transcription.vocabulary
  );
  // One guard, shared by the sign-in handler and by the check the router runs
  // on every request, so that an address placed for one is placed for both.
  // Google Translate for the PDF reader, built apart from the Gemini side
  // above and sharing nothing with it.
  const pdfTranslation = createPdfTranslationServices(dataDir, pdfTranslationConfig, logger);
  // One guard, shared by the sign-in handler and by the check the router runs
  // on every request, so that an address placed for one is placed for both.
  const regionGuard = new LoginRegionGuard(loginLogStore, logger);
  return new _Router({
    campaignAPI: new CampaignAPIRequestHandler(api, logger),
    contentAPI: new ContentAPIRequestHandler(api, logger),
    media: new MediaRequestHandler(db, dataDir, quotaStore, authStore, logger),
    settingsAPI: new SettingsAPIRequestHandler(api, logger),
    mediaAPI: new MediaAPIRequestHandler(api, dataDir, logger),
    auth: new AuthAPIRequestHandler(
      authStore, historyStore, quotaStore, loginLogStore, regionGuard, logger
    ),
    history: new HistoryAPIRequestHandler(db, historyStore, logger),
    pdfTranslation: new PdfTranslationRequestHandler(
      pdfTranslation.translator, pdfTranslation.store, logger
    ),
    transcription: new TranscriptionAPIRequestHandler(
      db, dataDir,
      transcription.index, transcription.queue, transcription.vad, transcription.settings,
      transcription.vocabulary,
      logger
    ),
    translation: new TranslationAPIRequestHandler(
      transcription.index, translation.queue, translation.settings,
      logger
    )
  }, authStore, quotaStore, regionGuard, db).router;
}
