import "../assets/styles/PdfViewer.scss";
import "react-pdf/dist/Page/TextLayer.css";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space, Spin, Tooltip } from "antd";
import {
  LeftOutlined,
  RightOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  ColumnWidthOutlined,
  ColumnHeightOutlined,
  DownloadOutlined,
  TranslationOutlined,
  ProfileOutlined,
  SettingOutlined,
  FileOutlined,
  FileImageOutlined,
  SplitCellsOutlined,
  ReadOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined
} from "@ant-design/icons";
import { Document, Page, pdfjs } from "react-pdf";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useAPI } from "../contexts/APIProvider";
import { useLanguage } from "../contexts/LanguageProvider";
import { useAuth } from "../contexts/AuthProvider";
import { useDownload } from "../contexts/DownloadProvider";
import { extractPageBlocks, type PdfTextBlock } from "../utils/PdfText";
import PdfTranslationSettingsModal from "./settings/PdfTranslationSettingsModal";

// Bundled rather than pulled from a CDN: this is an offline browsing tool and
// has to work with no network at all.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Character maps and the fourteen standard fonts, copied into the build by
 * `vite-plugin-static-copy`. Without the cMaps, CJK text in PDFs that rely on
 * CID-keyed fonts comes out blank.
 *
 * Defined once at module scope - react-pdf re-fetches the document whenever
 * this object changes identity.
 */
const PDF_OPTIONS = {
  cMapUrl: '/assets/pdfjs/cmaps/',
  standardFontDataUrl: '/assets/pdfjs/standard_fonts/',
  /**
   * Fetch the pages being read, and nothing else.
   *
   * pdf.js defaults to doing both at once: byte ranges for what is on screen
   * *and* a background download of the whole file. On a 120 MB attachment that
   * second one is twenty seconds of transfer for bytes nobody asked for, and
   * it is invisible in the reader because the page appears from the ranges
   * long before it finishes. `disableStream` drops the background download and
   * `disableAutoFetch` stops it fetching ahead of what is actually needed.
   *
   * Both rely on the server answering byte ranges, which it does - the media
   * route hands ranges to express, and PDFs are not compressed on the way out
   * (which would break them).
   */
  disableStream: true,
  disableAutoFetch: true,
  /**
   * Four times the default. Each range is a round trip, and at 64 KB a large
   * page's fonts and images come to a lot of them; at this size a page is
   * typically a handful.
   */
  rangeChunkSize: 262144
};

/**
 * The dialog is sized as a share of the viewport rather than in pixels, and
 * the page is always drawn to whatever width that leaves. Between them there
 * is no setting at which the reader can be made to scroll sideways: widening
 * the dialog is what zooming in means here, and the page follows the window
 * whenever it is resized.
 *
 * In fullscreen the dialog is the whole screen, so the same setting stops
 * being a dialog width and becomes a cap on the column the pages are laid out
 * in - which is the same thing from the reader's side, and keeps the buttons
 * doing what they did.
 */
const MIN_WIDTH_PERCENT = 40;
const MAX_WIDTH_PERCENT = 96;
const WIDTH_STEP = 6;
/** Matches the old fixed `min(1100px, 92vw)`, expressed as a share instead. */
const PREFERRED_WIDTH_PX = 1100;
const FALLBACK_WIDTH_PERCENT = 92;

const WIDTH_STORAGE_KEY = 'patreon-dl.pdfViewerWidthPercent';

/**
 * Whether this browser throws the whole page away rather than let it grow.
 *
 * iOS is the one that matters. Safari there gives a tab a small fraction of
 * the memory a desktop browser does, and when a tab passes it nothing fails
 * in a way the page can see: WebKit discards the tab and loads it again from
 * scratch, which from the reader's side is a document that closes itself
 * after a few pages. So every figure that decides what a page costs is lower
 * here, and a page that has been read is given back rather than kept.
 *
 * iPadOS reports itself as a Mac, hence the second test - a desktop Safari
 * has no touch points.
 */
const MEMORY_CONSTRAINED = (() => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const agent = navigator.userAgent || '';
  const ios = /iP(hone|ad|od)/.test(agent) ||
    (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  // Phones with little to spare answer this; desktops largely do not.
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return ios || (typeof memory === 'number' && memory <= 4);
})();

/**
 * How many pages ahead of the one being read are drawn in advance.
 *
 * They are mounted, hidden, at the same width as the visible page, so pdf.js
 * has already rasterised them by the time the reader asks for one - turning a
 * page becomes showing a canvas that exists rather than rendering one. Three
 * covers reading at a normal pace without holding a whole document's worth of
 * canvases in memory.
 */
const DEFAULT_PRELOAD_PAGES = MEMORY_CONSTRAINED ? 1 : 3;

/**
 * And a smaller number for the two layouts that already hold more than one
 * page on screen. A canvas is the expensive thing here, so a spread that drew
 * three pages ahead would be holding eight of them at once.
 */
const MULTI_PAGE_PRELOAD = MEMORY_CONSTRAINED ? 1 : 2;

/**
 * A hard ceiling on how many pages are drawn at once, whatever the layout
 * asked for.
 *
 * The scrolling column decides what it draws from what is on screen, and a
 * short document at a small width can put a lot of pages on screen at once -
 * each of them a canvas, and each of them a page's worth of decoded images
 * held by pdf.js. The preload numbers above are per-layout intentions; this
 * is the budget they all share.
 */
const MAX_DRAWN_PAGES = MEMORY_CONSTRAINED ? 3 : 8;

/**
 * How the pages are laid out.
 *
 * - `single`: one page at a time, turned with the arrows.
 * - `scroll`: every page in one column, read by scrolling - nothing to click
 *   between one page and the next.
 * - `spread`: two pages side by side, and the pair *slides* rather than
 *   stepping: 1-2, then 2-3, then 3-4. Each turn keeps the page just read on
 *   screen next to the one that follows it, which is what a spread is worth
 *   for a document whose figures and their captions straddle the fold.
 */
type ViewMode = 'single' | 'scroll' | 'spread';

const VIEW_MODE_STORAGE_KEY = 'patreon-dl.pdfViewerViewMode';

/**
 * Translating the page as a picture instead of as text.
 *
 * The text translation needs a text layer to work from, and a great many PDFs
 * do not have one worth reading: a scan, a comic, a slide deck exported as
 * images, a diagram whose labels are part of the artwork. For those the page
 * is sent to Baidu as the picture the reader has already drawn, and comes
 * back as the same picture with the translation printed into it.
 *
 * - `immersive`: the translated picture sits over the original, and holding
 *   the left button lifts it - the same gesture as the text overlay, because
 *   it answers the same question.
 * - `side`: the original and the translated picture side by side, which is
 *   the layout the two-page spread uses. They cannot both have it, so each
 *   turns the other's button off - see the toolbar.
 */
type ImageTranslationMode = 'off' | 'immersive' | 'side';

const IMAGE_MODE_STORAGE_KEY = 'patreon-dl.pdfViewerImageMode';

/**
 * A phone, by the same breakpoint the rest of the application uses.
 *
 * On a screen this narrow a fullscreen reader gives the page every pixel it
 * has: the dialog's padding, the tray's, and the width the zoom buttons cap
 * the column at are all margins around a page that is already as narrow as it
 * is ever going to be. Watched here rather than written as a media query in
 * the stylesheet because the toolbar has to know as well - buttons that set a
 * width nothing is using would be three buttons that do nothing.
 */
const NARROW_VIEWPORT = '(max-width: 575.98px)';

function useNarrowViewport() {
  const [ narrow, setNarrow ] = useState(
    () => window.matchMedia?.(NARROW_VIEWPORT).matches ?? false
  );
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_VIEWPORT);
    if (!query) {
      return;
    }
    const onChange = () => setNarrow(query.matches);
    // Read again on the way in: the screen may have turned since the state
    // above was worked out.
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * The size a page is sent at.
 *
 * Baidu refuses anything over 4096 pixels on its long edge or four megabytes
 * in total, and a page drawn for a high-resolution screen is close to both. It
 * is also more than the OCR needs: two thousand pixels down the long edge is
 * about 170 dpi on A4, which reads small print comfortably, and gets a page
 * into a couple of hundred kilobytes of JPEG.
 */
const PAGE_IMAGE_MAX_EDGE = 2000;
const PAGE_IMAGE_QUALITY = 0.85;

/**
 * The thumbnail a page is checked against before it is sent. Big enough that
 * a line of text somewhere on the page disturbs it, small enough that reading
 * every pixel back costs nothing. See {@link isBlankCanvas}.
 */
const BLANK_PROBE_SIZE = 64;

/**
 * The two ways a translation is shown, remembered separately because they are
 * not alternatives: the overlay is for reading the page as if it were in your
 * own language, the panel is for reading the translation as prose beside the
 * original. Either, both, or neither.
 *
 * The panel is not offered in the spread layout - two pages already use the
 * full width of the dialog, and taking a third of it back for prose would
 * leave the pages too small to read. The remembered setting is untouched, so
 * it comes back on the way out of the spread.
 */
const IMMERSIVE_STORAGE_KEY = 'patreon-dl.pdfViewerImmersive';
const PANEL_STORAGE_KEY = 'patreon-dl.pdfViewerTranslationPanel';

/**
 * How long the left button has to be held before the original is shown again.
 *
 * Long enough that a click - selecting text, following a link - does not
 * flash the page, short enough that holding the button reads as instant.
 */
const PEEK_HOLD_MS = 180;

/**
 * Blocks per request to the server.
 *
 * Small on purpose. A whole page in one request is a request that can run for
 * tens of seconds, and anything in front of this server - a reverse proxy, a
 * tunnel - has its own idea of how long it will wait before answering with its
 * own error page. A dozen blocks is a second or two, which nothing gives up on.
 */
const BLOCKS_PER_REQUEST = 12;

/**
 * How long the reader has to stay on a page before it is remembered.
 *
 * Paging through to find something should not leave a trail of positions - the
 * one worth keeping is the page still on screen when the flipping stops.
 */
const RECORD_PAGE_AFTER_MS = 1200;

/** Below this the overlay text is not worth reading; better to let it clip. */
const MIN_OVERLAY_SCALE = 0.45;

/**
 * A ceiling on the width a page is rasterised at, in CSS pixels.
 *
 * The canvas is only ever drawn once, so this is what decides how much memory
 * a page costs: this many pixels across, times the aspect ratio, times the
 * device pixel ratio below, times four bytes. Past this width the text is
 * already larger than anyone reads at, so the extra pixels would buy nothing.
 */
const MAX_RENDER_WIDTH = 1400;

/**
 * And a ceiling on the device pixel ratio, for the same reason. A phone at 3x
 * would otherwise draw nine times the pixels of a desktop for a page that is
 * physically smaller.
 *
 * Lower again where memory is the thing that runs out first: 1.5x is still
 * above what the screen resolves once the page is scaled down to the column,
 * and costs a little over half what 2x does.
 */
const MAX_DEVICE_PIXEL_RATIO = MEMORY_CONSTRAINED ? 1.5 : 2;

/**
 * The shape assumed for a page nobody has opened yet.
 *
 * In the scrolling layout every page in the document has a box in the column
 * from the moment the file opens, so that the scrollbar means something and a
 * jump to page 200 lands near page 200 - but only the handful being read are
 * actually drawn. The boxes for the rest need a height, and until a page has
 * been opened the only honest answer is "probably like the others": the first
 * page that does load supplies the figure, and A4 stands in until one has.
 */
const DEFAULT_PAGE_ASPECT = 297 / 210;

/**
 * A jump lands on boxes whose heights were guessed, so it can be off by a
 * little until the pages it landed on are drawn for real. The alignment is
 * therefore reapplied for a few renders afterwards - bounded, so that a page
 * that never loads cannot leave the reader fighting the scrollbar forever.
 */
const SCROLL_ALIGN_ATTEMPTS = 8;

/** Where in the stage a page has to reach before it counts as the one being read. */
const SCROLL_ACTIVE_OFFSET = 0.35;

/** The gap between the two pages of a spread, in CSS pixels. Matches the SCSS. */
const SPREAD_GAP = 16;

/**
 * The widest the page area can ever get: the dialog at its widest setting, and
 * the stage is always narrower than the dialog it sits in - so a page drawn to
 * this is never asked to be shown larger than it was drawn.
 */
function getMaxStageWidth() {
  return Math.min(
    MAX_RENDER_WIDTH,
    Math.max(240, Math.floor((window.innerWidth || MAX_RENDER_WIDTH) * MAX_WIDTH_PERCENT / 100))
  );
}

function readStoredFlag(key: string) {
  try {
    return window.localStorage.getItem(key) === '1';
  }
  catch (_error) {
    return false;
  }
}

function storeFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  }
  catch (_error) { /* empty */ }
}

function readStoredViewMode(): ViewMode {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === 'scroll' || stored === 'spread' ? stored : 'single';
  }
  catch (_error) {
    return 'single';
  }
}

function storeViewMode(mode: ViewMode) {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  }
  catch (_error) { /* empty */ }
}

function readStoredImageMode(): ImageTranslationMode {
  try {
    const stored = window.localStorage.getItem(IMAGE_MODE_STORAGE_KEY);
    return stored === 'immersive' || stored === 'side' ? stored : 'off';
  }
  catch (_error) {
    return 'off';
  }
}

function storeImageMode(mode: ImageTranslationMode) {
  try {
    window.localStorage.setItem(IMAGE_MODE_STORAGE_KEY, mode);
  }
  catch (_error) { /* empty */ }
}

/**
 * Whether there is anything on the canvas.
 *
 * Assigning a width to a canvas empties it, which is how pdf.js starts drawing
 * a page again at a new size - so between a layout change and the redraw that
 * follows it, a page that is perfectly good to look at is momentarily blank to
 * read from. A picture taken in that window is a white page, and a white page
 * sent for translation comes back "no text on this page" and is remembered as
 * one.
 *
 * The whole page is squeezed into a thumbnail and every pixel of that
 * compared. Real content never averages to one flat colour at this size;
 * an emptied canvas is nothing else. A page that genuinely is blank reads as
 * blank too, which is the right answer for it as well - there is nothing on it
 * to translate.
 */
function isBlankCanvas(canvas: HTMLCanvasElement) {
  const probe = document.createElement('canvas');
  probe.width = BLANK_PROBE_SIZE;
  probe.height = BLANK_PROBE_SIZE;
  const context = probe.getContext('2d', { willReadFrequently: true });
  if (!context) {
    // Unreadable is not the same as blank, and guessing "blank" here would
    // stop the page being translated at all.
    return false;
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, BLANK_PROBE_SIZE, BLANK_PROBE_SIZE);
  context.drawImage(canvas, 0, 0, BLANK_PROBE_SIZE, BLANK_PROBE_SIZE);
  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, BLANK_PROBE_SIZE, BLANK_PROBE_SIZE).data;
  }
  catch (_error) {
    return false;
  }
  for (let at = 4; at < pixels.length; at += 4) {
    if (pixels[at] !== pixels[0] ||
      pixels[at + 1] !== pixels[1] ||
      pixels[at + 2] !== pixels[2]) {
      return false;
    }
  }
  return true;
}

/**
 * The page as a picture to send for translation.
 *
 * Taken from the canvas the reader is already showing rather than drawn again:
 * it is the same page, it is already in memory, and drawing it twice would
 * cost a second render of every glyph on it.
 *
 * Drawn onto white first. A JPEG has no transparency to fall back on, so a
 * canvas with any left in it would come out with black where the paper should
 * be - and a black page is one Baidu can read nothing from.
 *
 * `null` where there was nothing to photograph. The caller records nothing for
 * it, deliberately: the page will be drawn again, and being drawn again is
 * what asks for it a second time.
 */
function capturePageImage(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const source = Math.max(canvas.width, canvas.height);
  if (!source || isBlankCanvas(canvas)) {
    return Promise.resolve(null);
  }
  const scale = Math.min(1, PAGE_IMAGE_MAX_EDGE / source);
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const target = document.createElement('canvas');
  target.width = width;
  target.height = height;
  const context = target.getContext('2d');
  if (!context) {
    return Promise.resolve(null);
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(canvas, 0, 0, width, height);
  return new Promise((resolve) => {
    target.toBlob((blob) => resolve(blob), 'image/jpeg', PAGE_IMAGE_QUALITY);
  });
}

/**
 * The rendered page, as react-pdf hands it back. Only what is needed to place
 * an overlay on it: `originalWidth` is the page at scale 1, which is the space
 * `extractPageBlocks` measures in.
 */
interface LoadedPage {
  originalWidth: number;
  originalHeight: number;
  getViewport: (params: { scale: number }) => { transform: number[]; scale: number };
  getTextContent: () => Promise<{ items: unknown[]; styles?: Record<string, { ascent?: number }> }>;
  /**
   * Lets go of everything pdf.js decoded to draw the page - the images at
   * their full size, on both sides of the worker. See the effect that calls
   * it. Optional only because the object is typed here by hand; pdf.js always
   * supplies it.
   */
  cleanup?: () => void;
}

interface PageTranslation {
  blocks: PdfTextBlock[];
  /** One per block, in step with it. `null` where nothing came back. */
  translations: (string | null)[];
  /** Blocks that came back with nothing; the original is shown for those. */
  failed: number;
  /**
   * Whether every block has been asked for.
   *
   * A page arrives a batch at a time and each batch is cached as it lands, so
   * "there is an entry for this page" and "this page is done" are different
   * questions. Only this one may stop it being asked for again - turning the
   * page mid-way used to leave a partial entry that blocked the rest of it
   * for good.
   */
  complete: boolean;
}

/** The page a jump is still settling onto, and how many tries it has left. */
interface PendingScroll {
  page: number;
  attempts: number;
}

/**
 * Translated text laid over the original, shrunk to fit the box it replaces.
 *
 * Chinese is usually shorter than the English it came from but not always, and
 * a box on a PDF page cannot grow - so the fit is done with a transform rather
 * than by re-flowing: the text is measured once, scaled down if it overruns,
 * and never re-wrapped, which makes the result exact instead of iterative.
 */
function FitText(props: { text: string; fontSize: number; deps: unknown }) {
  const { text, fontSize, deps } = props;
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) {
      return;
    }
    el.style.transform = '';
    const overrun = Math.max(
      box.clientHeight > 0 ? el.scrollHeight / box.clientHeight : 1,
      box.clientWidth > 0 ? el.scrollWidth / box.clientWidth : 1
    );
    if (overrun > 1) {
      el.style.transform = `scale(${Math.max(MIN_OVERLAY_SCALE, 1 / overrun)})`;
    }
  }, [ text, fontSize, deps ]);

  return (
    <span ref={ref} className="pdf-viewer__overlay-text" style={{ fontSize }}>
      {text}
    </span>
  );
}

/**
 * The box one page occupies, whether or not that page has been drawn yet.
 *
 * Kept apart from the page inside it, and memoised, because of the scrolling
 * layout: a five hundred page document has five hundred of these, and dragging
 * the dialog wider must not re-render every one of them on every frame. So the
 * width they share lives in a custom property on the deck - one style to write
 * per frame instead of five hundred - and each box only knows its own shape,
 * which changes once, when the page behind it is opened for the first time.
 *
 * A box with nothing in it shows its page number: scrolling fast should read
 * as pages going past rather than as a blank column.
 */
interface PageSlotProps {
  pageNumber: number;
  /** Height as a multiple of the width. Guessed until the page has loaded. */
  aspect: number;
  hidden: boolean;
  slotRef: (node: HTMLDivElement | null) => void;
  children?: React.ReactNode;
  /**
   * The translated picture beside the page, described rather than passed.
   *
   * A rendered node would be a new object on every render, and every box in
   * the scrolling column carries one of these - which is exactly what the
   * memo above exists to avoid. So the state comes in as three plain values
   * and the box is built here: `sideUrl` absent means the page has not been
   * asked about yet, `null` means it was and had no text on it.
   */
  showSide?: boolean;
  sideUrl?: string | null;
  sideBusy?: boolean;
  /** Set when this page's picture came back as a failure rather than a page. */
  sideFailed?: boolean;
  /** Asks for this page again. Stable, so the memo above still holds. */
  onRetry?: (pageNumber: number) => void;
}

const PageSlot = memo(function PageSlot(props: PageSlotProps) {
  const {
    pageNumber, aspect, hidden, slotRef, children,
    showSide, sideUrl, sideBusy, sideFailed, onRetry
  } = props;
  const { t } = useLanguage();
  return (
    <div
      className="pdf-viewer__slot"
      ref={slotRef}
      // Read back by the observers, which are handed elements rather than
      // page numbers.
      data-page={pageNumber}
      hidden={hidden}
      style={{ '--pdf-page-aspect': aspect } as React.CSSProperties}
    >
      <div className="pdf-viewer__page">
        {children ?? <div className="pdf-viewer__placeholder">{pageNumber}</div>}
      </div>
      {
        showSide ? (
          <div className="pdf-viewer__page pdf-viewer__page--side">
            {sideUrl ? (
                <img
                  className="pdf-viewer__side-image"
                  src={sideUrl}
                  alt={t('pdf_alt_page_translated', { page: pageNumber })}
                  draggable={false}
                />
              ) : (
                <div className="pdf-viewer__placeholder">
                  {
                    sideUrl === null ? t('pdf_no_text_on_page') :
                      sideBusy ? <Spin /> :
                        // The page it belongs to is right there beside it, so
                        // this is where the offer to try again belongs.
                        sideFailed ? (
                          <Button size="small" onClick={() => onRetry?.(pageNumber)}>
                            {t('pdf_try_again')}
                          </Button>
                        ) : t('pdf_waiting_for_page')
                  }
                </div>
              )}
          </div>
        ) : null
      }
    </div>
  );
});

const clampWidthPercent = (percent: number) =>
  Math.min(MAX_WIDTH_PERCENT, Math.max(MIN_WIDTH_PERCENT, Math.round(percent)));

function getDefaultWidthPercent() {
  const viewportWidth = window.innerWidth || PREFERRED_WIDTH_PX;
  return clampWidthPercent(
    Math.min(FALLBACK_WIDTH_PERCENT, (PREFERRED_WIDTH_PX / viewportWidth) * 100)
  );
}

function readStoredWidthPercent() {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    if (!Number.isFinite(stored) || stored <= 0) {
      return getDefaultWidthPercent();
    }
    return clampWidthPercent(stored);
  }
  catch (_error) {
    return getDefaultWidthPercent();
  }
}

/** Not remembering the chosen width is not worth failing over. */
function storeWidthPercent(percent: number) {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(percent));
  }
  catch (_error) { /* empty */ }
}

function sameNumbers(a: number[], b: number[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface PdfViewerTarget {
  /** What the reader loads. Carries `lapid` for a linked attachment. */
  url: string;
  /** Named separately from the URL: it is what a download ticket is asked for. */
  mediaId: string;
  filename: string;
  /**
   * The post it was opened from, when it was opened from one.
   *
   * Recorded with the reading position for the same reason the video history
   * records it: an attachment linked from another post has no row of its own
   * tying it to a creator, and the post is the only thing that names it.
   */
  postId?: string | null;
}

interface PdfViewerModalProps {
  target: PdfViewerTarget | null;
  onClose: () => void;
  /** Pages drawn ahead of the current one. See {@link DEFAULT_PRELOAD_PAGES}. */
  preloadPages?: number;
}

/**
 * Reads PDFs in-page instead of handing them to the browser's built-in viewer.
 *
 * The built-in one differs per browser, is missing altogether on most mobile
 * ones, and comes with download and print buttons - which sit oddly next to
 * the rest of the media handling here. Rendering with pdf.js means the toolbar
 * is ours and offers only what we want it to.
 */
function PdfViewerModal(props: PdfViewerModalProps) {
  const { target, onClose, preloadPages = DEFAULT_PRELOAD_PAGES } = props;
  const { api } = useAPI();
  const { t } = useLanguage();
  const { user } = useAuth();
  const { canDownload, requestDownload } = useDownload();
  const [ numPages, setNumPages ] = useState(0);
  const [ page, setPage ] = useState(1);
  /**
   * What is in the page box, which is not the page being read.
   *
   * They are separate because a box that only ever held a valid page number
   * could not be typed in: clearing it to type "12" would be an empty string,
   * and "1" on the way to "12" is a page of its own. So the box holds whatever
   * has been typed, and only a committed value - Enter, or leaving the box -
   * turns into a page turn.
   */
  const [ pageInput, setPageInput ] = useState('1');
  const [ viewMode, setViewMode ] = useState<ViewMode>(readStoredViewMode);
  const [ imageMode, setImageMode ] = useState<ImageTranslationMode>(() => {
    const stored = readStoredImageMode();
    // Both were remembered separately and they cannot both be on. The layout
    // is the one that was asked for explicitly, so the picture gives way.
    return stored === 'side' && readStoredViewMode() === 'spread' ? 'off' : stored;
  });
  const [ widthPercent, setWidthPercent ] = useState(readStoredWidthPercent);
  const [ containerWidth, setContainerWidth ] = useState(0);
  const [ resizing, setResizing ] = useState(false);
  const [ fullscreen, setFullscreen ] = useState(false);
  const narrowViewport = useNarrowViewport();
  /** A phone in fullscreen: no margins anywhere, the page takes the width. */
  const fullBleed = fullscreen && narrowViewport;
  const [ failed, setFailed ] = useState(false);
  const [ immersive, setImmersive ] = useState(() => readStoredFlag(IMMERSIVE_STORAGE_KEY));
  const [ panelOpen, setPanelOpen ] = useState(() => readStoredFlag(PANEL_STORAGE_KEY));
  /** The overlay lifted for as long as the left button is held down. */
  const [ peeking, setPeeking ] = useState(false);
  // Keyed by page: the scrolling and spread layouts both have more than one
  // page on screen, and each of them carries its own overlay.
  const [ pageTranslations, setPageTranslations ] = useState(new Map<number, PageTranslation>());
  const [ translatingPages, setTranslatingPages ] = useState(new Set<number>());
  const [ translationError, setTranslationError ] = useState<string | null>(null);
  const [ hoveredBlockId, setHoveredBlockId ] = useState<string | null>(null);
  const [ settingsOpen, setSettingsOpen ] = useState(false);
  /**
   * The translated picture of each page: an object URL, or `null` for a page
   * Baidu found no text on - which is not a failure, and is worth remembering
   * so that it is neither asked for again nor reported as one.
   */
  const [ pageImages, setPageImages ] = useState(new Map<number, string | null>());
  const [ imageTranslating, setImageTranslating ] = useState(new Set<number>());
  /**
   * What went wrong, per page.
   *
   * Kept per page rather than as one message because that is the shape the
   * reader needs it in: the page that failed is the one that gets the offer
   * to try again, and a failure on a page that has since been scrolled past
   * should stop being reported.
   */
  const [ imageErrors, setImageErrors ] = useState(new Map<number, string>());
  /**
   * Bumped by "try again". Nothing here retries on its own: an engine that
   * has just refused a page will refuse it again, and Baidu charges for the
   * asking - so a retry is a person deciding to spend it, and this is what
   * carries that decision into the two effects that do the work.
   */
  const [ retryEpoch, setRetryEpoch ] = useState(0);
  /**
   * Pages whose canvas has finished drawing, and so can be photographed - and
   * how many times each has finished.
   *
   * The count is the point. A page is drawn again whenever the width it is
   * drawn at changes, and the width halves the moment the reader goes to two
   * columns: switching to the spread, or to a page beside its translated
   * picture, redraws every canvas on screen. As a set of page numbers this
   * said nothing on the second drawing - the page was already in it - so the
   * effect below never ran again, and a page whose first drawing it had missed
   * (or had photographed while it was being cleared for the second) stayed
   * untranslated with nothing left to trigger it.
   */
  const [ paintedPages, setPaintedPages ] = useState(new Map<number, number>());
  /** Which pages are actually in view. Only the scrolling layout can't say up front. */
  const [ visiblePages, setVisiblePages ] = useState<number[]>([]);
  // Every page pdf.js has opened, preloaded ones included. Keyed rather than
  // held singly because a page that was preloaded has already fired its load
  // callback by the time it is turned to, and will not fire it again.
  const [ loadedPages, setLoadedPages ] = useState(new Map<number, LoadedPage>());
  const observerRef = useRef<ResizeObserver | null>(null);
  /** The box that scrolls, and the boxes of every page laid out inside it. */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef(new Map<number, HTMLDivElement>());
  const slotCallbacks = useRef(new Map<number, (node: HTMLDivElement | null) => void>());
  /** The dialog itself, which is what is handed to the fullscreen API. */
  const modalRef = useRef<HTMLElement | null>(null);
  const pendingScroll = useRef<PendingScroll | null>(null);
  /** Set while a scroll of our own is in flight, so it is not read as the reader's. */
  const selfScrolling = useRef(false);
  const peekTimer = useRef<number | null>(null);
  // Kept for the life of one open document: turning back a page must not ask
  // the server again, and the server's own store is a network round trip away.
  const translationCache = useRef(new Map<number, PageTranslation>());
  /** Pages a request is already out for, so none is asked for twice. */
  const runningPages = useRef(new Set<number>());
  /** Aborted as one when the document, the settings, or the need for it changes. */
  const translationAbort = useRef<AbortController | null>(null);
  /**
   * The same three, for the picture translation. Held apart from the text
   * ones because the two are turned on and off separately and a page can be
   * having both done to it at once.
   */
  const pageCanvases = useRef(new Map<number, HTMLCanvasElement>());
  const canvasCallbacks = useRef(new Map<number, (node: HTMLCanvasElement | null) => void>());
  const imageUrls = useRef(new Map<number, string | null>());
  const runningImages = useRef(new Set<number>());
  /**
   * Pages the reader has pressed "try again" on.
   *
   * Held until the request for that page actually goes out, and taken off it
   * as it does: it is what tells the server not to answer from its own copy,
   * which may be the blank page this used to photograph.
   */
  const forcedImages = useRef(new Set<number>());
  const imageAbort = useRef<AbortController | null>(null);
  /** Bumped when the engine changes, which is what re-runs everything cached. */
  const [ translationEpoch, setTranslationEpoch ] = useState(0);
  /** The file whose stored page has been applied, so it is applied once. */
  const resumedFile = useRef<string | null>(null);
  /**
   * Whether this reader is offered the translation at all. Without it the two
   * buttons are not drawn and nothing is ever asked for - the route behind
   * them refuses the account regardless, this only keeps the toolbar honest.
   */
  const canTranslate = user?.canTranslatePdf === true;
  /** See {@link PANEL_STORAGE_KEY}: two pages leave no room for a third column. */
  const panelAvailable = canTranslate && viewMode !== 'spread';
  const panelVisible = panelAvailable && panelOpen;
  /**
   * The picture translation covers the page it is laid over, so the text
   * overlay under it would be doing nothing but costing requests. The two are
   * alternatives rather than companions - see {@link ImageTranslationMode}.
   */
  const immersiveShown = canTranslate && immersive && imageMode !== 'immersive';
  const translationWanted = canTranslate && (immersiveShown || panelVisible);
  const imageWanted = canTranslate && imageMode !== 'off';
  /** The layout the two-column picture needs, which the spread is also using. */
  const sideBySideImages = imageWanted && imageMode === 'side';
  /** Whether there is anything laid over the page for a long press to lift. */
  const peekable = canTranslate && (immersiveShown || imageMode === 'immersive');

  // A callback ref, because the element only exists while the modal is open.
  // `ResizeObserver` reports the content box, so what comes back is the room
  // actually left for the pages - padding, the width cap that stands in for
  // the dialog width in fullscreen, and any vertical scrollbar, already taken
  // off.
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      // The stage has gone with the dialog. Its last width belonged to it, and
      // the pages must wait to be measured against whatever replaces it.
      setContainerWidth(0);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  // The scrolling box, and - through it - the dialog the fullscreen button
  // hands to the browser. Found by walking up rather than held by the Modal,
  // which does not offer a ref to its own content.
  const setStageRef = useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    modalRef.current = node ? node.closest('.ant-modal') : null;
  }, []);

  const slotRef = useCallback((pageNumber: number) => {
    let callback = slotCallbacks.current.get(pageNumber);
    if (!callback) {
      callback = (node: HTMLDivElement | null) => {
        if (node) {
          slotRefs.current.set(pageNumber, node);
        }
        else {
          slotRefs.current.delete(pageNumber);
        }
      };
      slotCallbacks.current.set(pageNumber, callback);
    }
    return callback;
  }, []);

  // The canvas each page was drawn onto, which is what the picture
  // translation photographs. Kept in step with the pages themselves: one that
  // scrolls out of the window and is unmounted takes its canvas with it.
  const canvasRef = useCallback((pageNumber: number) => {
    let callback = canvasCallbacks.current.get(pageNumber);
    if (!callback) {
      callback = (node: HTMLCanvasElement | null) => {
        if (node) {
          pageCanvases.current.set(pageNumber, node);
          return;
        }
        pageCanvases.current.delete(pageNumber);
        // Scrolled out of the window and unmounted. Whatever was drawn is
        // gone, so the page counts as unpainted again - otherwise coming back
        // to it would leave it in a state where it can never be photographed.
        setPaintedPages((current) => {
          if (!current.has(pageNumber)) {
            return current;
          }
          const next = new Map(current);
          next.delete(pageNumber);
          return next;
        });
      };
      canvasCallbacks.current.set(pageNumber, callback);
    }
    return callback;
  }, []);

  /**
   * Lets go of every translated picture.
   *
   * They are object URLs, which are held by the document until they are
   * revoked whether or not anything is still showing them - so the one place
   * that empties the map is also the one place that revokes them.
   */
  const releaseImages = useCallback(() => {
    for (const url of imageUrls.current.values()) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    imageUrls.current.clear();
    setPageImages(new Map());
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  useEffect(() => releaseImages, [releaseImages]);

  useEffect(() => {
    setNumPages(0);
    setPage(1);
    setFailed(false);
    translationCache.current.clear();
    runningPages.current.clear();
    runningImages.current.clear();
    forcedImages.current.clear();
    slotRefs.current.clear();
    slotCallbacks.current.clear();
    pageCanvases.current.clear();
    canvasCallbacks.current.clear();
    pendingScroll.current = null;
    resumedFile.current = null;
    setPageTranslations(new Map());
    setTranslatingPages(new Set());
    setTranslationError(null);
    setImageErrors(new Map());
    setPaintedPages(new Map());
    releaseImages();
    setVisiblePages([]);
    setLoadedPages(new Map());
  }, [ target?.url, releaseImages ]);

  // Arrow buttons, a resumed reading position, a document that turned out to
  // be shorter than the box says - the box follows the page, whatever moved it.
  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  // A highlight belongs to the page it was pointed at on, and the panel is
  // showing a different page now.
  useEffect(() => {
    setHoveredBlockId(null);
    setTranslationError(null);
  }, [page]);

  /**
   * Where a page turn goes, whatever asked for it.
   *
   * In the scrolling layout a page turn is a scroll rather than a swap, and
   * the box being scrolled to may be a guessed height - so the jump is applied
   * now and reapplied as the pages around it are drawn for real.
   */
  const goToPage = useCallback((wanted: number) => {
    const next = Math.min(Math.max(1, wanted), numPages || 1);
    setPage(next);
    if (viewMode !== 'scroll') {
      return;
    }
    pendingScroll.current = { page: next, attempts: SCROLL_ALIGN_ATTEMPTS };
    const stage = stageRef.current;
    const slot = slotRefs.current.get(next);
    if (!stage || !slot) {
      // The column has not been laid out yet; the alignment below picks it up
      // as soon as it has been.
      return;
    }
    const delta = slot.getBoundingClientRect().top - stage.getBoundingClientRect().top;
    // Flagged only when there is actually a scroll to flag, so the flag cannot
    // be left set for the reader's next one to be mistaken for ours.
    if (Math.abs(delta) > 1) {
      selfScrolling.current = true;
      stage.scrollTop += delta;
    }
  }, [ numPages, viewMode ]);

  const changeViewMode = useCallback((mode: ViewMode) => {
    if (mode === viewMode) {
      return;
    }
    storeViewMode(mode);
    setViewMode(mode);
    setVisiblePages([]);
    // Whichever layout it changes to opens on the page that was being read.
    pendingScroll.current = mode === 'scroll' ?
      { page, attempts: SCROLL_ALIGN_ATTEMPTS } : null;
  }, [ viewMode, page ]);

  /**
   * Turns the picture translation on, off, or over to the other layout.
   *
   * Clicking the button that is already on turns it off, which is what makes
   * two buttons enough for three states.
   */
  const changeImageMode = useCallback((mode: ImageTranslationMode) => {
    setImageMode((current) => {
      const next = current === mode ? 'off' : mode;
      storeImageMode(next);
      // Switched off, so what it could not do is no longer worth reporting.
      if (next === 'off') {
        setImageErrors(new Map());
      }
      return next;
    });
  }, []);

  /**
   * Asks for these pages again.
   *
   * Both kinds of translation at once, because the reader is looking at one
   * page and does not think of them as two features: what it clears is
   * whatever did not finish - a picture that failed, a page of text that
   * failed or came back with blocks missing - and leaves alone what did.
   *
   * The server keeps its own copy of everything that has already succeeded,
   * so a retry costs only what actually has to be asked for again.
   */
  const retryPages = useCallback((pages: number[]) => {
    for (const pageNumber of pages) {
      forcedImages.current.add(pageNumber);
      const url = imageUrls.current.get(pageNumber);
      if (url) {
        URL.revokeObjectURL(url);
      }
      imageUrls.current.delete(pageNumber);
      const cached = translationCache.current.get(pageNumber);
      // A finished page with nothing missing is not what "try again" is for.
      if (cached && (!cached.complete || cached.failed > 0)) {
        translationCache.current.delete(pageNumber);
      }
    }
    setPageImages(new Map(imageUrls.current));
    setPageTranslations(new Map(translationCache.current));
    setImageErrors((current) => {
      const next = new Map(current);
      for (const pageNumber of pages) {
        next.delete(pageNumber);
      }
      return next;
    });
    setTranslationError(null);
    setRetryEpoch((current) => current + 1);
  }, []);

  // The one thing a scroll of the reader's own has to do: give up on a jump
  // that was still settling, so the two cannot fight over the scrollbar.
  const handleStageScroll = useCallback(() => {
    if (viewMode !== 'scroll') {
      return;
    }
    const ours = selfScrolling.current;
    selfScrolling.current = false;
    if (!ours) {
      pendingScroll.current = null;
    }
  }, [viewMode]);

  /**
   * Whether this reader is meant to be translating anything at all, as one
   * controller. Everything in flight is dropped when the document changes,
   * when the buttons are turned off, or when the engine behind them changes -
   * and nothing outside those has to abort a request to stay correct.
   */
  useEffect(() => {
    const controller = new AbortController();
    translationAbort.current = controller;
    return () => {
      controller.abort();
      if (translationAbort.current === controller) {
        translationAbort.current = null;
      }
      runningPages.current.clear();
    };
  }, [ target?.url, translationWanted, translationEpoch ]);

  const translatePage = useCallback(async (
    pageNumber: number, loaded: LoadedPage, mediaId: string, signal: AbortSignal
  ) => {
    // Reused when the page was left half done: the blocks are the same, so
    // only what is still missing has to be asked for.
    const cached = translationCache.current.get(pageNumber);
    setTranslatingPages((current) => new Set(current).add(pageNumber));
    try {
      const blocks = cached?.blocks ?? await extractPageBlocks(loaded, pageNumber);
      if (signal.aborted) {
        return;
      }
      let translations = cached ? [ ...cached.translations ] : blocks.map(() => null);
      const record = (complete: boolean) => {
        const result: PageTranslation = {
          blocks,
          translations,
          failed: translations.filter((text) => text === null).length,
          complete
        };
        translationCache.current.set(pageNumber, result);
        setPageTranslations((current) => new Map(current).set(pageNumber, result));
      };

      // A scanned page has no text layer to translate. Recorded all the same,
      // so it is not asked for again on every render.
      const missing = blocks.reduce<number[]>((result, block, index) => {
        if (translations[index] === null && block.text.trim()) {
          result.push(index);
        }
        return result;
      }, []);
      if (missing.length === 0) {
        record(true);
        return;
      }

      // Asked for a handful of blocks at a time rather than a page at a
      // time. A whole page can take long enough for a reverse proxy to give
      // up on the request and answer with its own error page instead - and
      // a short request cannot. The translation also appears as it arrives
      // rather than all at the end, which is the better way round anyway.
      for (let start = 0; start < missing.length; start += BLOCKS_PER_REQUEST) {
        const indices = missing.slice(start, start + BLOCKS_PER_REQUEST);
        const response = await api.translatePdfPage(
          mediaId,
          indices.map((index) => blocks[index].text),
          undefined,
          signal
        );
        if (signal.aborted) {
          return;
        }
        translations = [ ...translations ];
        response.translations.forEach((text, at) => {
          translations[indices[at]] = text;
        });
        // Kept as it goes, so scrolling the page away and back keeps whatever
        // had arrived by then - and, being incomplete, the rest is still
        // asked for on the way back.
        record(start + BLOCKS_PER_REQUEST >= missing.length);
      }
    }
    catch (error) {
      if (!signal.aborted) {
        setTranslationError(error instanceof Error ? error.message : t('pdf_could_not_translate_page'));
      }
    }
    finally {
      setTranslatingPages((current) => {
        if (!current.has(pageNumber)) {
          return current;
        }
        const next = new Set(current);
        next.delete(pageNumber);
        return next;
      });
    }
  }, [api, t]);

  /**
   * The pages on screen, in the order they are laid out.
   *
   * The spread slides rather than steps - see {@link ViewMode} - so its pair
   * is the page being read and the one after it, and the last page of an
   * even-length document is shown on its own rather than beside nothing.
   */
  const shownPages = useMemo(() => {
    if (numPages === 0) {
      return [page];
    }
    if (viewMode === 'scroll') {
      return visiblePages.length > 0 ? visiblePages : [page];
    }
    if (viewMode === 'spread' && page < numPages) {
      return [ page, page + 1 ];
    }
    return [page];
  }, [ viewMode, page, numPages, visiblePages ]);

  /**
   * And the pages that are drawn: the ones on screen, plus the ones just off
   * it in the direction reading goes. In the scrolling layout that includes
   * one behind, because scrolling goes both ways.
   */
  const renderedPages = useMemo(() => {
    if (numPages === 0) {
      return [page];
    }
    const ahead = viewMode === 'single' ?
      Math.max(0, preloadPages) : Math.min(Math.max(0, preloadPages), MULTI_PAGE_PRELOAD);
    const first = viewMode === 'scroll' ?
      Math.max(1, shownPages[0] - 1) : shownPages[0];
    const last = Math.min(numPages, shownPages[shownPages.length - 1] + ahead);
    const result: number[] = [];
    for (let p = first; p <= last; p++) {
      result.push(p);
    }
    if (result.length <= MAX_DRAWN_PAGES) {
      return result;
    }
    // Over budget - see {@link MAX_DRAWN_PAGES}. What is given up is the far
    // end of the window rather than the page being read: it keeps that page
    // and as much of what follows it as the budget allows, which is the
    // direction reading goes.
    const current = Math.max(0, result.indexOf(page));
    const start = Math.min(current, result.length - MAX_DRAWN_PAGES);
    return result.slice(start, start + MAX_DRAWN_PAGES);
  }, [ viewMode, page, numPages, preloadPages, shownPages ]);

  /**
   * Gives back what pdf.js decoded for the pages that have been read.
   *
   * Drawing a page leaves pdf.js holding everything it decoded to draw it -
   * every image on the page at its full size, on both sides of the worker -
   * and it holds it until the page is told to let go. Nothing was telling it:
   * react-pdf cleans a page as it draws it, so a page drawn once and then
   * scrolled past kept a scan's worth of bitmap for as long as the document
   * stayed open. A handful of pages of that is hundreds of megabytes on the
   * illustrated PDFs this is mostly used for, which is what was reloading the
   * tab on iOS a few pages into a document.
   *
   * So a page is cleaned as it leaves the drawn window, and marked so it is
   * not cleaned again on every render. Coming back to it costs nothing worth
   * measuring: pdf.js parses the page again out of the file it is already
   * holding, which is the same work it did the first time.
   */
  const cleanedPages = useRef(new Set<number>());

  useEffect(() => {
    const drawn = new Set(renderedPages);
    for (const pageNumber of drawn) {
      cleanedPages.current.delete(pageNumber);
    }
    for (const [ pageNumber, loaded ] of loadedPages) {
      if (drawn.has(pageNumber) || cleanedPages.current.has(pageNumber)) {
        continue;
      }
      cleanedPages.current.add(pageNumber);
      try {
        loaded.cleanup?.();
      }
      catch {
        // A page that is still finishing a cancelled render refuses; pdf.js
        // remembers and does it itself when the render is done.
      }
    }
  }, [ renderedPages, loadedPages ]);

  // A different document, and the pages of the last one are gone with it.
  useEffect(() => {
    cleanedPages.current.clear();
  }, [target?.url]);

  /**
   * Which pages are worth translating: the ones actually being looked at.
   *
   * Not the preloaded ones - they cost a request each, and most of them are
   * turned past rather than read.
   */
  const translationTargets = useMemo(
    () => translationWanted ? shownPages : [],
    [ translationWanted, shownPages ]
  );

  useEffect(() => {
    const controller = translationAbort.current;
    if (!target || !controller) {
      return;
    }
    for (const pageNumber of translationTargets) {
      const loaded = loadedPages.get(pageNumber);
      if (!loaded || runningPages.current.has(pageNumber)) {
        continue;
      }
      // Only a *finished* page is left alone - a half-translated one is
      // resumed from wherever it got to.
      if (translationCache.current.get(pageNumber)?.complete) {
        continue;
      }
      runningPages.current.add(pageNumber);
      void translatePage(pageNumber, loaded, target.mediaId, controller.signal)
        .finally(() => {
          // Only if this is still the run that started it: a controller that
          // has been replaced has already emptied the set for its successor.
          if (translationAbort.current === controller) {
            runningPages.current.delete(pageNumber);
          }
        });
    }
    // `translationEpoch` is listed so that changing the engine does not just
    // empty the cache but fills it again from the pages on screen - otherwise
    // the translation would vanish until the next page turn.
  }, [ target, translationTargets, loadedPages, translatePage, translationEpoch, retryEpoch ]);

  /**
   * The picture translation's own controller, on the same terms as the text
   * one above: everything in flight is dropped when the document changes,
   * when the buttons are turned off, or when the credentials behind them do.
   *
   * Dropping them matters more here - Baidu is paid per page, and a request
   * for a page nobody is reading any more is money for nothing.
   */
  useEffect(() => {
    const controller = new AbortController();
    imageAbort.current = controller;
    return () => {
      controller.abort();
      if (imageAbort.current === controller) {
        imageAbort.current = null;
      }
      runningImages.current.clear();
    };
  }, [ target?.url, imageWanted, translationEpoch ]);

  const translatePageImage = useCallback(async (
    pageNumber: number, canvas: HTMLCanvasElement, mediaId: string,
    refresh: boolean, signal: AbortSignal
  ) => {
    setImageTranslating((current) => new Set(current).add(pageNumber));
    try {
      const image = await capturePageImage(canvas);
      if (!image || signal.aborted) {
        return;
      }
      const result = await api.translatePdfPageImage(
        mediaId, pageNumber, image, { refresh, signal }
      );
      if (signal.aborted) {
        // Nothing will be shown, so the URL would leak if it were not let go.
        if (result.url) {
          URL.revokeObjectURL(result.url);
        }
        return;
      }
      imageUrls.current.set(pageNumber, result.url);
      setPageImages(new Map(imageUrls.current));
      // Arrived, so whatever it said last time no longer applies.
      setImageErrors((current) => {
        if (!current.has(pageNumber)) {
          return current;
        }
        const next = new Map(current);
        next.delete(pageNumber);
        return next;
      });
    }
    catch (error) {
      if (!signal.aborted) {
        setImageErrors((current) => new Map(current).set(
          pageNumber,
          error instanceof Error ? error.message : t('pdf_could_not_translate_image')
        ));
      }
    }
    finally {
      setImageTranslating((current) => {
        if (!current.has(pageNumber)) {
          return current;
        }
        const next = new Set(current);
        next.delete(pageNumber);
        return next;
      });
    }
  }, [api, t]);

  /**
   * Sends the pages on screen to be translated as pictures.
   *
   * Only the pages on screen, and only once each: a page already asked for is
   * in `imageUrls` whatever the answer was, including the answer "there is no
   * text on this one".
   */
  useEffect(() => {
    const controller = imageAbort.current;
    if (!target || !imageWanted || !controller) {
      return;
    }
    for (const pageNumber of shownPages) {
      const canvas = pageCanvases.current.get(pageNumber);
      // Drawn, and finished drawing: a canvas photographed halfway through
      // being painted is a page with half its glyphs on it.
      if (!canvas || !canvas.width || !paintedPages.has(pageNumber)) {
        continue;
      }
      if (imageUrls.current.has(pageNumber) || runningImages.current.has(pageNumber)) {
        continue;
      }
      runningImages.current.add(pageNumber);
      // Taken off as the request goes out, so one press means one forced
      // request rather than every request from here on.
      const forced = forcedImages.current.delete(pageNumber);
      void translatePageImage(pageNumber, canvas, target.mediaId, forced, controller.signal)
        .finally(() => {
          if (imageAbort.current === controller) {
            runningImages.current.delete(pageNumber);
          }
        });
    }
  }, [
    target, imageWanted, shownPages, paintedPages, translatePageImage,
    translationEpoch, retryEpoch
  ]);

  /**
   * Reads what is in the page box and turns to it.
   *
   * Anything that is not a page number puts the box back to the page being
   * read rather than complaining: a typo in a three-character box is not worth
   * an error message, and the page it is showing is the answer to it.
   */
  const goToTypedPage = useCallback(() => {
    const wanted = Number.parseInt(pageInput, 10);
    if (numPages === 0 || !Number.isFinite(wanted)) {
      setPageInput(String(page));
      return;
    }
    const next = Math.min(Math.max(1, wanted), numPages);
    // Set even when it is the page already open: it is what tidies "007" and a
    // number past the end of the document back into what was turned to.
    setPageInput(String(next));
    goToPage(next);
  }, [ pageInput, numPages, page, goToPage ]);

  // Opens the file where it was left. Once per file, and only once the page
  // count is known - a stored page from a file that has since been replaced by
  // a shorter one must not open past the end of it.
  useEffect(() => {
    if (!target || numPages === 0 || resumedFile.current === target.mediaId) {
      return;
    }
    resumedFile.current = target.mediaId;
    let cancelled = false;
    void (async () => {
      try {
        const stored = await api.getReadPdf(target.mediaId);
        if (cancelled || !stored) {
          return;
        }
        const resumeAt = Math.min(Math.max(1, stored.page), numPages);
        if (resumeAt > 1) {
          goToPage(resumeAt);
        }
      }
      catch (_error) {
        // Opening at page one is a perfectly good outcome; a history that
        // could not be read is not worth telling the reader about.
      }
    })();
    return () => { cancelled = true; };
  }, [ api, target, numPages, goToPage ]);

  // And remembers where they got to. Debounced, so paging - or scrolling -
  // through a document writes one entry rather than one per page.
  useEffect(() => {
    if (!target || numPages === 0) {
      return;
    }
    const timer = setTimeout(() => {
      void api.recordReadPdf(target.mediaId, page, numPages, target.postId)
        .catch(() => undefined);
    }, RECORD_PAGE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ api, target, page, numPages ]);

  const handleLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setFailed(false);
  }, []);

  const changeWidth = useCallback((delta: number) => {
    setWidthPercent((current) => {
      const next = clampWidthPercent(current + delta);
      storeWidthPercent(next);
      return next;
    });
  }, []);

  /**
   * Fills the screen with the reader.
   *
   * The browser's own fullscreen is what is asked for first - it is the only
   * thing that can take the address bar with it, which is the point of a
   * reader. Where it is refused (an iframe without the permission, an iPhone)
   * the dialog is grown to the whole window instead, which is the same layout
   * minus the browser's chrome.
   */
  const toggleFullscreen = useCallback(() => {
    const element = modalRef.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => setFullscreen(false));
      return;
    }
    if (fullscreen) {
      // Grown by the fallback rather than by the browser.
      setFullscreen(false);
      return;
    }
    setFullscreen(true);
    if (element?.requestFullscreen) {
      void element.requestFullscreen().catch(() => undefined);
    }
  }, [fullscreen]);

  // The browser has its own ways out of fullscreen - Escape, the window
  // controls - and none of them go through the button.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        setFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const handleClose = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    setFullscreen(false);
    onClose();
  }, [onClose]);

  const endPeek = useCallback(() => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
    setPeeking((current) => current ? false : current);
  }, []);

  /**
   * Hold the left button to see what is underneath the translation.
   *
   * A translation laid over a page is the page in your own language until you
   * want the original - a name, a number, a term that came out wrong - and
   * then it is in the way. Holding the button lifts it for as long as it is
   * held, which is quicker than turning the whole overlay off and back on.
   * The same gesture serves both overlays: the text one and the translated
   * picture of the whole page.
   *
   * Only for a mouse or a pen: a hold on a touchscreen is how a page is
   * scrolled and how text is selected, and it is not ours to take.
   */
  const startPeek = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!peekable || event.button !== 0 || event.pointerType === 'touch') {
      return;
    }
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current);
    }
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = null;
      setPeeking(true);
    }, PEEK_HOLD_MS);
  }, [peekable]);

  // Nothing is being covered any more, so nothing can be peeked at either.
  useEffect(() => {
    if (!peekable) {
      endPeek();
    }
  }, [ peekable, endPeek ]);

  useEffect(() => endPeek, [endPeek]);

  // Whole pixels only: a fractional width rounds up in the canvas and puts the
  // last column of the page under the edge of the tray.
  const fitWidth = containerWidth > 0 ? Math.max(240, Math.floor(containerWidth)) : 0;

  /**
   * The width the canvas is rasterised at, which is *not* the width it is
   * shown at.
   *
   * A canvas is a bitmap, and redrawing one is pdf.js drawing every glyph
   * again - far too slow to do while a resize is in flight. So the page is
   * drawn once, at the widest the stage can ever be, and every width after
   * that is a CSS scale of that bitmap. Because the drawn width is the maximum,
   * the scale is always downwards, and scaling a bitmap down is supersampling:
   * the more it shrinks the cleaner it gets. Nothing is ever drawn twice for a
   * resize, and nothing is ever scaled up and soft.
   *
   * It only ever grows - a viewport that gets wider raises the ceiling; one
   * that gets narrower leaves a bitmap that is simply more than is needed.
   *
   * Except where memory is what runs out first. There the viewport only ever
   * changes because the phone was turned, which is neither frequent nor free
   * of a re-layout anyway - and holding a landscape-sized bitmap for every
   * drawn page while reading in portrait is twice the memory for pixels
   * nothing is showing.
   */
  const [ renderWidth, setRenderWidth ] = useState(getMaxStageWidth);

  useEffect(() => {
    const measure = () => setRenderWidth((current) => {
      const wanted = Math.max(getMaxStageWidth(), fitWidth);
      return MEMORY_CONSTRAINED ? wanted : Math.max(current, wanted);
    });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [fitWidth]);

  // Two columns for the spread, and two for a page shown beside its
  // translated picture. Never both: the toolbar will not let them be on at
  // the same time.
  const columns = viewMode === 'spread' || sideBySideImages ? 2 : 1;
  // A page in either of those is never shown wider than half the stage, so
  // half is the most it is worth drawing - and a quarter of the memory of
  // drawing it as if it were alone on the page.
  const pageWidth = columns === 2 ? Math.ceil(renderWidth / 2) : renderWidth;
  const displayWidth = fitWidth > 0 ?
    Math.max(120, Math.floor((fitWidth - (columns - 1) * SPREAD_GAP) / columns)) : 0;
  // Never above 1: see above. Until the stage has been measured there is
  // nothing to scale to yet, so the pages wait rather than flashing full size.
  const displayScale = displayWidth > 0 ? Math.min(1, displayWidth / pageWidth) : 0;
  /** Nothing is laid out until the stage has been measured, so nothing is watched either. */
  const stageReady = displayScale > 0;

  /**
   * The shape a page that has not been drawn is assumed to have. See
   * {@link DEFAULT_PAGE_ASPECT} - the first page that loads speaks for the
   * rest, which is right for every document that is not a scrapbook.
   */
  const estimatedAspect = useMemo(() => {
    for (const loaded of loadedPages.values()) {
      if (loaded.originalWidth > 0) {
        return loaded.originalHeight / loaded.originalWidth;
      }
    }
    return DEFAULT_PAGE_ASPECT;
  }, [loadedPages]);

  // In the scrolling layout every page has a box from the start, so that the
  // scrollbar measures the document rather than the handful of pages drawn.
  const slots = useMemo(() => {
    if (viewMode !== 'scroll' || numPages === 0) {
      return renderedPages;
    }
    const result: number[] = [];
    for (let p = 1; p <= numPages; p++) {
      result.push(p);
    }
    return result;
  }, [ viewMode, numPages, renderedPages ]);

  /**
   * Puts a jump where it was aimed.
   *
   * The boxes it scrolled past were guessed heights, so the landing can be
   * out by a few pixels per page until the pages around it have been drawn.
   * Re-run as they are - and only a bounded number of times, so a page that
   * never loads cannot hold the scrollbar hostage.
   */
  useLayoutEffect(() => {
    const wanted = pendingScroll.current;
    if (!wanted || viewMode !== 'scroll') {
      return;
    }
    const stage = stageRef.current;
    const slot = slotRefs.current.get(wanted.page);
    if (!stage || !slot) {
      return;
    }
    const delta = slot.getBoundingClientRect().top - stage.getBoundingClientRect().top;
    if (Math.abs(delta) > 1) {
      selfScrolling.current = true;
      stage.scrollTop += delta;
    }
    wanted.attempts -= 1;
    if (loadedPages.has(wanted.page) || wanted.attempts <= 0) {
      pendingScroll.current = null;
    }
  }, [ viewMode, loadedPages, displayScale, numPages, page ]);

  /**
   * What the scrolling layout is showing, and which page it counts as read.
   *
   * Both are watched rather than measured. A thousand boxes cannot be asked
   * for their position on every scroll event without the reader feeling it,
   * and the browser is already tracking exactly this - so the first observer
   * reports which boxes are in the stage at all (that is what decides which
   * of them are drawn, and which are worth translating) and the second
   * watches a band a third of the way down it: whichever page is crossing
   * that band is the page being read, which is still the right answer while
   * the page before it is halfway out of the top of the screen.
   *
   * Both fire once on being set up, so entering the layout is also what
   * establishes where in it the reader is.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (viewMode !== 'scroll' || !stage || numPages === 0 || !stageReady) {
      return;
    }
    const pageOf = (target: Element) =>
      Number((target as HTMLElement).dataset.page) || 0;
    const seen = new Set<number>();
    const onView: IntersectionObserverCallback = (entries) => {
      for (const entry of entries) {
        const pageNumber = pageOf(entry.target);
        if (!pageNumber) {
          continue;
        }
        if (entry.isIntersecting) {
          seen.add(pageNumber);
        }
        else {
          seen.delete(pageNumber);
        }
      }
      if (seen.size === 0) {
        return;
      }
      const inView = [ ...seen ].sort((a, b) => a - b);
      setVisiblePages((current) => sameNumbers(current, inView) ? current : inView);
    };
    // Only pages that have just entered the band say anything; one leaving it
    // with nothing taking its place - the gap between two pages passing
    // through - leaves the page being read where it was.
    const onActive: IntersectionObserverCallback = (entries) => {
      let active = 0;
      for (const entry of entries) {
        const pageNumber = pageOf(entry.target);
        if (entry.isIntersecting && pageNumber && (active === 0 || pageNumber < active)) {
          active = pageNumber;
        }
      }
      if (active) {
        setPage((current) => current === active ? current : active);
      }
    };
    const top = Math.round(SCROLL_ACTIVE_OFFSET * 100);
    const viewObserver = new IntersectionObserver(onView, { root: stage });
    const activeObserver = new IntersectionObserver(onActive, {
      root: stage,
      rootMargin: `-${top}% 0px -${99 - top}% 0px`
    });
    for (const node of slotRefs.current.values()) {
      viewObserver.observe(node);
      activeObserver.observe(node);
    }
    return () => {
      viewObserver.disconnect();
      activeObserver.disconnect();
    };
  }, [ viewMode, numPages, stageReady, target?.url ]);

  // Dragging either edge. The dialog is centred, so it grows away from the
  // pointer by as much as it grows towards it - hence the doubled delta.
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>, direction: 1 | -1) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startPercent = widthPercent;
    const viewportWidth = window.innerWidth || PREFERRED_WIDTH_PX;
    let latest = startPercent;
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      const deltaPercent = (((moveEvent.clientX - startX) * 2 * direction) / viewportWidth) * 100;
      latest = clampWidthPercent(startPercent + deltaPercent);
      setWidthPercent(latest);
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      setResizing(false);
      storeWidthPercent(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }, [widthPercent]);

  // Tooltips and their like belong inside the dialog, because in fullscreen
  // the dialog is the only thing the browser is drawing - anything left on
  // `document.body` simply would not appear.
  const popupContainer = useCallback(
    () => modalRef.current ?? document.body,
    []
  );

  // The spread turns a page at a time, and its last useful position is the
  // pair that ends the document.
  const lastStart = viewMode === 'spread' && numPages > 1 ? numPages - 1 : numPages;

  const modeButton = (
    mode: ViewMode, icon: React.ReactNode, label: string, title: string, disabled = false
  ) => (
    <Tooltip title={title} getPopupContainer={popupContainer}>
      <Button
        type={viewMode === mode ? 'primary' : 'text'}
        size="small"
        icon={icon}
        aria-label={label}
        aria-pressed={viewMode === mode}
        disabled={disabled}
        onClick={() => changeViewMode(mode)}
      />
    </Tooltip>
  );

  const toolbar = (
    <div className="pdf-viewer__toolbar">
      <span className="pdf-viewer__filename" title={target?.filename}>
        {target?.filename}
      </span>
      <Space size={4} wrap>
        <Button
          type="text"
          size="small"
          icon={<LeftOutlined />}
          aria-label={t('pdf_previous_page')}
          disabled={page <= 1}
          onClick={() => goToPage(page - 1)}
        />
        <span className="pdf-viewer__page-jump">
          <Input
            className="pdf-viewer__page-input"
            size="small"
            value={pageInput}
            aria-label={t('pdf_go_to_page')}
            inputMode="numeric"
            disabled={numPages === 0}
            onChange={(e) => setPageInput(e.target.value)}
            // Committed on Enter, and again on the way out - a number typed
            // and then clicked away from is still a page someone asked for.
            onPressEnter={goToTypedPage}
            onBlur={goToTypedPage}
            // So the next thing typed replaces the page number rather than
            // being appended to it.
            onFocus={(e) => e.target.select()}
          />
          <span className="pdf-viewer__page-count">
            {numPages > 0 ? `/ ${numPages}` : '/ -'}
          </span>
        </span>
        <Button
          type="text"
          size="small"
          icon={<RightOutlined />}
          aria-label={t('pdf_next_page')}
          disabled={numPages === 0 || page >= lastStart}
          onClick={() => goToPage(page + 1)}
        />
        <span className="pdf-viewer__divider" />
        {modeButton('single', <FileOutlined />, t('pdf_single_page'), t('pdf_single_page_tip'))}
        {modeButton(
          'scroll',
          <ColumnHeightOutlined />,
          t('pdf_continuous_scroll'),
          t('pdf_continuous_scroll_tip')
        )}
        {modeButton(
          'spread',
          <ReadOutlined />,
          t('pdf_two_page_spread'),
          sideBySideImages ?
            t('pdf_spread_not_with_side_image') :
            t('pdf_spread_tip'),
          sideBySideImages
        )}
        <span className="pdf-viewer__divider" />
        <Button
          type="text"
          size="small"
          icon={<ZoomOutOutlined />}
          aria-label={t('pdf_narrower')}
          // Nothing to narrow: the page is already the width of the screen.
          disabled={fullBleed || widthPercent <= MIN_WIDTH_PERCENT}
          onClick={() => changeWidth(-WIDTH_STEP)}
        />
        <Button
          type="text"
          size="small"
          icon={<ColumnWidthOutlined />}
          aria-label={t('pdf_reset_width')}
          disabled={fullBleed}
          onClick={() => changeWidth(getDefaultWidthPercent() - widthPercent)}
        />
        <Button
          type="text"
          size="small"
          icon={<ZoomInOutlined />}
          aria-label={t('pdf_wider')}
          disabled={fullBleed || widthPercent >= MAX_WIDTH_PERCENT}
          onClick={() => changeWidth(WIDTH_STEP)}
        />
        <Tooltip
          title={fullscreen ? t('leave_fullscreen') : t('fullscreen')}
          getPopupContainer={popupContainer}
        >
          <Button
            type={fullscreen ? 'primary' : 'text'}
            size="small"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            aria-label={fullscreen ? t('leave_fullscreen') : t('fullscreen')}
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          />
        </Tooltip>
        {
          canTranslate ? (
            <Tooltip
              title={
                imageMode === 'immersive' ?
                  t('pdf_immersive_covered_by_image') :
                  t('pdf_immersive_tip')
              }
              getPopupContainer={popupContainer}
            >
              <Button
                // Follows what is actually on the page rather than the
                // remembered setting: while the picture covers it, this is
                // off, and it comes back when the picture goes.
                type={immersiveShown ? 'primary' : 'text'}
                size="small"
                icon={<TranslationOutlined />}
                aria-label={t('pdf_immersive_translation')}
                aria-pressed={immersiveShown}
                disabled={imageMode === 'immersive'}
                onClick={() => setImmersive((on) => {
                  storeFlag(IMMERSIVE_STORAGE_KEY, !on);
                  return !on;
                })}
              />
            </Tooltip>
          ) : null
        }
        {
          canTranslate ? (
            <Tooltip
              title={
                panelAvailable ?
                  t('pdf_panel_show') :
                  t('pdf_panel_not_in_spread')
              }
              getPopupContainer={popupContainer}
            >
              <Button
                type={panelVisible ? 'primary' : 'text'}
                size="small"
                icon={<ProfileOutlined />}
                aria-label={t('pdf_translation_panel')}
                aria-pressed={panelVisible}
                disabled={!panelAvailable}
                onClick={() => setPanelOpen((on) => {
                  storeFlag(PANEL_STORAGE_KEY, !on);
                  return !on;
                })}
              />
            </Tooltip>
          ) : null
        }
        {
          canTranslate ? (
            <Tooltip
              title={t('pdf_image_immersive_tip')}
              getPopupContainer={popupContainer}
            >
              <Button
                type={imageMode === 'immersive' ? 'primary' : 'text'}
                size="small"
                icon={<FileImageOutlined />}
                aria-label={t('pdf_image_immersive_translation')}
                aria-pressed={imageMode === 'immersive'}
                onClick={() => changeImageMode('immersive')}
              />
            </Tooltip>
          ) : null
        }
        {
          canTranslate ? (
            <Tooltip
              title={
                viewMode === 'spread' ?
                  t('pdf_side_img_not_in_spread') :
                  t('pdf_side_img_show')
              }
              getPopupContainer={popupContainer}
            >
              <Button
                type={sideBySideImages ? 'primary' : 'text'}
                size="small"
                icon={<SplitCellsOutlined />}
                aria-label={t('pdf_side_img_translation')}
                aria-pressed={sideBySideImages}
                disabled={viewMode === 'spread'}
                onClick={() => changeImageMode('side')}
              />
            </Tooltip>
          ) : null
        }
        {
          // Same reasoning as the download button: the routes behind it are
          // what refuse everyone else, this only keeps the toolbar honest.
          canDownload ? (
            <Tooltip title={t('translation_settings')} getPopupContainer={popupContainer}>
              <Button
                type="text"
                size="small"
                icon={<SettingOutlined />}
                aria-label={t('translation_settings')}
                onClick={() => setSettingsOpen(true)}
              />
            </Tooltip>
          ) : null
        }
        {
          // Hiding this from everyone else is only tidiness - the route that
          // hands out the ticket is what actually refuses them.
          canDownload && target ? (
            <Button
              type="text"
              size="small"
              icon={<DownloadOutlined />}
              aria-label={t('download')}
              onClick={() => requestDownload({
                url: target.url,
                mediaId: target.mediaId,
                filename: target.filename
              })}
            />
          ) : null
        }
      </Space>
    </div>
  );

  /**
   * The translation laid over one page.
   *
   * Blocks are measured at scale 1 and the page is drawn at `pageWidth`, so
   * the overlay is placed in drawn pixels and then scaled along with the page
   * by the wrapper it sits in - which is what keeps it registered with the
   * text underneath at every dialog width.
   */
  const renderOverlay = (pageNumber: number, loaded: LoadedPage | undefined) => {
    if (!canTranslate || !loaded || !(loaded.originalWidth > 0)) {
      return null;
    }
    const translation = pageTranslations.get(pageNumber);
    if (!translation) {
      return null;
    }
    // A highlight comes from the panel, which is only ever showing the page
    // being read.
    const highlighting = pageNumber === page && hoveredBlockId !== null;
    if (!immersiveShown && !highlighting) {
      return null;
    }
    const overlayScale = pageWidth / loaded.originalWidth;
    return (
      <div className="pdf-viewer__layer">
        {
          translation.blocks.map((block, index) => {
            const translated = translation.translations[index];
            const highlighted = highlighting && hoveredBlockId === block.id;
            // Without a translation there is nothing to lay over the original,
            // so the block is only ever a highlight.
            if (!highlighted && !(immersiveShown && translated)) {
              return null;
            }
            return (
              <div
                key={block.id}
                className={
                  'pdf-viewer__block' +
                  (immersiveShown && translated ? ' pdf-viewer__block--covered' : '') +
                  (highlighted ? ' pdf-viewer__block--highlighted' : '')
                }
                style={{
                  left: block.x * overlayScale,
                  top: block.y * overlayScale,
                  width: block.w * overlayScale,
                  height: block.h * overlayScale
                }}
              >
                {
                  immersiveShown && translated ? (
                    <FitText
                      text={translated}
                      fontSize={block.fontSize * overlayScale}
                      deps={overlayScale}
                    />
                  ) : null
                }
              </div>
            );
          })
        }
      </div>
    );
  };

  /**
   * The translated picture of a page, laid over it.
   *
   * The whole page in one image, so it goes over the canvas rather than being
   * placed block by block: Baidu has already done the placing, and what comes
   * back is the same page with different words printed in it. It sits inside
   * the scaled wrapper, so it is scaled with the page it covers and stays
   * registered with it at every width.
   */
  const renderImageOverlay = (pageNumber: number) => {
    const url = imageMode === 'immersive' ? pageImages.get(pageNumber) : null;
    if (!url) {
      return null;
    }
    return (
      <div className="pdf-viewer__image-layer">
        <img src={url} alt="" draggable={false} />
      </div>
    );
  };

  /**
   * One page: the box, and - for the handful being read - the page drawn in
   * it.
   *
   * The page is drawn wider than it is shown and scaled down, and a transform
   * does not change layout, so the box is what holds the space: it is sized
   * from the deck's width and its own shape rather than by what is inside it.
   * In the scrolling layout every page in the document has one whether or not
   * it has been drawn, which is what gives the column its height and the
   * scrollbar its meaning.
   */
  const renderPage = (pageNumber: number, options: { hidden: boolean; drawn: boolean }) => {
    const loaded = loadedPages.get(pageNumber);
    const aspect = loaded && loaded.originalWidth > 0 ?
      loaded.originalHeight / loaded.originalWidth : estimatedAspect;
    return (
      <PageSlot
        key={pageNumber}
        pageNumber={pageNumber}
        aspect={aspect}
        // The preloaded ones are drawn all the same: a canvas renders whether
        // or not anything is looking at it.
        hidden={options.hidden}
        slotRef={slotRef(pageNumber)}
        // Every page in the layout keeps the column, translated or not: one
        // that appeared and disappeared as pages went past would move the
        // whole column sideways every time.
        showSide={sideBySideImages && !options.hidden}
        sideUrl={pageImages.get(pageNumber)}
        sideBusy={imageTranslating.has(pageNumber)}
        sideFailed={imageErrors.has(pageNumber)}
        onRetry={retryPage}
      >
        {
          options.drawn ? (
            <div
              className="pdf-viewer__page-scale"
              style={{
                width: pageWidth,
                transform: `scale(${displayScale})`
              }}
            >
              <Page
                pageNumber={pageNumber}
                width={pageWidth}
                // Capped: the page is drawn once, so this is what decides what
                // it costs in memory.
                devicePixelRatio={
                  Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
                }
                // Annotations can carry links off to anywhere; the text layer
                // is kept so the page stays selectable.
                renderAnnotationLayer={false}
                loading={options.hidden ? <></> : <Spin />}
                // Held so the picture translation can photograph the page
                // rather than draw it a second time.
                canvasRef={canvasRef(pageNumber)}
                // Drawn, as opposed to merely opened: a canvas photographed
                // before this has half a page on it.
                onRenderSuccess={() => setPaintedPages(
                  (current) => new Map(current).set(
                    pageNumber, (current.get(pageNumber) ?? 0) + 1
                  )
                )}
                // Recorded for every page, not just the visible one: a
                // preloaded page fires this while it is still hidden and never
                // fires it again.
                onLoadSuccess={(callback) => setLoadedPages(
                  (current) => current.has(pageNumber) ? current :
                    new Map(current).set(pageNumber, callback as unknown as LoadedPage)
                )}
              />
              {options.hidden ? null : renderOverlay(pageNumber, loaded)}
              {options.hidden ? null : renderImageOverlay(pageNumber)}
            </div>
          ) : null
        }
      </PageSlot>
    );
  };

  const panel = panelVisible ? (
    <aside className="pdf-viewer__panel">
      <div className="pdf-viewer__panel-head">
        <span>{t('translation')}</span>
        {translatingPages.has(page) ? <Spin size="small" /> : null}
      </div>
      {
        // The banner over the page carries the message; here it is only worth
        // the offer to ask again for the page the panel is showing.
        translationError ? (
          <p className="pdf-viewer__panel-empty">
            <Button size="small" onClick={() => retryPages([page])}>
              {t('pdf_try_again')}
            </Button>
          </p>
        ) : null
      }
      {
        (() => {
          const translation = pageTranslations.get(page);
          if (!translation) {
            return null;
          }
          return (
            <>
              {
                translation.complete && translation.failed > 0 ? (
                  <p className="pdf-viewer__panel-empty">
                    {t('pdf_blocks_failed', {
                      failed: translation.failed,
                      total: translation.blocks.length
                    })}
                    {' '}
                    <Button
                      type="link"
                      size="small"
                      className="p-0"
                      onClick={() => retryPages([page])}
                    >
                      {t('pdf_try_again')}
                    </Button>
                  </p>
                ) : null
              }
              {
                translation.blocks.length === 0 && !translatingPages.has(page) ? (
                  <p className="pdf-viewer__panel-empty">
                    {t('pdf_panel_no_text')}
                  </p>
                ) : null
              }
              <ol className="pdf-viewer__panel-list">
                {
                  translation.blocks.map((block, index) => (
                    <li
                      key={block.id}
                      className={
                        `pdf-viewer__panel-item${hoveredBlockId === block.id ? ' pdf-viewer__panel-item--active' : ''}`
                      }
                      // Pointing at the translation points at where it came from.
                      onMouseEnter={() => setHoveredBlockId(block.id)}
                      onMouseLeave={() => setHoveredBlockId((current) => current === block.id ? null : current)}
                    >
                      {translation.translations[index] || block.text}
                    </li>
                  ))
                }
              </ol>
            </>
          );
        })()
      }
    </aside>
  ) : null;

  /**
   * The message the banner carries: whatever went wrong with a page that is
   * actually on screen. A failure on a page long since scrolled past is not
   * something to keep complaining about - which is also why the banner has no
   * close button. Turning the page puts it away, and closing it would have to
   * forget which pages failed, taking their "try again" with it.
   */
  const failureNotice = shownPages.reduce<string | null>(
    (found, pageNumber) => found ?? imageErrors.get(pageNumber) ?? null,
    null
  ) ?? translationError;

  const retryPage = useCallback(
    (pageNumber: number) => retryPages([pageNumber]),
    [retryPages]
  );

  const rootClassName = [
    'pdf-viewer',
    `pdf-viewer--${viewMode}`,
    resizing ? 'pdf-viewer--resizing' : '',
    fullscreen ? 'pdf-viewer--fullscreen' : '',
    fullBleed ? 'pdf-viewer--full-bleed' : '',
    peeking ? 'pdf-viewer--peeking' : ''
  ].filter(Boolean).join(' ');

  return (
    <>
    <Modal
      open={!!target}
      onCancel={handleClose}
      footer={null}
      centered
      // The second term keeps a margin either side even at the widest setting,
      // so the dialog itself can never push the page sideways either. In
      // fullscreen the dialog is the screen, and the same setting caps the
      // column of pages inside it instead.
      width={fullscreen ? '100vw' : `min(${widthPercent}vw, calc(100vw - 2rem))`}
      rootClassName={rootClassName}
      // Closing throws the reader away rather than hiding it. Left mounted,
      // the stage keeps an observer on a box that is display:none and the
      // document keeps a worker that has been torn down under it - and the
      // next open inherits both. Reopening costs a re-read of the file, which
      // is a few byte ranges out of the browser cache.
      destroyOnHidden
      title={toolbar}
    >
      <div
        className="pdf-viewer__resize-handle pdf-viewer__resize-handle--left"
        role="separator"
        aria-label={t('pdf_drag_to_resize')}
        onPointerDown={(e) => startResize(e, -1)}
      />
      <div
        className="pdf-viewer__resize-handle pdf-viewer__resize-handle--right"
        role="separator"
        aria-label={t('pdf_drag_to_resize')}
        onPointerDown={(e) => startResize(e, 1)}
      />
      <div className="pdf-viewer__body">
        <div
          className="pdf-viewer__stage"
          ref={setStageRef}
          onScroll={handleStageScroll}
          onPointerDown={startPeek}
          onPointerUp={endPeek}
          onPointerLeave={endPeek}
          onPointerCancel={endPeek}
        >
          <div
            className="pdf-viewer__pages"
            ref={setContainerRef}
            // What the width buttons mean once the dialog is the whole screen -
            // except on a phone, where the whole screen is barely a page wide
            // and the page is given all of it.
            style={fullscreen && !fullBleed ? { maxWidth: `${widthPercent}%` } : undefined}
          >
            {
              // Where a translation went wrong, either kind. The panel says so
              // too for the text, but the panel is often closed and the
              // overlay has nowhere of its own to say anything - and a
              // misconfigured account is exactly the case that must not fail
              // silently.
              failureNotice ? (
                <Alert
                  className="pdf-viewer__notice"
                  type="error"
                  showIcon
                  title={failureNotice}
                  action={
                    <Button size="small" onClick={() => retryPages(shownPages)}>
                      {t('pdf_try_again')}
                    </Button>
                  }
                />
              ) : null
            }
            {
              target ? (
                <Document
                  // Keyed so that opening the reader again is a new load rather
                  // than a component being reused across a close.
                  key={target.url}
                  file={target.url}
                  options={PDF_OPTIONS}
                  loading={<Spin size="large" />}
                  error={<div className="pdf-viewer__error">{t('pdf_could_not_open')}</div>}
                  onLoadError={() => setFailed(true)}
                  onLoadSuccess={handleLoadSuccess}
                >
                  {
                    !failed && displayScale > 0 ? (
                      <div
                        className="pdf-viewer__deck"
                        // The one place the laid-out page width is written,
                        // so that a resize touches one element rather than
                        // every page in the document. See {@link PageSlot}.
                        style={{
                          '--pdf-page-width': `${Math.round(pageWidth * displayScale)}px`
                        } as React.CSSProperties}
                      >
                        {
                          slots.map((pageNumber) => renderPage(pageNumber, {
                            // Everything in the scrolling column is on screen
                            // or on its way there; the other layouts keep
                            // their preloaded pages out of the way.
                            hidden: viewMode !== 'scroll' && !shownPages.includes(pageNumber),
                            drawn: renderedPages.includes(pageNumber)
                          }))
                        }
                      </div>
                    ) : null
                  }
                </Document>
              ) : null
            }
          </div>
        </div>
        {panel}
      </div>
    </Modal>
    <PdfTranslationSettingsModal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      // A different engine means different text, so what was translated with
      // the old one is dropped and the pages asked for again.
      onSaved={() => {
        translationCache.current.clear();
        setPageTranslations(new Map());
        setTranslationError(null);
        // The pictures were translated by the old credentials into the old
        // language; the server drops its own copies when the language
        // changes, and these are the reader's.
        releaseImages();
        setImageErrors(new Map());
        setTranslationEpoch((current) => current + 1);
      }}
    />
    </>
  );
}

export default PdfViewerModal;
