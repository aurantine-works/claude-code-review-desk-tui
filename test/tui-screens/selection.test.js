import { describe, it, expect } from 'vitest';
import {
  normalizeRange,
  rangeToSel,
  linesToSel,
  spanOfAnchor,
  spanOfRange,
  spanLineInterval,
  spanCovers,
} from '../../src/tui/lib/selection.js';
import { makeAnchor } from '../../src/anchor/index.js';

const lines = ['hello world', '', '迁移旧 store 的风险较低', 'last'];
const content = lines.join('\n');
const quoteOf = (range) => makeAnchor(content, rangeToSel(range), 1).quote;

describe('normalizeRange', () => {
  it('a start at the end of a line moves to the next non-empty line, an end at column 0 moves back', () => {
    const r = normalizeRange({ start: { line: 0, off: 11 }, end: { line: 3, off: 0 } }, lines);
    expect(r).toEqual({ start: { line: 2, off: 0 }, end: { line: 2, off: lines[2].length } }); // the empty line 1 is skipped too
  });

  it('empty ranges are null; reversed ranges are ordered', () => {
    expect(normalizeRange({ start: { line: 0, off: 3 }, end: { line: 0, off: 3 } }, lines)).toBeNull();
    expect(normalizeRange({ start: { line: 0, off: 5 }, end: { line: 0, off: 0 } }, lines)).toEqual({ start: { line: 0, off: 0 }, end: { line: 0, off: 5 } });
  });

  it('rangeToSel gives 1-based lines and UTF-16 columns that makeAnchor turns into the exact quote', () => {
    const r = { start: { line: 2, off: 11 }, end: { line: 2, off: 15 } };
    expect(rangeToSel(r)).toEqual({ startLine: 3, endLine: 3, startCol: 11, endCol: 15 });
    expect(quoteOf(r)).toBe('风险较低');
    expect(quoteOf({ start: { line: 0, off: 6 }, end: { line: 2, off: 3 } })).toBe('world\n\n迁移旧');
  });
});

describe('spans', () => {
  it('anchors without columns cover whole lines', () => {
    const span = spanOfAnchor({ startLine: 2, endLine: 3, startCol: null, endCol: null });
    expect(spanLineInterval(span, 0, 5)).toBeNull();
    expect(spanLineInterval(span, 1, 5)).toEqual({ from: 0, to: 5, whole: true });
    expect(spanLineInterval(span, 2, 7)).toEqual({ from: 0, to: 7, whole: true });
    expect(spanLineInterval(span, 3, 7)).toBeNull();
  });

  it('character spans cut the first and last line', () => {
    const span = spanOfRange({ start: { line: 0, off: 6 }, end: { line: 2, off: 3 } });
    expect(spanLineInterval(span, 0, 11)).toEqual({ from: 6, to: 11, whole: false });
    expect(spanLineInterval(span, 1, 0)).toEqual({ from: 0, to: 0, whole: true });
    expect(spanLineInterval(span, 2, 17)).toEqual({ from: 0, to: 3, whole: false });
  });

  it('spanCovers', () => {
    const span = spanOfAnchor({ startLine: 1, endLine: 1, startCol: 2, endCol: 5 });
    expect(spanCovers(span, 0, 1, 11)).toBe(false);
    expect(spanCovers(span, 0, 2, 11)).toBe(true);
    expect(spanCovers(span, 0, 4, 11)).toBe(true);
    expect(spanCovers(span, 0, 5, 11)).toBe(false);
    const whole = spanOfAnchor({ startLine: 1, endLine: 1, startCol: null, endCol: null });
    expect(spanCovers(whole, 0, 11, 11)).toBe(true); // the end-of-line cell belongs to a whole-line anchor
  });

  it('linesToSel orders the lines and converts to 1-based', () => {
    expect(linesToSel(4, 2)).toEqual({ startLine: 3, endLine: 5 });
  });
});
