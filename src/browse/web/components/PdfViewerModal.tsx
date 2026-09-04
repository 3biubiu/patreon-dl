import "../assets/styles/PdfViewer.scss";
import "react-pdf/dist/Page/TextLayer.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space, Spin } from "antd";
import {
  LeftOutlined,
  RightOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  ColumnWidthOutlined,
  DownloadOutlined
} from "@ant-design/icons";
import { Document, Page, pdfjs } from "react-pdf";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useAPI } from "../contexts/APIProvider";
import { useAuth } from "../contexts/AuthProvider";

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
  const observerRef = useRef<ResizeObserver | null>(null);
  const canDownload = user?.role === 'admin';

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
  }, [target?.url]);

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
  const pageWidth = containerWidth > 0 ? Math.max(240, Math.floor(containerWidth)) : undefined;

  // The page being read, followed by the ones drawn ahead of it. Keyed by page
  // number when rendered, so turning a page keeps the ones already drawn
  // mounted and only the page that has fallen out of the window is discarded.
  //
  // Nothing is preloaded mid-drag: every page mounted here is redrawn on each
  // width the resize passes through, and the ones nobody is looking at can
  // wait until the pointer is up.
  const mountedPages = useMemo(() => {
    const last = numPages > 0 ?
      Math.min(numPages, page + (resizing ? 0 : Math.max(0, preloadPages))) : page;
    const result: number[] = [];
    for (let p = page; p <= last; p++) {
      result.push(p);
    }
    return result;
  }, [page, numPages, preloadPages, resizing]);

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
      <div className="pdf-viewer__body" ref={setContainerRef}>
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
                !failed && pageWidth ? mountedPages.map((pageNumber) => (
                  <div
                    key={pageNumber}
                    className="pdf-viewer__page"
                    // The preloaded ones are drawn all the same: a canvas
                    // renders whether or not anything is looking at it.
                    hidden={pageNumber !== page}
                  >
                    <Page
                      pageNumber={pageNumber}
                      width={pageWidth}
                      // Annotations can carry links off to anywhere; the text
                      // layer is kept so the page stays selectable.
                      renderAnnotationLayer={false}
                      loading={pageNumber === page ? <Spin /> : <></>}
                    />
                  </div>
                )) : null
              }
            </Document>
          ) : null
        }
      </div>
    </Modal>
    {codePrompt}
    </>
  );
}

export default PdfViewerModal;
