// Light Markdown source highlighting. The source is shown verbatim (one screen row per source row), so
// this only decides how a cell is *styled*, never what it shows.
import { COLOR } from './theme.js';

/**
 * @typedef {object} LineInfo
 * @property {'text'|'heading'|'code'|'fence'|'quote'|'list'|'hr'} kind
 * @property {number} [level]   heading level
 * @property {number} [marker]  list: number of leading UTF-16 units that make up the bullet (indent + marker)
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s|$)/;
const LIST_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])(?=\s)/;
const QUOTE_RE = /^ {0,3}>/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** Classify every line once per document (fenced code needs state from the lines above). */
export function classifyLines(lines) {
  const out = new Array(lines.length);
  let fence = null; // opening fence string while inside a code block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) {
        fence = null;
        out[i] = { kind: 'fence' };
      } else {
        out[i] = { kind: 'code' };
      }
      continue;
    }
    if (f) {
      fence = f[1];
      out[i] = { kind: 'fence' };
      continue;
    }
    const hd = HEADING_RE.exec(line);
    if (hd) {
      out[i] = { kind: 'heading', level: hd[1].length };
      continue;
    }
    if (HR_RE.test(line)) {
      out[i] = { kind: 'hr' };
      continue;
    }
    if (QUOTE_RE.test(line)) {
      out[i] = { kind: 'quote' };
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      out[i] = { kind: 'list', marker: li[0].length };
      continue;
    }
    out[i] = { kind: 'text' };
  }
  return out;
}

export const HEADING_FG = ['', COLOR.accent, COLOR.blue, COLOR.purple, COLOR.purple, COLOR.purple, COLOR.purple];

const STYLES = {
  heading: (level) => ({ bold: true, fg: HEADING_FG[level] ?? COLOR.purple }),
  code: { dim: true },
  fence: { dim: true },
  quote: { fg: '#8fa58f', italic: true },
  hr: { dim: true },
  bullet: { fg: COLOR.warn },
  inline: { fg: COLOR.accent },
};
const headingStyles = {};

/** Spans [from, to) of `inline code` in a line (used for text, list and quote lines). */
export function inlineCodeSpans(line) {
  if (!line.includes('`')) return null;
  const spans = [];
  const re = /`[^`]+`/g;
  let m;
  while ((m = re.exec(line))) spans.push([m.index, m.index + m[0].length]);
  return spans.length ? spans : null;
}

/**
 * Base style of the cell starting at `offset`.
 * @param {LineInfo} info
 * @param {number} offset
 * @param {number[][] | null} code  result of inlineCodeSpans for the line
 * @returns {import('./ansi.js').Style | null}
 */
export function cellStyle(info, offset, code) {
  switch (info.kind) {
    case 'heading':
      return (headingStyles[info.level] ??= STYLES.heading(info.level));
    case 'code':
      return STYLES.code;
    case 'fence':
      return STYLES.fence;
    case 'hr':
      return STYLES.hr;
    case 'quote':
      return STYLES.quote;
    case 'list':
      if (offset < info.marker) return STYLES.bullet;
    // falls through
    default:
      if (code) for (const [a, b] of code) if (offset >= a && offset < b) return STYLES.inline;
      return null;
  }
}
