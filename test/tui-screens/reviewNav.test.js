import { describe, it, expect } from 'vitest';
import * as nav from '../../src/tui/lib/reviewNav.js';
import { makeFrame, thread, anchor } from './harness.js';

const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);

describe('reviewNav', () => {
  it('moves the cursor and scrolls with a margin', () => {
    const { s, ctx } = makeFrame({ lines, cols: 100, rows: 24 }); // bodyH = 20
    let st = s;
    for (let i = 0; i < 30; i++) st = nav.moveCursor(st, ctx, 1);
    expect(st.cursor).toBe(30);
    const win = ctx.doc.window(st.top, ctx.bodyH);
    const row = win.rowOf(30);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(row).toBeLessThanOrEqual(ctx.bodyH - 3); // two rows of context below the cursor
    expect(nav.moveCursor(s, ctx, -5).cursor).toBe(0); // clamped
  });

  it('g / G', () => {
    const { s, ctx } = makeFrame({ lines, cols: 100, rows: 24 });
    const end = nav.setCursor(s, ctx, ctx.lineCount - 1);
    expect(end.cursor).toBe(199);
    expect(ctx.doc.window(end.top, ctx.bodyH).rowOf(199)).toBe(ctx.bodyH - 1);
    expect(nav.setCursor(end, ctx, 0).top).toEqual({ line: 0, sub: 0 });
  });

  it('half page scrolls the view and moves the cursor with it', () => {
    const { s, ctx } = makeFrame({ lines, cols: 100, rows: 24 });
    const a = nav.pageStep(s, ctx, 1, 0.5);
    expect(a.top.line).toBe(10);
    expect(a.cursor).toBeGreaterThanOrEqual(10);
    const b = nav.pageStep(a, ctx, -1, 0.5);
    expect(b.top.line).toBe(0);
    const full = nav.pageStep(s, ctx, 1, 1);
    expect(full.top.line).toBe(19);
  });

  it('wheel scrolling drags the cursor along instead of leaving it off screen', () => {
    const { s, ctx } = makeFrame({ lines, cols: 100, rows: 24 });
    const st = nav.scrollView(s, ctx, 30);
    expect(st.top.line).toBe(30);
    const { lo, hi } = ctx.doc.cursorBounds(st.top, ctx.bodyH);
    expect(st.cursor).toBeGreaterThanOrEqual(lo);
    expect(st.cursor).toBeLessThanOrEqual(hi);
    expect(nav.scrollView(st, ctx, -1000).top).toEqual({ line: 0, sub: 0 });
  });

  it('focus follows the cursor onto a thread line and is kept while still on it', () => {
    const threads = [thread('t1', anchor(5)), thread('t2', anchor(5))];
    const { s, ctx } = makeFrame({ lines, threads, cols: 100, rows: 24 });
    let st = nav.setCursor(s, ctx, 4);
    expect(st.focusId).toBe('t1');
    st = { ...st, focusId: 't2' };
    expect(nav.focusFor(st, ctx)).toBe('t2');
    st = nav.moveCursor(st, ctx, 1);
    expect(st.focusId).toBeNull();
  });

  it('jumpToThread focuses the thread and shows its anchor', () => {
    const threads = [thread('t1', anchor(150))];
    const { s, ctx, doc } = makeFrame({ lines, threads, cols: 100, rows: 24 });
    const st = nav.jumpToThread(s, ctx, threads[0]);
    expect(st.cursor).toBe(149);
    expect(st.focusId).toBe('t1');
    expect(doc.window(st.top, ctx.bodyH).rowOf(149)).toBeGreaterThanOrEqual(0);
  });

  it('jumping to an orphan only changes the focus', () => {
    const o = thread('t9', anchor(3, 3, { orphaned: true }));
    const { s, ctx } = makeFrame({ lines, threads: [o], cols: 100, rows: 24 });
    const st = nav.jumpToThread({ ...s, cursor: 7 }, ctx, o);
    expect(st.cursor).toBe(7);
    expect(st.focusId).toBe('t9');
  });

  it('visual mode: v / V start, switch and leave', () => {
    const { s } = makeFrame({ lines });
    const at = { ...s, cursor: 3, col: 2 };
    const v = nav.enterVisual(at, 'char');
    expect(v).toMatchObject({ mode: 'visual', visual: { kind: 'char', anchor: { line: 3, off: 2 } } });
    // V inside v switches to line-wise and keeps the anchor; the same key leaves
    const vl = nav.enterVisual(v, 'line');
    expect(vl).toMatchObject({ mode: 'visual', visual: { kind: 'line', anchor: { line: 3, off: 2 } } });
    expect(nav.enterVisual(vl, 'char').visual.kind).toBe('char');
    expect(nav.enterVisual(vl, 'line')).toMatchObject({ mode: 'normal', visual: null });
    expect(nav.clearSelection(v)).toMatchObject({ mode: 'normal', visual: null });
  });

  it('a character selection includes the character under the cursor, in either direction and across lines', () => {
    const text = ['hello world', 'abc', '', '你好 世界'];
    const { s, ctx } = makeFrame({ lines: text });
    let st = { ...s, cursor: 0, col: 6, goalCol: 6 };
    st = nav.enterVisual(st, 'char');
    st = nav.moveColumn(st, ctx, 'lineEnd');
    expect(nav.selectionToSel(st, text)).toEqual({ startLine: 1, endLine: 1, startCol: 6, endCol: 11 }); // "world"
    st = nav.moveCursor(st, ctx, 1); // goal column: end of line
    expect(nav.selectionToSel(st, text)).toMatchObject({ startLine: 1, endLine: 2, startCol: 6, endCol: 3 });
    // backwards: cursor before the anchor
    let back = nav.enterVisual({ ...s, cursor: 0, col: 6, goalCol: 6 }, 'char');
    back = nav.moveColumn(back, ctx, 'left');
    back = nav.moveColumn(back, ctx, 'left');
    expect(nav.selectionToSel(back, text)).toEqual({ startLine: 1, endLine: 1, startCol: 4, endCol: 7 });
    // line-wise
    let ln = nav.enterVisual({ ...s, cursor: 1, col: 0 }, 'line');
    ln = nav.moveCursor(ln, ctx, 2);
    expect(nav.selectionToSel(ln, text)).toEqual({ startLine: 2, endLine: 4 });
    // no selection: the cursor line
    expect(nav.selectionToSel({ ...s, cursor: 1 }, text)).toEqual({ startLine: 2, endLine: 2 });
    // a single character on an empty line falls back to the line
    expect(nav.selectionToSel(nav.enterVisual({ ...s, cursor: 2, col: 0 }, 'char'), text)).toEqual({ startLine: 3, endLine: 3 });
  });

  it('a CJK selection takes whole characters', () => {
    const text = ['你好 世界'];
    const { s, ctx } = makeFrame({ lines: text });
    let st = nav.enterVisual({ ...s, cursor: 0, col: 0, goalCol: 0 }, 'char');
    st = nav.moveColumn(st, ctx, 'right');
    expect(nav.selectionToSel(st, text)).toEqual({ startLine: 1, endLine: 1, startCol: 0, endCol: 2 });
    expect(nav.visualSpan(st, text)).toEqual({ l0: 0, l1: 0, c0: 0, c1: 2 });
  });

  it('h l w b e 0 ^ $ move the column cursor; j / k keep the goal display column', () => {
    const text = ['  foo bar', '你好', 'a longer line here', '', 'x'];
    const { s, ctx } = makeFrame({ lines: text });
    let st = { ...s };
    st = nav.moveColumn(st, ctx, 'firstNonBlank');
    expect(st.col).toBe(2);
    st = nav.moveColumn(st, ctx, 'wordNext');
    expect(st.col).toBe(6);
    st = nav.moveColumn(st, ctx, 'wordEnd');
    expect(st.col).toBe(8);
    st = nav.moveColumn(st, ctx, 'lineStart');
    expect(st.col).toBe(0);
    st = nav.moveColumn(st, ctx, 'lineEnd');
    expect(st.col).toBe(8);
    expect(st.goalCol).toBe(Infinity);
    // goal column across a short line and back
    st = nav.moveColumn({ ...s }, ctx, 'lineStart');
    for (let i = 0; i < 6; i++) st = nav.moveColumn(st, ctx, 'right');
    expect(st.col).toBe(6);
    st = nav.moveCursor(st, ctx, 1); // "你好" has only 4 columns
    expect(st.cursor).toBe(1);
    expect(st.col).toBe(1); // the last character
    st = nav.moveCursor(st, ctx, 1);
    expect(st.cursor).toBe(2);
    expect(st.col).toBe(6); // back at the remembered column
    st = nav.moveCursor(st, ctx, 1); // empty line
    expect(st.col).toBe(0);
    // word motions cross lines
    let w = nav.moveColumn({ ...s, cursor: 0, col: 6 }, ctx, 'wordNext');
    expect(w.cursor).toBe(1);
    w = nav.moveColumn(w, ctx, 'wordPrev');
    expect(w).toMatchObject({ cursor: 0, col: 6 });
    // h at the start and l at the end stay
    expect(nav.moveColumn({ ...s }, ctx, 'left').col).toBe(0);
    expect(nav.moveColumn({ ...s, cursor: 4, col: 0 }, ctx, 'right').col).toBe(0);
  });

  it('jumping to a thread puts the cursor at the start of its anchor', () => {
    const text = ['hello world', 'second line'];
    const t = thread('t1', anchor(2, 2, { startCol: 7, endCol: 11 }));
    const { s, ctx } = makeFrame({ lines: text, threads: [t] });
    const st = nav.jumpToThread(s, ctx, t);
    expect(st).toMatchObject({ cursor: 1, col: 7, focusId: 't1' });
  });

  it('drawer shows the focused thread first, then the others on the cursor line', () => {
    const threads = [thread('t1', anchor(5)), thread('t2', anchor(5)), thread('t3', anchor(5))];
    const { s, ctx } = makeFrame({ lines, threads, cols: 80, rows: 24 });
    expect(nav.drawerThreadIds({ ...s, cursor: 4, focusId: 't2' }, ctx)).toEqual(['t2', 't1', 't3']);
    expect(nav.drawerThreadIds({ ...s, cursor: 0, focusId: null }, ctx)).toEqual([]);
  });
});
