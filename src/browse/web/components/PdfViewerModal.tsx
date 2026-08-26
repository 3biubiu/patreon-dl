import "../assets/styles/PdfViewer.scss";
import "react-pdf/dist/Page/TextLayer.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Space, Spin } from "antd";
import {
  LeftOutlined,
  RightOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  ExpandOutlined
} from "@ant-design/icons";
import { Document, Page, pdfjs } from "react-pdf";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;

export interface PdfViewerTarget {
  url: string;
  filename: string;
}

interface PdfViewerModalProps {
  target: PdfViewerTarget | null;
  onClose: () => void;
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
  const { target, onClose } = props;
  const [ numPages, setNumPages ] = useState(0);
  const [ page, setPage ] = useState(1);
  const [ scale, setScale ] = useState(1);
  const [ containerWidth, setContainerWidth ] = useState(0);
  const [ failed, setFailed ] = useState(false);
  const observerRef = useRef<ResizeObserver | null>(null);

  // A callback ref, because the element only exists while the modal is open.
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      return;
    }
    setContainerWidth(node.clientWidth);
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
    setScale(1);
    setFailed(false);
  }, [target?.url]);

  const handleLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setFailed(false);
  }, []);

  const zoom = useCallback((delta: number) => {
    setScale((current) => Math.min(
      MAX_SCALE, Math.max(MIN_SCALE, Math.round((current + delta) * 100) / 100)
    ));
  }, []);

  const pageWidth = containerWidth > 0 ?
    Math.max(240, (containerWidth - 32) * scale) : undefined;

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
          aria-label="Zoom out"
          disabled={scale <= MIN_SCALE}
          onClick={() => zoom(-SCALE_STEP)}
        />
        <Button
          type="text"
          size="small"
          icon={<ExpandOutlined />}
          aria-label="Fit to width"
          onClick={() => setScale(1)}
        />
        <Button
          type="text"
          size="small"
          icon={<ZoomInOutlined />}
          aria-label="Zoom in"
          disabled={scale >= MAX_SCALE}
          onClick={() => zoom(SCALE_STEP)}
        />
      </Space>
    </div>
  );

  return (
    <Modal
      open={!!target}
      onCancel={onClose}
      footer={null}
      centered
      width="min(1100px, 92vw)"
      rootClassName="pdf-viewer"
      title={toolbar}
    >
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
                !failed && pageWidth ? (
                  <Page
                    pageNumber={page}
                    width={pageWidth}
                    // Annotations can carry links off to anywhere; the text
                    // layer is kept so the page stays selectable.
                    renderAnnotationLayer={false}
                    loading={<Spin />}
                  />
                ) : null
              }
            </Document>
          ) : null
        }
      </div>
    </Modal>
  );
}

export default PdfViewerModal;
