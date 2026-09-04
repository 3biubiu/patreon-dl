import "../assets/styles/PdfViewer.scss";
import "react-pdf/dist/Page/TextLayer.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space, Spin, Tooltip } from "antd";
import {
  LeftOutlined,
  RightOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  ColumnWidthOutlined,
  DownloadOutlined,
  TranslationOutlined,
  ProfileOutlined,
  SettingOutlined
} from "@ant-design/icons";
import { Document, Page, pdfjs } from "react-pdf";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";
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
  standardFontDataUrl: '/assets/pdfjs/standard_fonts/'
};

/**
 * The dialog is sized as a share of the viewport rather than in pixels, and
 * the page is always drawn to whatever width that leaves. Between them there
 * is no setting at which the reader can be made to scroll sideways: widening
 * the dialog is what zooming in means here, and the page follows the window
 * whenever it is resized.
 */
const MIN_WIDTH_PERCENT = 40;
const MAX_WIDTH_PERCENT = 96;
const WIDTH_STEP = 6;
/** Matches the old fixed `min(1100px, 92vw)`, expressed as a share instead. */
const PREFERRED_WIDTH_PX = 1100;
const FALLBACK_WIDTH_PERCENT = 92;

const WIDTH_STORAGE_KEY = 'patreon-dl.pdfViewerWidthPercent';

/**
 * How many pages ahead of the one being read are drawn in advance.
 *
 * They are mounted, hidden, at the same width as the visible page, so pdf.js
 * has already rasterised them by the time the reader asks for one - turning a
 * page becomes showing a canvas that exists rather than rendering one. Three
 * covers reading at a normal pace without holding a whole document's worth of
 * canvases in memory.
 */
const DEFAULT_PRELOAD_PAGES = 3;

/**
 * The two ways a translation is shown, remembered separately because they are
 * not alternatives: the overlay is for reading the page as if it were in your
 * own language, the panel is for reading the translation as prose beside the
 * original. Either, both, or neither.
 */
const IMMERSIVE_STORAGE_KEY = 'patreon-dl.pdfViewerImmersive';
const PANEL_STORAGE_KEY = 'patreon-dl.pdfViewerTranslationPanel';

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
 */
const MAX_DEVICE_PIXEL_RATIO = 2;

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
}

interface PageTranslation {
  blocks: PdfTextBlock[];
  /** One per block, in step with it. `null` where Google gave nothing back. */
  translations: (string | null)[];
  /** Blocks that came back with nothing; the original is shown for those. */
  failed: number;
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

export interface PdfViewerTarget {
  /** What the reader loads. Carries `lapid` for a linked attachment. */
  url: string;
  /** Named separately from the URL: it is what a download ticket is asked for. */
  mediaId: string;
  filename: string;
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
  const { user } = useAuth();
  const [ numPages, setNumPages ] = useState(0);
  const [ page, setPage ] = useState(1);
  const [ widthPercent, setWidthPercent ] = useState(readStoredWidthPercent);
  const [ containerWidth, setContainerWidth ] = useState(0);
  const [ resizing, setResizing ] = useState(false);
  const [ failed, setFailed ] = useState(false);
  const [ askingForCode, setAskingForCode ] = useState(false);
  const [ code, setCode ] = useState('');
  const [ requestingTicket, setRequestingTicket ] = useState(false);
  const [ codeError, setCodeError ] = useState<string | null>(null);
  const [ immersive, setImmersive ] = useState(() => readStoredFlag(IMMERSIVE_STORAGE_KEY));
  const [ panelOpen, setPanelOpen ] = useState(() => readStoredFlag(PANEL_STORAGE_KEY));
  const [ pageTranslation, setPageTranslation ] = useState<PageTranslation | null>(null);
  const [ translating, setTranslating ] = useState(false);
  const [ translationError, setTranslationError ] = useState<string | null>(null);
  const [ hoveredBlockId, setHoveredBlockId ] = useState<string | null>(null);
  const [ settingsOpen, setSettingsOpen ] = useState(false);
  // Every page pdf.js has opened, preloaded ones included. Keyed rather than
  // held singly because a page that was preloaded has already fired its load
  // callback by the time it is turned to, and will not fire it again.
  const [ loadedPages, setLoadedPages ] = useState(new Map<number, LoadedPage>());
  const observerRef = useRef<ResizeObserver | null>(null);
  // Kept for the life of one open document: turning back a page must not ask
  // the server again, and the server's own store is a network round trip away.
  const translationCache = useRef(new Map<number, PageTranslation>());
  const canDownload = user?.role === 'admin';
  const translationWanted = immersive || panelOpen;

  // A callback ref, because the element only exists while the modal is open.
  // `ResizeObserver` reports the content box, so what comes back is the room
  // actually left for the page - padding, and any vertical scrollbar, already
  // taken off.
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  useEffect(() => {
    setNumPages(0);
    setPage(1);
    setFailed(false);
    setAskingForCode(false);
    setCode('');
    setCodeError(null);
    translationCache.current.clear();
    setPageTranslation(null);
    setTranslationError(null);
    setLoadedPages(new Map());
  }, [target?.url]);

  // The page whose text is being read is the visible one; the preloaded ones
  // are drawn but not translated. Reset on a page turn so an overlay from the
  // page just left cannot be shown over the new one for a frame.
  useEffect(() => {
    setHoveredBlockId(null);
    setPageTranslation(translationCache.current.get(page) || null);
    setTranslationError(null);
  }, [page]);

  const loadedPage = loadedPages.get(page) || null;

  useEffect(() => {
    if (!target || !translationWanted || !loadedPage || pageTranslation) {
      return;
    }
    const abortController = new AbortController();
    setTranslating(true);
    setTranslationError(null);
    void (async () => {
      try {
        const blocks = await extractPageBlocks(loadedPage, page);
        if (abortController.signal.aborted) {
          return;
        }
        // A scanned page has no text layer to translate. Recorded as an empty
        // result all the same, so it is not asked for again on every render.
        let result: PageTranslation = { blocks, translations: [], failed: 0 };
        if (blocks.length > 0) {
          const response = await api.translatePdfPage(
            target.mediaId,
            blocks.map((block) => block.text),
            undefined,
            abortController.signal
          );
          result = { blocks, translations: response.translations, failed: response.failed };
        }
        if (abortController.signal.aborted) {
          return;
        }
        translationCache.current.set(page, result);
        setPageTranslation(result);
      }
      catch (error) {
        if (!abortController.signal.aborted) {
          setTranslationError(error instanceof Error ? error.message : 'Could not translate this page');
        }
      }
      finally {
        if (!abortController.signal.aborted) {
          setTranslating(false);
        }
      }
    })();

    return () => abortController.abort();
  }, [api, target, page, translationWanted, loadedPage, pageTranslation]);

  /**
   * Turns the code into a ticket, then navigates to the file with it.
   *
   * A plain navigation rather than a `fetch` or an `<a download>`: the answer
   * is a `Content-Disposition` attachment, so the browser saves it and leaves
   * the reader open behind it - and the file is never pulled into memory on
   * its way to disk.
   */
  const startDownload = useCallback(() => {
    if (!target) {
      return;
    }
    setRequestingTicket(true);
    setCodeError(null);
    void (async () => {
      try {
        const { token } = await api.createDownloadTicket(target.mediaId, code);
        const url = new URL(target.url, window.location.origin);
        url.searchParams.set('dl', '1');
        url.searchParams.set('dlt', token);
        window.location.href = url.toString();
        setAskingForCode(false);
        setCode('');
      }
      catch (error) {
        setCodeError(error instanceof Error ? error.message : 'Could not start the download');
      }
      finally {
        setRequestingTicket(false);
      }
    })();
  }, [api, code, target]);

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
   */
  const [ renderWidth, setRenderWidth ] = useState(getMaxStageWidth);

  useEffect(() => {
    const raise = () => setRenderWidth(
      (current) => Math.max(current, getMaxStageWidth(), fitWidth)
    );
    raise();
    window.addEventListener('resize', raise);
    return () => window.removeEventListener('resize', raise);
  }, [fitWidth]);

  const pageWidth = renderWidth;
  // Never above 1: see above. Until the stage has been measured there is
  // nothing to scale to yet, so the page waits rather than flashing full size.
  const displayScale = fitWidth > 0 ? Math.min(1, fitWidth / renderWidth) : 0;

  // The page being read, followed by the ones drawn ahead of it. Keyed by page
  // number when rendered, so turning a page keeps the ones already drawn
  // mounted and only the page that has fallen out of the window is discarded.
  //
  // Unaffected by a resize: the pages are drawn at a fixed width and scaled, so
  // there is no work here for a drag to interrupt.
  const mountedPages = useMemo(() => {
    const last = numPages > 0 ?
      Math.min(numPages, page + Math.max(0, preloadPages)) : page;
    const result: number[] = [];
    for (let p = page; p <= last; p++) {
      result.push(p);
    }
    return result;
  }, [page, numPages, preloadPages]);

  const toolbar = (
    <div className="pdf-viewer__toolbar">
      <span className="pdf-viewer__filename" title={target?.filename}>
        {target?.filename}
      </span>
      <Space size={4}>
        <Button
          type="text"
          size="small"
          icon={<LeftOutlined />}
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        />
        <span className="pdf-viewer__page-count">
          {numPages > 0 ? `${page} / ${numPages}` : '-'}
        </span>
        <Button
          type="text"
          size="small"
          icon={<RightOutlined />}
          aria-label="Next page"
          disabled={numPages === 0 || page >= numPages}
          onClick={() => setPage((current) => Math.min(numPages, current + 1))}
        />
        <Button
          type="text"
          size="small"
          icon={<ZoomOutOutlined />}
          aria-label="Narrower"
          disabled={widthPercent <= MIN_WIDTH_PERCENT}
          onClick={() => changeWidth(-WIDTH_STEP)}
        />
        <Button
          type="text"
          size="small"
          icon={<ColumnWidthOutlined />}
          aria-label="Reset width"
          onClick={() => changeWidth(getDefaultWidthPercent() - widthPercent)}
        />
        <Button
          type="text"
          size="small"
          icon={<ZoomInOutlined />}
          aria-label="Wider"
          disabled={widthPercent >= MAX_WIDTH_PERCENT}
          onClick={() => changeWidth(WIDTH_STEP)}
        />
        <Tooltip title="Overlay the translation on the page">
          <Button
            type={immersive ? 'primary' : 'text'}
            size="small"
            icon={<TranslationOutlined />}
            aria-label="Immersive translation"
            aria-pressed={immersive}
            onClick={() => setImmersive((on) => {
              storeFlag(IMMERSIVE_STORAGE_KEY, !on);
              return !on;
            })}
          />
        </Tooltip>
        <Tooltip title="Show the translation beside the page">
          <Button
            type={panelOpen ? 'primary' : 'text'}
            size="small"
            icon={<ProfileOutlined />}
            aria-label="Translation panel"
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen((on) => {
              storeFlag(PANEL_STORAGE_KEY, !on);
              return !on;
            })}
          />
        </Tooltip>
        {
          // Same reasoning as the download button: the routes behind it are
          // what refuse everyone else, this only keeps the toolbar honest.
          canDownload ? (
            <Tooltip title="Translation settings">
              <Button
                type="text"
                size="small"
                icon={<SettingOutlined />}
                aria-label="Translation settings"
                onClick={() => setSettingsOpen(true)}
              />
            </Tooltip>
          ) : null
        }
        {
          // Hiding this from everyone else is only tidiness - the route that
          // hands out the ticket is what actually refuses them.
          canDownload ? (
            <Button
              type="text"
              size="small"
              icon={<DownloadOutlined />}
              aria-label="Download"
              onClick={() => {
                setCodeError(null);
                setAskingForCode(true);
              }}
            />
          ) : null
        }
      </Space>
    </div>
  );

  // Blocks are measured at scale 1; the page is drawn at whatever the current
  // width works out to. Recomputed rather than cached, because that width
  // changes every time the dialog is resized.
  const overlayScale = pageWidth && loadedPage?.originalWidth ?
    pageWidth / loadedPage.originalWidth : 0;

  const overlay = overlayScale > 0 && pageTranslation && (immersive || hoveredBlockId) ? (
    <div className="pdf-viewer__layer">
      {
        pageTranslation.blocks.map((block, index) => {
          const translated = pageTranslation.translations[index];
          const highlighted = hoveredBlockId === block.id;
          // Without a translation there is nothing to lay over the original,
          // so the block is only ever a highlight.
          if (!highlighted && !(immersive && translated)) {
            return null;
          }
          return (
            <div
              key={block.id}
              className={
                'pdf-viewer__block' +
                (immersive && translated ? ' pdf-viewer__block--covered' : '') +
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
                immersive && translated ? (
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
  ) : null;

  const panel = panelOpen ? (
    <aside className="pdf-viewer__panel">
      <div className="pdf-viewer__panel-head">
        <span>Translation</span>
        {translating ? <Spin size="small" /> : null}
      </div>
      {
        translationError ? (
          <Alert type="error" showIcon title={translationError} className="m-2" />
        ) : null
      }
      {
        pageTranslation && pageTranslation.failed > 0 ? (
          <p className="pdf-viewer__panel-empty">
            {pageTranslation.failed} of {pageTranslation.blocks.length} blocks could not be
            translated - the original is shown for those.
          </p>
        ) : null
      }
      {
        pageTranslation && pageTranslation.blocks.length === 0 && !translating ? (
          <p className="pdf-viewer__panel-empty">
            No text on this page - a scanned page has nothing to translate.
          </p>
        ) : null
      }
      <ol className="pdf-viewer__panel-list">
        {
          pageTranslation?.blocks.map((block, index) => (
            <li
              key={block.id}
              className={
                `pdf-viewer__panel-item${hoveredBlockId === block.id ? ' pdf-viewer__panel-item--active' : ''}`
              }
              // Pointing at the translation points at where it came from.
              onMouseEnter={() => setHoveredBlockId(block.id)}
              onMouseLeave={() => setHoveredBlockId((current) => current === block.id ? null : current)}
            >
              {pageTranslation.translations[index] || block.text}
            </li>
          ))
        }
      </ol>
    </aside>
  ) : null;

  const codePrompt = (
    <Modal
      open={askingForCode}
      title="Download code"
      okText="Download"
      centered
      width={360}
      confirmLoading={requestingTicket}
      okButtonProps={{ disabled: !code }}
      onOk={startDownload}
      onCancel={() => {
        setAskingForCode(false);
        setCode('');
        setCodeError(null);
      }}
    >
      <p className="text-body-secondary">
        {target?.filename}
      </p>
      <Input.Password
        value={code}
        autoFocus
        inputMode="numeric"
        placeholder="Enter the download code"
        onChange={(e) => {
          setCode(e.target.value);
          setCodeError(null);
        }}
        onPressEnter={() => { if (code && !requestingTicket) { startDownload(); } }}
      />
      {
        codeError ? (
          <Alert className="mt-3" type="error" showIcon title={codeError} />
        ) : null
      }
    </Modal>
  );

  return (
    <>
    <Modal
      open={!!target}
      onCancel={onClose}
      footer={null}
      centered
      // The second term keeps a margin either side even at the widest setting,
      // so the dialog itself can never push the page sideways either.
      width={`min(${widthPercent}vw, calc(100vw - 2rem))`}
      rootClassName={`pdf-viewer ${resizing ? 'pdf-viewer--resizing' : ''}`}
      title={toolbar}
    >
      <div
        className="pdf-viewer__resize-handle pdf-viewer__resize-handle--left"
        role="separator"
        aria-label="Drag to resize"
        onPointerDown={(e) => startResize(e, -1)}
      />
      <div
        className="pdf-viewer__resize-handle pdf-viewer__resize-handle--right"
        role="separator"
        aria-label="Drag to resize"
        onPointerDown={(e) => startResize(e, 1)}
      />
      <div className="pdf-viewer__body">
        <div className="pdf-viewer__stage" ref={setContainerRef}>
          {
            target ? (
              <Document
                file={target.url}
                options={PDF_OPTIONS}
                loading={<Spin size="large" />}
                error={<div className="pdf-viewer__error">Could not open this PDF.</div>}
                onLoadError={() => setFailed(true)}
                onLoadSuccess={handleLoadSuccess}
              >
                {
                  !failed && displayScale > 0 ? mountedPages.map((pageNumber) => {
                    const loaded = loadedPages.get(pageNumber);
                    const aspect = loaded && loaded.originalWidth > 0 ?
                      loaded.originalHeight / loaded.originalWidth : null;
                    return (
                      <div
                        key={pageNumber}
                        className="pdf-viewer__page"
                        // The preloaded ones are drawn all the same: a canvas
                        // renders whether or not anything is looking at it.
                        hidden={pageNumber !== page}
                        // The drawn page is wider than it is shown, and a
                        // transform does not change layout - so the box has to
                        // be told the size the scaled page actually occupies,
                        // or it would reserve the full drawn width.
                        style={{
                          width: Math.round(pageWidth * displayScale),
                          height: aspect ?
                            Math.round(pageWidth * aspect * displayScale) : undefined
                        }}
                      >
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
                            // Capped: the page is drawn once, so this is what
                            // decides what it costs in memory.
                            devicePixelRatio={
                              Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO)
                            }
                            // Annotations can carry links off to anywhere; the
                            // text layer is kept so the page stays selectable.
                            renderAnnotationLayer={false}
                            loading={pageNumber === page ? <Spin /> : <></>}
                            // Recorded for every page, not just the visible
                            // one: a preloaded page fires this while it is
                            // still hidden and never fires it again.
                            onLoadSuccess={(callback) => setLoadedPages(
                              (current) => current.has(pageNumber) ? current :
                                new Map(current).set(pageNumber, callback as unknown as LoadedPage)
                            )}
                          />
                          {pageNumber === page ? overlay : null}
                        </div>
                      </div>
                    );
                  }) : null
                }
              </Document>
            ) : null
          }
        </div>
        {panel}
      </div>
    </Modal>
    {codePrompt}
    <PdfTranslationSettingsModal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      // A different engine means different text, so what was translated with
      // the old one is dropped and the page asked for again.
      onSaved={() => {
        translationCache.current.clear();
        setPageTranslation(null);
        setTranslationError(null);
      }}
    />
    </>
  );
}

export default PdfViewerModal;
