// Selections, spans and anchors.
//
// Coordinates here are *document* coordinates: 0-based line indexes and UTF-16 offsets inside the line. Anchors in the store use 1-based lines; `rangeToSel` / `linesToSel` convert at
// the boundary.

/** @typedef {{line: number, off: number}} Pos */
/** @typedef {{start: Pos, end: Pos}} Range  half-open: `end` is exclusive */
/** @typedef {{l0: number, l1: number, c0: number | null, c1: number | null}} Span  lines inclusive; null columns = whole lines */

const cmp = (a, b) => a.line - b.line || a.off - b.off;

/**
 * Normalise a half-open range: a start at the very end of a line moves to the next line, an end at column 0
 * moves back to the end of the previous line, empty ranges become null.
 * @param {Range} r
 * @param {string[]} lines
 * @returns {Range | null}
 */
export function normalizeRange(r, lines) {
  let { start, end } = r;
  if (cmp(start, end) > 0) [start, end] = [end, start];
  start = { ...start };
  end = { ...end };
  while (start.line < end.line && start.off >= (lines[start.line]?.length ?? 0)) {
    start = { line: start.line + 1, off: 0 };
  }
  while (end.line > start.line && end.off === 0) {
    end = { line: end.line - 1, off: lines[end.line - 1]?.length ?? 0 };
  }
  if (cmp(start, end) >= 0) return null;
  return { start, end };
}

/** Store selection (1-based lines, columns) for makeAnchor from a document range. */
export const rangeToSel = (r) => ({ startLine: r.start.line + 1, endLine: r.end.line + 1, startCol: r.start.off, endCol: r.end.off });

/** Whole-line selection between two 0-based lines (keyboard V mode). */
export function linesToSel(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { startLine: lo + 1, endLine: hi + 1 };
}

// --- spans: what a thread anchor / a selection covers -------------------------------------------------

/** @returns {Span} */
export const spanOfAnchor = (a) => ({ l0: a.startLine - 1, l1: a.endLine - 1, c0: a.startCol ?? null, c1: a.endCol ?? null });
/** @returns {Span} */
export const spanOfRange = (r) => ({ l0: r.start.line, l1: r.end.line, c0: r.start.off, c1: r.end.off });
/** @returns {Span} */
export const spanOfLines = (a, b) => ({ l0: Math.min(a, b), l1: Math.max(a, b), c0: null, c1: null });

/**
 * The part of line `line` (length `len`) a span covers, or null.
 * `whole` is true when the span covers the entire line (the highlight then extends over the blank rest of the row).
 * @param {Span} span
 * @returns {{from: number, to: number, whole: boolean} | null}
 */
export function spanLineInterval(span, line, len) {
  if (line < span.l0 || line > span.l1) return null;
  const from = line === span.l0 && span.c0 != null ? Math.min(span.c0, len) : 0;
  const to = line === span.l1 && span.c1 != null ? Math.min(span.c1, len) : len;
  const whole = from === 0 && to === len;
  if (to <= from && !whole) return null;
  return { from, to, whole };
}

/** Does the span cover the character at (line, off)? Whole-line coverage includes the end-of-line cell. */
export function spanCovers(span, line, off, len) {
  const iv = spanLineInterval(span, line, len);
  if (!iv) return false;
  return iv.whole || (off >= iv.from && off < iv.to);
}
