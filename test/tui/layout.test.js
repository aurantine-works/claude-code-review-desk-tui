import { describe, it, expect } from 'vitest';
import { buildLayout, hitTest, locate } from '../../src/tui/mouse/layout.js';

const rowsOf = (layout) => layout.map((r) => ({ line: r.line, s: r.startOffset, e: r.endOffset, text: r.text }));

describe('buildLayout: wrapping', () => {
  it('keeps short lines on one row and maps empty lines to an empty row', () => {
    const l = buildLayout(['abc', '', 'de'], { width: 10 });
    expect(rowsOf(l)).toEqual([
      { line: 0, s: 0, e: 3, text: 'abc' },
      { line: 1, s: 0, e: 0, text: '' },
      { line: 2, s: 0, e: 2, text: 'de' },
    ]);
    expect(l.map((r) => [r.first, r.last])).toEqual([[true, true], [true, true], [true, true]]);
  });

  it('hard-wraps a long word and keeps offsets contiguous', () => {
    const l = buildLayout(['abcdefghij'], { width: 4 });
    expect(rowsOf(l)).toEqual([
      { line: 0, s: 0, e: 4, text: 'abcd' },
      { line: 0, s: 4, e: 8, text: 'efgh' },
      { line: 0, s: 8, e: 10, text: 'ij' },
    ]);
    expect(l.map((r) => [r.first, r.last])).toEqual([[true, false], [false, false], [false, true]]);
  });

  it('wraps after spaces when a word does not fit (word wrap), without losing characters', () => {
    const l = buildLayout(['hello world foo'], { width: 8 });
    expect(rowsOf(l)).toEqual([
      { line: 0, s: 0, e: 6, text: 'hello ' },
      { line: 0, s: 6, e: 12, text: 'world ' },
      { line: 0, s: 12, e: 15, text: 'foo' },
    ]);
    expect(l.map((r) => r.text).join('')).toBe('hello world foo');
  });

  it('can disable word wrap', () => {
    const l = buildLayout(['hello world'], { width: 8, wordWrap: false });
    expect(l.map((r) => r.text)).toEqual(['hello wo', 'rld']);
  });

  it('wraps CJK text by display width (2 columns per char)', () => {
    const l = buildLayout(['你好世界再见'], { width: 6 });
    expect(rowsOf(l)).toEqual([
      { line: 0, s: 0, e: 3, text: '你好世' },
      { line: 0, s: 3, e: 6, text: '界再见' },
    ]);
  });

  it('moves a double-width char to the next row when one column is left', () => {
    const l = buildLayout(['a你好'], { width: 4 });
    expect(rowsOf(l)).toEqual([
      { line: 0, s: 0, e: 2, text: 'a你' },
      { line: 0, s: 2, e: 3, text: '好' },
    ]);
    expect(l[0].width).toBe(3);
  });

  it('never splits a grapheme: emoji ZWJ family, flag, and base + combining mark', () => {
    const fam = '👨‍👩‍👧';
    const l = buildLayout([`a${fam}b`], { width: 2 });
    expect(l.map((r) => r.text)).toEqual(['a', fam, 'b']);
    expect(l[1].cells).toHaveLength(1);
    expect(l[1].cells[0].width).toBe(2);
    const comb = buildLayout(['éé'], { width: 1 });
    expect(comb.map((r) => r.text)).toEqual(['é', 'é']);
    expect(comb[1].startOffset).toBe(2);
  });

  it('expands tabs to the next tab stop of the screen row', () => {
    const l = buildLayout(['a\tb\t\tc'], { width: 40, tabWidth: 4 });
    expect(l[0].text).toBe('a   b       c');
    const cols = l[0].cells.map((c) => [c.text === '\t' ? 'T' : c.text, c.col, c.width]);
    expect(cols).toEqual([['a', 0, 1], ['T', 1, 3], ['b', 4, 1], ['T', 5, 3], ['T', 8, 4], ['c', 12, 1]]);
  });

  it('clamps a tab to the remaining columns instead of overflowing', () => {
    const l = buildLayout(['abc\tdef'], { width: 5, tabWidth: 8 });
    expect(l.map((r) => r.text)).toEqual(['abc  ', 'def']);
    expect(l[0].width).toBe(5);
  });

  it('drops control characters from the display but keeps their offsets', () => {
    const l = buildLayout(['a\x1b[31mb\r'], { width: 20 });
    expect(l[0].text).toBe('a[31mb');
    expect(l[0].endOffset).toBe(8);
    expect(l[0].cells.filter((c) => c.width === 0)).toHaveLength(2);
  });

  it('honours firstLine and exposes meta', () => {
    const l = buildLayout(['x', 'y'], { width: 12, gutterWidth: 4, firstLine: 40 });
    expect(l.map((r) => r.line)).toEqual([40, 41]);
    expect(l.meta).toEqual({ width: 12, gutterWidth: 4, textWidth: 8, tabWidth: 4 });
    expect(Object.keys(l)).toEqual(['0', '1']);
  });

  it('survives degenerate widths', () => {
    expect(buildLayout(['你好'], { width: 1 }).map((r) => r.text)).toEqual(['你', '好']);
    expect(buildLayout(['abc'], { width: 0 }).map((r) => r.text)).toEqual(['a', 'b', 'c']);
  });

  it('uses UTF-16 offsets (astral characters count as 2)', () => {
    const l = buildLayout(['a😀b'], { width: 3 });
    expect(rowsOf(l)).toEqual([
      { line: 0, s: 0, e: 3, text: 'a😀' },
      { line: 0, s: 3, e: 4, text: 'b' },
    ]);
  });

  it('starts a new row at the given break offsets, with no word-wrap look-back (wrapped table rows)', () => {
    const text = '│ ab cd││ ef gh│'; // 8 columns per piece; the closing border follows a space, so word wrap would cut at "cd│"
    const plain = buildLayout([text], { width: 8 });
    expect(plain.map((r) => r.text)).not.toEqual(['│ ab cd│', ' ef gh│']);
    const cut = buildLayout([text], { width: 8, breaks: new Map([[0, [8]]]) });
    expect(rowsOf(cut)).toEqual([
      { line: 0, s: 0, e: 8, text: '│ ab cd│' },
      { line: 0, s: 8, e: 16, text: '│ ef gh│' },
    ]);
    expect(cut.map((r) => [r.first, r.last])).toEqual([[true, false], [false, true]]);
    // a break shorter than the width, in a line given with a firstLine, and breaks of other lines are ignored
    const l = buildLayout(['aaa', 'bbbbbb', 'cc'], { width: 20, firstLine: 5, breaks: new Map([[6, [2, 4]], [9, [1]]]) });
    expect(l.map((r) => [r.line, r.text])).toEqual([[5, 'aaa'], [6, 'bb'], [6, 'bb'], [6, 'bb'], [7, 'cc']]);
  });
});

describe('hitTest', () => {
  it('maps ASCII columns to offsets, accounting for the gutter', () => {
    const l = buildLayout(['hello'], { width: 20, gutterWidth: 4 });
    expect(hitTest(l, 0, 4)).toMatchObject({ line: 0, offset: 0, region: 'text' });
    expect(hitTest(l, 0, 6)).toMatchObject({ line: 0, offset: 2 });
    expect(hitTest(l, 0, 8)).toMatchObject({ line: 0, offset: 4 });
  });

  it('clicking in the gutter returns the row start', () => {
    const l = buildLayout(['abcdefgh'], { width: 8, gutterWidth: 3 });
    expect(hitTest(l, 0, 0)).toEqual({ line: 0, offset: 0, row: 0, region: 'gutter' });
    expect(hitTest(l, 1, 2)).toEqual({ line: 0, offset: 5, row: 1, region: 'gutter' });
  });

  it('clicking after the end of the line returns the line end', () => {
    const l = buildLayout(['abc', ''], { width: 20 });
    expect(hitTest(l, 0, 10)).toEqual({ line: 0, offset: 3, row: 0, region: 'eol' });
    expect(hitTest(l, 1, 5)).toEqual({ line: 1, offset: 0, row: 1, region: 'eol' });
  });

  it('either half of a double-width character selects that character', () => {
    const l = buildLayout(['a你好b'], { width: 20 });
    // columns: a=0, 你=1-2, 好=3-4, b=5
    expect(hitTest(l, 0, 0).offset).toBe(0);
    expect(hitTest(l, 0, 1).offset).toBe(1); // left half
    expect(hitTest(l, 0, 2).offset).toBe(1); // right half -> same char
    expect(hitTest(l, 0, 3).offset).toBe(2);
    expect(hitTest(l, 0, 4).offset).toBe(2);
    expect(hitTest(l, 0, 5).offset).toBe(3);
    expect(hitTest(l, 0, 6)).toMatchObject({ offset: 4, region: 'eol' });
  });

  it('handles gutter + double-width characters together', () => {
    const l = buildLayout(['你好'], { width: 20, gutterWidth: 5 });
    expect(hitTest(l, 0, 5).offset).toBe(0);
    expect(hitTest(l, 0, 6).offset).toBe(0);
    expect(hitTest(l, 0, 7).offset).toBe(1);
    expect(hitTest(l, 0, 8).offset).toBe(1);
  });

  it('works on soft-wrapped rows (offsets continue across rows)', () => {
    const l = buildLayout(['abcdefghij'], { width: 4 });
    expect(hitTest(l, 0, 3)).toMatchObject({ line: 0, offset: 3, row: 0 });
    expect(hitTest(l, 1, 0)).toMatchObject({ line: 0, offset: 4, row: 1 });
    expect(hitTest(l, 1, 3)).toMatchObject({ line: 0, offset: 7 });
    expect(hitTest(l, 2, 1)).toMatchObject({ line: 0, offset: 9 });
  });

  it('keeps a click right of a wrapped (non-last) row on that row', () => {
    const l = buildLayout(['a你好'], { width: 4 }); // rows: "a你"(3 cols), "好"
    expect(hitTest(l, 0, 3)).toEqual({ line: 0, offset: 1, row: 0, region: 'eol' });
    expect(hitTest(l, 1, 3)).toEqual({ line: 0, offset: 3, row: 1, region: 'eol' });
  });

  it('wrapped CJK text: right half of the last char on a row', () => {
    const l = buildLayout(['你好世界再见'], { width: 6 });
    expect(hitTest(l, 0, 5).offset).toBe(2); // right half of 世
    expect(hitTest(l, 1, 0).offset).toBe(3); // 界
    expect(hitTest(l, 1, 1).offset).toBe(3);
    expect(hitTest(l, 1, 4).offset).toBe(5);
  });

  it('maps columns inside an expanded tab to the tab itself', () => {
    const l = buildLayout(['a\tb'], { width: 20, tabWidth: 4 }); // a=0, tab=1..3, b=4
    expect(hitTest(l, 0, 1).offset).toBe(1);
    expect(hitTest(l, 0, 3).offset).toBe(1);
    expect(hitTest(l, 0, 4).offset).toBe(2);
  });

  it('treats an emoji ZWJ sequence as one 2-column target', () => {
    const l = buildLayout(['x👨‍👩‍👧y'], { width: 20 });
    expect(hitTest(l, 0, 1).offset).toBe(1);
    expect(hitTest(l, 0, 2).offset).toBe(1);
    expect(hitTest(l, 0, 3).offset).toBe(1 + '👨‍👩‍👧'.length);
  });

  it('returns null outside the layout unless clampRow is set', () => {
    const l = buildLayout(['a', 'b', 'c'], { width: 10 });
    expect(hitTest(l, -1, 0)).toBeNull();
    expect(hitTest(l, 3, 0)).toBeNull();
    expect(hitTest(l, 99, 0, { clampRow: true })).toMatchObject({ line: 2, row: 2 });
    expect(hitTest(l, -5, 0, { clampRow: true })).toMatchObject({ line: 0, row: 0 });
    expect(hitTest(buildLayout([], { width: 10 }), 0, 0)).toBeNull();
  });

  it('reports source line numbers of a windowed layout', () => {
    const l = buildLayout(['x', 'yy'], { width: 10, firstLine: 100 });
    expect(hitTest(l, 1, 1)).toMatchObject({ line: 101, offset: 1 });
  });
});

describe('locate', () => {
  it('is the inverse of hitTest for every cell', () => {
    const lines = ['a你好b cd efgh', '', '\tindent 世界 😀 end', 'x'.repeat(23)];
    const l = buildLayout(lines, { width: 9, gutterWidth: 2, tabWidth: 4 });
    for (let r = 0; r < l.length; r++) {
      for (const [i, cell] of l[r].cells.entries()) {
        if (cell.width === 0) continue;
        const pos = locate(l, l[r].line, cell.start);
        expect(pos).toEqual({ row: r, col: 2 + cell.col, cell: i });
        expect(hitTest(l, pos.row, pos.col).offset).toBe(cell.start);
      }
    }
  });

  it('puts a caret on a wrap point on the next row and the line end after the last char', () => {
    const l = buildLayout(['abcdefgh'], { width: 4 });
    expect(locate(l, 0, 4)).toEqual({ row: 1, col: 0, cell: 0 });
    expect(locate(l, 0, 8)).toEqual({ row: 1, col: 4, cell: -1 });
    expect(locate(l, 0, 99)).toEqual({ row: 1, col: 4, cell: -1 });
    expect(locate(l, 7, 0)).toBeNull();
  });

  it('locates inside CJK wrapped text', () => {
    const l = buildLayout(['你好世界再见'], { width: 6 });
    expect(locate(l, 0, 4)).toEqual({ row: 1, col: 2, cell: 1 });
  });
});
