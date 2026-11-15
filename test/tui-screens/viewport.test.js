import { describe, it, expect } from 'vitest';
import { DocLayout, cmpPos, viewLayout } from '../../src/tui/lib/viewport.js';

const mk = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i));
const layout = (lines, width = 30, gutter = 5) => new DocLayout(lines).configure({ width, gutterWidth: gutter });

describe('DocLayout', () => {
  it('wraps lazily and caches per width', () => {
    const doc = layout(mk(100));
    expect(doc.layoutCalls).toBe(0);
    doc.rows(3);
    doc.rows(3);
    expect(doc.layoutCalls).toBe(1);
    doc.configure({ width: 40, gutterWidth: 5 });
    doc.rows(3);
    expect(doc.layoutCalls).toBe(2);
    doc.configure({ width: 40, gutterWidth: 5 }); // unchanged: cache kept
    doc.rows(3);
    expect(doc.layoutCalls).toBe(2);
  });

  it('forces the screen rows the view asks for (breaks), and a change of breaks drops the cache', () => {
    const lines = ['short', '│ ab cd││ ef gh│'];
    const doc = layout(lines, 13, 5); // 8 text columns
    expect(doc.rows(1).map((r) => r.text)).not.toEqual(['│ ab cd│', '│ ef gh│']); // word wrap would cut elsewhere
    const calls = doc.layoutCalls;
    doc.setLines(lines, new Map([[1, [8]]]));
    expect(doc.rows(1).map((r) => r.text)).toEqual(['│ ab cd│', '│ ef gh│']);
    expect(doc.layoutCalls).toBe(calls + 1);
    doc.setLines(lines, doc.breaks); // same lines, same breaks: the cache stays
    doc.rows(1);
    expect(doc.layoutCalls).toBe(calls + 1);
    doc.setLines(lines); // back to no breaks
    expect(doc.rows(1).map((r) => r.text)).not.toEqual(['│ ab cd│', '│ ef gh│']);
    expect(doc.rowCount(0)).toBe(1);
  });

  it('counts wrapped rows (CJK double width)', () => {
    const doc = layout(['短', '一二三四五六七八九十一二三四五六七八九十'], 15, 5); // 10 text cols -> 5 CJK chars per row
    expect(doc.rowCount(0)).toBe(1);
    expect(doc.rowCount(1)).toBe(4);
  });

  it('advance moves by screen rows across wrapped lines and clamps at the edges', () => {
    const doc = layout(['a', '一二三四五六七八九十一二三四五六七八九十', 'b'], 15, 5);
    expect(doc.advance({ line: 0, sub: 0 }, 1)).toEqual({ line: 1, sub: 0 });
    expect(doc.advance({ line: 0, sub: 0 }, 3)).toEqual({ line: 1, sub: 2 });
    expect(doc.advance({ line: 0, sub: 0 }, 5)).toEqual({ line: 2, sub: 0 });
    expect(doc.advance({ line: 0, sub: 0 }, 99)).toEqual({ line: 2, sub: 0 });
    expect(doc.advance({ line: 2, sub: 0 }, -1)).toEqual({ line: 1, sub: 3 });
    expect(doc.advance({ line: 1, sub: 2 }, -2)).toEqual({ line: 1, sub: 0 });
    expect(doc.advance({ line: 1, sub: 0 }, -99)).toEqual({ line: 0, sub: 0 });
  });

  it('maxTop puts the last row on the last viewport row', () => {
    const doc = layout(mk(50));
    expect(doc.maxTop(10)).toEqual({ line: 40, sub: 0 });
    expect(layout(mk(5)).maxTop(10)).toEqual({ line: 0, sub: 0 });
  });

  it('scrollBy clamps to [0, maxTop]', () => {
    const doc = layout(mk(50));
    expect(doc.scrollBy({ line: 0, sub: 0 }, -5, 10)).toEqual({ line: 0, sub: 0 });
    expect(doc.scrollBy({ line: 0, sub: 0 }, 3, 10)).toEqual({ line: 3, sub: 0 });
    expect(doc.scrollBy({ line: 38, sub: 0 }, 30, 10)).toEqual({ line: 40, sub: 0 });
  });

  it('window returns the visible rows and rowOf', () => {
    const doc = layout(['a', '一二三四五六七八九十一二三四五六七八九十', 'b', 'c'], 15, 5);
    const win = doc.window({ line: 0, sub: 0 }, 4);
    expect(win.rows.map((r) => r.line)).toEqual([0, 1, 1, 1]);
    expect(win.rowOf(0)).toBe(0);
    expect(win.rowOf(1)).toBe(1);
    expect(win.rowOf(2)).toBe(-1);
    const mid = doc.window({ line: 1, sub: 2 }, 4);
    expect(mid.rows.map((r) => r.line)).toEqual([1, 1, 2, 3]);
    expect(mid.rowOf(1)).toBe(-1); // first row scrolled off
    expect(viewLayout(mid, doc).meta.gutterWidth).toBe(5);
  });

  describe('ensureVisible', () => {
    it('leaves the view alone when the line is comfortably visible', () => {
      const doc = layout(mk(100));
      expect(doc.ensureVisible({ line: 10, sub: 0 }, 15, 10, 2)).toEqual({ line: 10, sub: 0 });
    });
    it('scrolls down with a margin', () => {
      const doc = layout(mk(100));
      const t = doc.ensureVisible({ line: 0, sub: 0 }, 9, 10, 2);
      expect(t).toEqual({ line: 2, sub: 0 }); // cursor on viewport row 7, two rows of context below
    });
    it('scrolls up with a margin', () => {
      const doc = layout(mk(100));
      expect(doc.ensureVisible({ line: 20, sub: 0 }, 19, 10, 2)).toEqual({ line: 17, sub: 0 });
    });
    it('margin 0 only scrolls when necessary', () => {
      const doc = layout(mk(100));
      expect(doc.ensureVisible({ line: 0, sub: 0 }, 9, 10, 0)).toEqual({ line: 0, sub: 0 });
      expect(doc.ensureVisible({ line: 0, sub: 0 }, 10, 10, 0)).toEqual({ line: 1, sub: 0 });
    });
    it('a far jump touches only a screenful of lines', () => {
      const doc = layout(mk(2000));
      const t = doc.ensureVisible({ line: 0, sub: 0 }, 1999, 40, 2);
      expect(t).toEqual({ line: 1960, sub: 0 });
      expect(doc.layoutCalls).toBeLessThan(120);
    });
    it('shows the start of a line taller than the viewport', () => {
      const long = '一二三四五六七八九十'.repeat(20);
      const doc = layout(['x', long, 'y'], 15, 5);
      const t = doc.ensureVisible({ line: 0, sub: 0 }, 1, 4, 0);
      expect(t).toEqual({ line: 1, sub: 0 });
    });
  });

  describe('cursorBounds', () => {
    it('keeps the cursor inside the viewport with a margin, except at the edges of the document', () => {
      const doc = layout(mk(100));
      expect(doc.cursorBounds({ line: 0, sub: 0 }, 10, 2)).toEqual({ lo: 0, hi: 7 });
      expect(doc.cursorBounds({ line: 20, sub: 0 }, 10, 2)).toEqual({ lo: 22, hi: 27 });
      expect(doc.cursorBounds({ line: 90, sub: 0 }, 10, 2)).toEqual({ lo: 92, hi: 99 });
    });
    it('always returns a valid range', () => {
      const doc = layout(mk(3));
      const b = doc.cursorBounds({ line: 0, sub: 0 }, 2, 2);
      expect(b.lo).toBeLessThanOrEqual(b.hi);
    });
  });

  it('cmpPos orders positions', () => {
    expect(cmpPos({ line: 1, sub: 0 }, { line: 0, sub: 5 })).toBeGreaterThan(0);
    expect(cmpPos({ line: 1, sub: 1 }, { line: 1, sub: 1 })).toBe(0);
  });
});
