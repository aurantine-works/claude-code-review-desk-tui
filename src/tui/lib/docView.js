// The document as the body pane sees it: a "view" of the source lines.
//
// There are two views with the same interface. The *source* view shows the lines verbatim (the display offset of a
// character is its source offset). The *rendered* view (mdRender.js) shows Markdown half-rendered: still one display
// line per source line, but markers such as `**` or `#` are hidden and some characters are replaced or added.
//
// Everything that is stored or sent anywhere (anchors, quotes, drafts, what Claude receives) is based on SOURCE
// offsets. Display offsets exist only in layout, drawing, hit testing and the cursor; the helpers below convert at
// those boundaries:
//   toSrc(line, dOff)    display offset -> source offset (a synthetic character -> the nearest real one)
//   toDisp(line, sOff)   source offset  -> display offset (a hidden source character -> the next visible one)
//   covered(...)         does a source interval cover a display character (synthetic ones when both neighbours are)
//   srcRange(range)      a display range -> the source range of its real characters (null when it has none)
//
// View interface
//   kind        'source' | 'rendered'
//   lines       display text per line (what DocLayout wraps)
//   breaks      Map line -> display offsets where a new screen row must start, or null (wrapped table rows)
//   srcLines    source text per line
//   count, srcLen(line)
//   styler(line)  -> (dOff) => Style | null    base style of the display character (Markdown colours)
//   rowStyle(line) -> Style | null              fills the rest of the row (code block background)
//   toSrc, toDisp, synthetic, covered, srcRange
import { createHash } from 'node:crypto';
import { classifyLines, cellStyle, inlineCodeSpans } from './markdown.js';
import { renderMarkdown } from './mdRender.js';
import { spanLineInterval } from './selection.js';

const TEXT_INFO = { kind: 'text' };
const MARKER_KINDS = new Set(['text', 'list']);

/**
 * The verbatim view. `info` (classifyLines result) is computed on first use when not given.
 * @param {string[]} lines
 * @param {import('./markdown.js').LineInfo[]} [info]
 */
export function makeSourceView(lines, info) {
  let infos = info ?? null;
  const classes = () => (infos ??= classifyLines(lines));
  return {
    kind: 'source',
    lines,
    breaks: null,
    srcLines: lines,
    count: lines.length,
    srcLen: (line) => lines[line]?.length ?? 0,
    styler(line) {
      const inf = classes()[line] ?? TEXT_INFO;
      const code = MARKER_KINDS.has(inf.kind) || inf.kind === 'quote' ? inlineCodeSpans(lines[line] ?? '') : null;
      return (off) => cellStyle(inf, off, code);
    },
    rowStyle: () => null,
    toSrc: (_line, off) => off,
    toDisp: (_line, off) => off,
    synthetic: () => false,
    covered: (_line, off, from, to) => off >= from && off < to,
    srcRange: (range) => range,
  };
}

/**
 * The half-rendered view.
 * @param {string[]} lines  source lines
 * @param {{maxWidth: number}} opts  text columns of the pane
 */
export function makeRenderedView(lines, { maxWidth }) {
  const r = renderMarkdown(lines, { maxWidth });
  return {
    kind: 'rendered',
    lines: r.lines,
    breaks: r.breaks,
    srcLines: lines,
    count: lines.length,
    srcLen: r.srcLen,
    styler: (line) => {
      const runs = r.runs[line];
      let k = 0; // cells arrive left to right, so the previous run is usually still the right one
      return (off) => {
        if (runs.length === 0) return null;
        if (k >= runs.length) k = runs.length - 1;
        while (k > 0 && off < runs[k].from) k--;
        while (k < runs.length && off >= runs[k].to) k++;
        return k < runs.length ? runs[k].style : null;
      };
    },
    rowStyle: (line) => r.rowStyle[line],
    toSrc: r.toSrc,
    toDisp: r.toDisp,
    synthetic: r.synthetic,
    covered: r.covered,
    srcRange: r.srcRange,
  };
}

// Rendered documents are cached by (content hash, text width): re-opening a review or switching modes back and forth
// does not render again, and a resize only renders the widths it actually meets.
const CACHE_MAX = 12;
const renderedCache = new Map();

/**
 * Both views of a document, created lazily.
 * @param {string[]} lines  source lines
 * @param {{markdown?: boolean}} [opts]  false: this document is never rendered (source view only)
 */
export function createDocViews(lines, { markdown = true } = {}) {
  const source = makeSourceView(lines);
  let hash = null;
  const rendered = (width) => {
    if (!markdown) return source;
    hash ??= createHash('sha1').update(lines.join('\n')).digest('hex');
    const key = `${hash}:${width}`;
    let v = renderedCache.get(key);
    if (v) {
      renderedCache.delete(key); // refresh its place
    } else {
      v = makeRenderedView(lines, { maxWidth: width });
      if (renderedCache.size >= CACHE_MAX) renderedCache.delete(renderedCache.keys().next().value);
    }
    renderedCache.set(key, v);
    return v;
  };
  return {
    markdown,
    source,
    rendered,
    /** The view for a mode ('rendered' | 'source') at a text width; non-Markdown documents are always the source. */
    pick: (mode, width) => (markdown && mode === 'rendered' ? rendered(width) : source),
  };
}

/** Plan reviews and `.md` / `.markdown` / `.mdx` documents are rendered; everything else is shown as source. */
export function isMarkdownReview(meta) {
  if (!meta) return false;
  if (meta.kind === 'plan') return true;
  return /\.(md|markdown|mdx)$/i.test(String(meta.docPath ?? ''));
}

/** Accept a view or a bare array of source lines (the latter is the source view). */
export function asView(x) {
  return Array.isArray(x) ? makeSourceView(x) : x;
}

/**
 * Does the source span cover the display character at (line, dOff)? An end-of-line position counts as the end of the
 * source line, like selection.js spanCovers does.
 * @param {ReturnType<typeof makeSourceView>} dv
 * @param {import('./selection.js').Span} span
 */
export function viewCovers(dv, span, line, dOff) {
  const iv = spanLineInterval(span, line, dv.srcLen(line));
  if (!iv) return false;
  return iv.whole || dv.covered(line, dOff, iv.from, iv.to);
}
