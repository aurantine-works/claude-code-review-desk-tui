/**
 * Text primitives shared by the editor model (input/) and the screen layout (mouse/):
 * grapheme segmentation, display width and input sanitising.
 *
 * All offsets in this module are UTF-16 code-unit offsets, and a
 * "boundary" is an offset that sits between two grapheme clusters.
 *
 * Pure functions only; no Ink / React imports.
 */
import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * One grapheme cluster of a string.
 * @typedef {object} Grapheme
 * @property {string} text   The cluster itself.
 * @property {number} start  UTF-16 offset of the first code unit.
 * @property {number} end    UTF-16 offset just past the last code unit.
 */

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Split a string into grapheme clusters (emoji ZWJ sequences, combining marks, CJK, ...).
 * @param {string} str
 * @returns {Grapheme[]}
 */
export function splitGraphemes(str) {
  const out = [];
  if (PRINTABLE_ASCII.test(str)) {
    // Fast path: every code unit is its own cluster.
    for (let i = 0; i < str.length; i++) out.push({ text: str[i], start: i, end: i + 1 });
    return out;
  }
  for (const seg of segmenter.segment(str)) {
    out.push({ text: seg.segment, start: seg.index, end: seg.index + seg.segment.length });
  }
  return out;
}

/**
 * Snap an offset forward to the nearest grapheme boundary (identity when already on one).
 * @param {string} str
 * @param {number} offset
 * @returns {number}
 */
export function snapToBoundary(str, offset) {
  if (offset <= 0) return 0;
  if (offset >= str.length) return str.length;
  const seg = segmenter.segment(str).containing(offset);
  return seg.index === offset ? offset : seg.index + seg.segment.length;
}

/**
 * Boundary immediately before `offset` (start of the cluster that precedes the caret).
 * @param {string} str
 * @param {number} offset
 * @returns {number}
 */
export function prevBoundary(str, offset) {
  if (offset <= 0) return 0;
  const o = Math.min(offset, str.length);
  return segmenter.segment(str).containing(o - 1).index;
}

/**
 * Boundary immediately after `offset` (end of the cluster that follows the caret).
 * @param {string} str
 * @param {number} offset
 * @returns {number}
 */
export function nextBoundary(str, offset) {
  if (offset >= str.length) return str.length;
  const seg = segmenter.segment(str).containing(Math.max(0, offset));
  return seg.index + seg.segment.length;
}

/**
 * True for a single C0/C1 control code unit other than TAB (these must never be written to the
 * terminal verbatim, and occupy no columns).
 * @param {string} g
 */
export function isControl(g) {
  if (g.length !== 1 && g !== '\r\n') return false;
  const c = g.charCodeAt(0);
  return (c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f);
}

/**
 * Display width in terminal columns of one grapheme (TAB is handled by the layout, not here).
 * @param {string} g
 * @returns {number}
 */
export function graphemeWidth(g) {
  if (g.length === 1) {
    const c = g.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return 1;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return 0;
  } else if (g === '\r\n') {
    return 0;
  }
  return stringWidth(g);
}

/** Display width of a whole string, ignoring TAB expansion (use for short single-line labels). */
export function textWidth(str) {
  return stringWidth(str);
}

// CSI / OSC / lone ESC-prefixed sequences that could sneak into pasted text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Normalise text that is about to enter the editor: CRLF/CR become LF, ANSI escape sequences
 * and control characters (except TAB and LF) are removed.
 * @param {string} str
 * @returns {string}
 */
export function sanitizeInput(str) {
  return str.replace(/\r\n?/g, '\n').replace(ANSI_RE, '').replace(CONTROL_RE, '');
}
