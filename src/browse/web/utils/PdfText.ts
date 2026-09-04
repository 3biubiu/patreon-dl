import { pdfjs } from "react-pdf";

/**
 * Turns a PDF page into blocks of text with the box each one occupies.
 *
 * pdf.js hands back positioned fragments, not paragraphs: a fragment can be a
 * whole line, a word, or a single glyph, depending on what produced the file.
 * Translating those one by one would be both expensive and nonsense, so they
 * are joined back into lines and then into paragraphs here - and the box comes
 * out with them, because the reader lays the translation over the original.
 *
 * Coordinates are in CSS pixels at scale 1, origin top left. The reader
 * multiplies by whatever scale the page is currently drawn at, which changes
 * every time the dialog is resized - so nothing here may be in device pixels.
 */

/** Only the parts of pdf.js's `TextItem` this needs, so no type path is depended on. */
interface TextFragment {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
  fontName?: string;
}

interface PositionedFragment {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSize: number;
  hasEOL: boolean;
}

export interface PdfTextBlock {
  /** Stable within a page render, and used as the React key. */
  id: string;
  text: string;
  /** CSS pixels at scale 1. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Median glyph height of the block, for sizing the text laid over it. */
  fontSize: number;
}

interface PageLike {
  getViewport: (params: { scale: number }) => { transform: number[]; scale: number };
  getTextContent: () => Promise<{
    items: unknown[];
    styles?: Record<string, { ascent?: number }>;
  }>;
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Most Latin fonts sit around here, and it is only used when pdf.js has no figure. */
const FALLBACK_ASCENT = 0.8;

/** A new line once the baseline moves by more than this share of the text height. */
const LINE_BREAK_RATIO = 0.5;
/** Lines further apart than this - relative to their own size - start a paragraph. */
const PARAGRAPH_GAP_RATIO = 0.8;
/** How far a line may be indented before it reads as the start of a new paragraph. */
const PARAGRAPH_INDENT_RATIO = 1.5;
/** A gap this wide between fragments on one line stands in for a missing space. */
const WORD_GAP_RATIO = 0.2;

function isFragment(item: unknown): item is TextFragment {
  return !!item && typeof item === 'object' && typeof (item as TextFragment).str === 'string';
}

/** True when a space between these two would be wrong - CJK sets its own spacing. */
function joinsWithoutSpace(before: string, after: string) {
  const last = before.slice(-1);
  const first = after.slice(0, 1);
  if (!last || !first) {
    return true;
  }
  if (/\s/.test(last) || /\s/.test(first)) {
    return true;
  }
  return CJK.test(last) || CJK.test(first);
}

function joinLines(lines: string[]) {
  return lines.reduce((result, line) => {
    if (!result) {
      return line;
    }
    // A word broken across lines is put back together rather than translated
    // as two halves.
    if (/[A-Za-z]-$/.test(result)) {
      return result.slice(0, -1) + line;
    }
    return joinsWithoutSpace(result, line) ? result + line : `${result} ${line}`;
  }, '');
}

/**
 * Fragments in the order pdf.js reports them, which is the order the page was
 * drawn in and so, for all but the most adversarial files, reading order.
 */
function positionFragments(
  items: unknown[],
  transform: number[],
  styles?: Record<string, { ascent?: number }>
): PositionedFragment[] {
  const result: PositionedFragment[] = [];
  for (const item of items) {
    if (!isFragment(item) || item.str.length === 0) {
      continue;
    }
    const tx = pdfjs.Util.transform(transform, item.transform) as number[];
    const fontSize = Math.hypot(tx[2], tx[3]);
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      continue;
    }
    const ascent = (item.fontName ? styles?.[item.fontName]?.ascent : undefined) || FALLBACK_ASCENT;
    const top = tx[5] - fontSize * ascent;
    result.push({
      text: item.str,
      left: tx[4],
      top,
      right: tx[4] + item.width,
      bottom: top + fontSize,
      fontSize,
      hasEOL: item.hasEOL
    });
  }
  return result;
}

interface Line {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontSize: number;
}

function buildLines(fragments: PositionedFragment[]): Line[] {
  const lines: Line[] = [];
  let current: PositionedFragment[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    let text = '';
    for (let i = 0; i < current.length; i++) {
      const fragment = current[i];
      if (i > 0) {
        const previous = current[i - 1];
        const gap = fragment.left - previous.right;
        const needsSpace = gap > previous.fontSize * WORD_GAP_RATIO &&
          !joinsWithoutSpace(text, fragment.text);
        if (needsSpace) {
          text += ' ';
        }
      }
      text += fragment.text;
    }
    if (text.trim().length > 0) {
      lines.push({
        text: text.trim(),
        left: Math.min(...current.map((f) => f.left)),
        top: Math.min(...current.map((f) => f.top)),
        right: Math.max(...current.map((f) => f.right)),
        bottom: Math.max(...current.map((f) => f.bottom)),
        // The tallest fragment, so a line with a dropped capital or a
        // superscript is still sized by its body text.
        fontSize: current.map((f) => f.fontSize).sort((a, b) => b - a)[
          Math.floor(current.length / 2)
        ] ?? current[0].fontSize
      });
    }
    current = [];
  };

  for (const fragment of fragments) {
    const previous = current[current.length - 1];
    if (previous) {
      const movedDown = Math.abs(fragment.top - previous.top) >
        Math.max(fragment.fontSize, previous.fontSize) * LINE_BREAK_RATIO;
      // Wrapping back to the left edge is a new line even when the baseline
      // barely moved, which is what a tight leading looks like.
      const wrapped = fragment.left < previous.left - previous.fontSize;
      if (previous.hasEOL || movedDown || wrapped) {
        flush();
      }
    }
    current.push(fragment);
  }
  flush();
  return lines;
}

function buildBlocks(lines: Line[], pageNumber: number): PdfTextBlock[] {
  const blocks: PdfTextBlock[] = [];
  let group: Line[] = [];

  const flush = () => {
    if (group.length === 0) {
      return;
    }
    const x = Math.min(...group.map((l) => l.left));
    const y = Math.min(...group.map((l) => l.top));
    const right = Math.max(...group.map((l) => l.right));
    const bottom = Math.max(...group.map((l) => l.bottom));
    blocks.push({
      id: `p${pageNumber}b${blocks.length}`,
      text: joinLines(group.map((l) => l.text)),
      x,
      y,
      w: right - x,
      h: bottom - y,
      fontSize: group.map((l) => l.fontSize).sort((a, b) => a - b)[Math.floor(group.length / 2)]
    });
    group = [];
  };

  for (const line of lines) {
    const previous = group[group.length - 1];
    if (previous) {
      const gap = line.top - previous.bottom;
      const sameColumn = Math.abs(line.left - previous.left) <
        previous.fontSize * PARAGRAPH_INDENT_RATIO;
      const sameSize = Math.abs(line.fontSize - previous.fontSize) < previous.fontSize * 0.3;
      if (gap > previous.fontSize * PARAGRAPH_GAP_RATIO || !sameColumn || !sameSize) {
        flush();
      }
    }
    group.push(line);
  }
  flush();
  return blocks;
}

/**
 * The page's text as translatable blocks. Empty for a scanned page - one with
 * no text layer at all - which is the caller's cue to say so rather than to
 * show an empty translation.
 */
export async function extractPageBlocks(
  page: PageLike, pageNumber: number
): Promise<PdfTextBlock[]> {
  const viewport = page.getViewport({ scale: 1 });
  const { items, styles } = await page.getTextContent();
  const fragments = positionFragments(items, viewport.transform, styles);
  return buildBlocks(buildLines(fragments), pageNumber);
}
