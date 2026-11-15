// Column cursor motions (vim-like) over source lines. Pure functions.
//
// A position is {line, off}: `off` is the UTF-16 offset of the *start of a grapheme* in the line (0 for an empty
// line). In Normal / Visual mode the cursor sits on a character, so it never goes past the last grapheme start.
// Words come from Intl.Segmenter (granularity 'word'), which knows Chinese / Japanese word boundaries; every
// non-blank segment counts as a word, so punctuation is its own stop like in vim.
import { splitGraphemes, graphemeWidth, prevBoundary, nextBoundary } from '../input/text.js';

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const TAB = 4;

/** Display width of one grapheme at display column `col` (tabs expand to the next tab stop). */
function widthAt(g, col, tabWidth) {
  if (g === '\t') return tabWidth - (col % tabWidth);
  return graphemeWidth(g);
}

/** Start offset of the last grapheme (0 for an empty line). */
export function lastOff(line) {
  return line.length === 0 ? 0 : prevBoundary(line, line.length);
}

/** First offset that is not blank (the line's last grapheme start when it is all blank). */
export function firstNonBlank(line) {
  for (const g of splitGraphemes(line)) if (g.text.trim() !== '') return g.start;
  return lastOff(line);
}

/** Display column of the grapheme starting at `off`. */
export function colOf(line, off, tabWidth = TAB) {
  let col = 0;
  for (const g of splitGraphemes(line)) {
    if (g.start >= off) break;
    col += widthAt(g.text, col, tabWidth);
  }
  return col;
}

/** Offset of the grapheme that covers display column `col` (clamped to the last grapheme). */
export function offsetAtCol(line, col, tabWidth = TAB) {
  let c = 0;
  let last = 0;
  for (const g of splitGraphemes(line)) {
    const w = widthAt(g.text, c, tabWidth);
    if (col < c + Math.max(1, w)) return g.start;
    c += w;
    last = g.start;
  }
  return last;
}

/** Keep an offset valid for a (possibly changed) line: a grapheme start no later than the last one. */
export function clampOff(line, off) {
  if (line.length === 0) return 0;
  const o = Math.max(0, Math.min(off, line.length - 1));
  return Math.min(prevBoundary(line, o + 1), lastOff(line));
}

export const moveLeft = (line, off) => (off <= 0 ? 0 : prevBoundary(line, off));
export function moveRight(line, off) {
  const last = lastOff(line);
  return off >= last ? last : Math.min(nextBoundary(line, off), last);
}

/** Non-blank word segments of a line as [start, end) pairs. */
function units(line) {
  const out = [];
  for (const seg of wordSegmenter.segment(line)) {
    if (seg.segment.trim() !== '') out.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  return out;
}

const endOff = (line, u) => prevBoundary(line, u.end);

/** `w`: start of the next word; an empty line is a stop; the last position of the document is the limit. */
export function nextWord(lines, pos) {
  const { line, off } = pos;
  const next = units(lines[line]).find((u) => u.start > off);
  if (next) return { line, off: next.start };
  for (let l = line + 1; l < lines.length; l++) {
    if (lines[l].length === 0) return { line: l, off: 0 };
    const u = units(lines[l])[0];
    if (u) return { line: l, off: u.start };
  }
  return { line, off: lastOff(lines[line]) };
}

/** `b`: start of the previous word. */
export function prevWord(lines, pos) {
  const { line, off } = pos;
  const us = units(lines[line]).filter((u) => u.start < off);
  if (us.length) return { line, off: us[us.length - 1].start };
  for (let l = line - 1; l >= 0; l--) {
    if (lines[l].length === 0) return { line: l, off: 0 };
    const all = units(lines[l]);
    if (all.length) return { line: l, off: all[all.length - 1].start };
  }
  return { line: 0, off: 0 };
}

/** `e`: last character of the current word, or of the next one when already there. */
export function wordEnd(lines, pos) {
  const { line, off } = pos;
  const here = units(lines[line]).find((u) => endOff(lines[line], u) > off);
  if (here) return { line, off: endOff(lines[line], here) };
  for (let l = line + 1; l < lines.length; l++) {
    const u = units(lines[l])[0];
    if (u) return { line: l, off: endOff(lines[l], u) };
  }
  return { line, off: lastOff(lines[line]) };
}
