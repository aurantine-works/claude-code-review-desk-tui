import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

import { describe, it, expect } from 'vitest';
import { viewText, resolveBase, stepBase, baseCandidates, buildDiffModel, jumpLine0, stepChange, blockStart, newLine0, loadDiffModel } from '../../src/tui/lib/diffModel.js';
import { renderDiffRow, buildDiffFrame, diffMessageRows } from '../../src/tui/lib/diffView.js';
import * as dnav from '../../src/tui/lib/diffNav.js';
import { mapDiffKey, mapDialogKey, mapPickerKey } from '../../src/tui/lib/keymap.js';
import { initialState } from '../../src/tui/lib/reviewNav.js';
import { buildThreadView } from '../../src/tui/lib/threadView.js';
import { DocLayout } from '../../src/tui/lib/viewport.js';
import { segsText } from '../../src/tui/lib/ansi.js';
import { COLOR } from '../../src/tui/lib/theme.js';
import { mouse, anchor, thread } from './harness.js';

const OLD = ['# Title', '', 'First paragraph unchanged.', 'old line alpha beta gamma', 'tail unchanged', '', 'old last line'].join('\n');
const NEW = ['# Title', '', 'First paragraph unchanged.', 'new line alpha BETA gamma', 'added line', 'tail unchanged', ''].join('\n');
const meta = (ns = [1, 2, 3]) => ({ id: 'doc-x', kind: 'doc', currentRevision: ns[ns.length - 1], revisions: ns.map((n) => ({ n })) });

describe('diffModel', () => {
  it('viewText mirrors the review screen line model (CRLF, one trailing newline)', () => {
    expect(viewText('a\r\nb\n')).toBe('a\nb');
    expect(viewText('a\n\n')).toBe('a\n');
    expect(viewText('')).toBe('');
    expect(viewText('\n')).toBe('');
  });

  it('base revision: the previous one by default, an explicit one while valid, stepping stops at the ends', () => {
    const m = meta([1, 2, 3, 4]);
    expect(baseCandidates(m)).toEqual([1, 2, 3]);
    expect(resolveBase(m, null)).toBe(3);
    expect(resolveBase(m, 1)).toBe(1);
    expect(resolveBase(m, 4)).toBe(3); // the current revision is not a base
    expect(resolveBase(m, 9)).toBe(3);
    expect(stepBase(m, null, -1)).toEqual({ base: 2, edge: false });
    expect(stepBase(m, 1, -1)).toEqual({ base: 1, edge: true });
    expect(stepBase(m, 3, 1)).toEqual({ base: 3, edge: true });
    expect(stepBase(m, 2, 1)).toEqual({ base: 3, edge: false });
    expect(resolveBase(meta([1]), null)).toBeNull(); // single revision
  });

  it('builds every line of both texts with both numbers, change blocks and a new-line index', () => {
    const d = buildDiffModel(OLD, NEW, { from: 1, to: 2 });
    expect(d.kind).toBe('rows');
    expect(d.rows.map((r) => r.kind)).toEqual(['ctx', 'ctx', 'ctx', 'del', 'add', 'add', 'ctx', 'del', 'del']);
    // the trailing newline of NEW does not create a line (the review screen does not show one)
    expect(d.rows.at(-1)).toMatchObject({ kind: 'del', oldLine: 7, text: 'old last line' });
    expect(d.rows.some((r) => r.newLine === 7)).toBe(false);
    expect(d.rows[3]).toMatchObject({ kind: 'del', oldLine: 4 });
    expect(d.rows[3].newLine).toBeUndefined();
    expect(d.rows[4]).toMatchObject({ kind: 'add', newLine: 4 });
    expect(d.rows[5]).toMatchObject({ kind: 'add', newLine: 5, text: 'added line' });
    expect(d.changeStarts).toEqual([3, 7]);
    expect(d.rowOfNew.get(3)).toBe(4); // new line 4 (0-based 3) is row 4
    expect(d.summary).toEqual({ added: 2, removed: 3 });
    expect(d.texts).toHaveLength(d.rows.length);
    expect(d.numWidth).toBe(1);
    expect(d.gutterWidth).toBe(2 * 1 + 5);
  });

  it('word-level marks are on the paired lines only', () => {
    const d = buildDiffModel(OLD, NEW, { from: 1, to: 2 });
    expect(d.rows[3].words).toBeTruthy();
    expect(d.rows[4].words).toBeTruthy();
    expect(d.rows[5].words).toBeUndefined(); // the unpaired added line
    const w = d.rows[4].words.map(([a, b]) => d.rows[4].text.slice(a, b)).join('|');
    expect(w).toContain('BETA');
  });

  it('identical texts and too large diffs have no rows', () => {
    expect(buildDiffModel('a\nb', 'a\nb\n', { from: 1, to: 2 }).kind).toBe('identical'); // only the final newline differs
    const big = buildDiffModel(Array.from({ length: 2100 }, (_, i) => `old ${i}`).join('\n'), Array.from({ length: 2100 }, (_, i) => `new ${i}`).join('\n'), { from: 1, to: 2 });
    expect(big.kind).toBe('tooLarge');
    expect(big.rows).toEqual([]);
    expect(big.summary.added + big.summary.removed).toBeGreaterThan(2000);
  });

  it('numWidth follows the largest line number of either side', () => {
    const a = Array.from({ length: 120 }, (_, i) => `l${i}`);
    const b = a.slice();
    b[5] = 'changed';
    const d = buildDiffModel(a.join('\n'), b.join('\n'), { from: 1, to: 2 });
    expect(d.numWidth).toBe(3);
    expect(d.gutterWidth).toBe(11);
  });

  it('jump target: the new line of the row; for a removed line the line that follows; clamped to the document', () => {
    const d = buildDiffModel(OLD, NEW, { from: 1, to: 2 });
    expect(jumpLine0(d, 4, 6)).toBe(3); // an added row: its own new line (0-based)
    expect(jumpLine0(d, 3, 6)).toBe(3); // the removed line 4: the next surviving line is new line 4
    expect(jumpLine0(d, 8, 6)).toBe(5); // a removal at the end: the last line
    expect(jumpLine0(d, 7, 6)).toBe(5);
    expect(newLine0(d, 3)).toBeNull();
    expect(newLine0(d, 0)).toBe(0);
  });

  it(']c / [c step over blocks of changes without wrapping', () => {
    const d = buildDiffModel(OLD, NEW, { from: 1, to: 2 });
    expect(blockStart(d, 5)).toBe(3);
    expect(blockStart(d, 1)).toBeNull();
    expect(stepChange(d, 0, 1)).toBe(3);
    expect(stepChange(d, 3, 1)).toBe(7);
    expect(stepChange(d, 5, 1)).toBe(7);
    expect(stepChange(d, 7, 1)).toBeNull();
    expect(stepChange(d, 8, 1)).toBeNull();
    expect(stepChange(d, 8, -1)).toBe(3);
    expect(stepChange(d, 5, -1)).toBeNull(); // inside the first block
    expect(stepChange(d, 6, -1)).toBe(3);
  });

  it('loadDiffModel reads the two revisions through the injected reader', () => {
    const texts = { 1: 'a\nb', 2: 'a\nc', 3: 'a\nc\nd' };
    const read = (_id, n) => texts[n];
    const m = loadDiffModel('doc-x', meta(), null, { readRev: read });
    expect([m.from, m.to]).toEqual([2, 3]);
    expect(m.summary).toEqual({ added: 1, removed: 0 });
    const m1 = loadDiffModel('doc-x', meta(), 1, { readRev: read });
    expect([m1.from, m1.to]).toEqual([1, 3]);
    expect(loadDiffModel('doc-x', meta([1]), null, { readRev: read })).toBeNull();
  });
});

const rowFor = (model, idx, width = 60) => {
  const doc = new DocLayout(model.texts).configure({ width, gutterWidth: model.gutterWidth, tabWidth: 4 });
  return { doc, rows: doc.rows(idx) };
};

describe('renderDiffRow', () => {
  const model = buildDiffModel(OLD, NEW, { from: 1, to: 2 });
  const view = buildThreadView([thread('t1', anchor(4))], 6);
  const rc = { rows: model.rows, numWidth: model.numWidth, textWidth: 60 - model.gutterWidth, cursor: 4, markers: view.markers };

  it('gutter: old and new numbers, thread marker on a new line, sign, bar; exactly the pane width', () => {
    const del = renderDiffRow(rowFor(model, 3).rows[0], rc);
    expect(segsText(del).slice(0, model.gutterWidth)).toBe('4   -│ ');
    const add = renderDiffRow(rowFor(model, 4).rows[0], rc);
    expect(segsText(add).slice(0, model.gutterWidth)).toBe('  4▌+│ ');
    const ctx = renderDiffRow(rowFor(model, 2).rows[0], rc);
    expect(segsText(ctx).slice(0, model.gutterWidth)).toBe('3 3  │ ');
    for (const r of [del, add, ctx]) expect(segsText(r).length).toBeGreaterThanOrEqual(60 - 8); // padded (the CJK text is wide)
  });

  it('removed lines are red, added lines green; the words that differ are stronger; context is plain', () => {
    const del = renderDiffRow(rowFor(model, 3).rows[0], rc);
    const bgs = del.filter((s) => s.style?.bg).map((s) => s.style.bg);
    expect(bgs).toContain(COLOR.bgDel);
    const add = renderDiffRow(rowFor(model, 4).rows[0], rc);
    expect(add.some((s) => s.style?.bg === COLOR.bgAdd)).toBe(true);
    const words = add.filter((s) => s.style?.bg === COLOR.bgAddWord).map((s) => s.text);
    expect(words.join('|')).toContain('BETA');
    expect(words.join('|')).not.toContain('alpha');
    const ctx = renderDiffRow(rowFor(model, 2).rows[0], rc);
    expect(ctx.slice(7).every((s) => !s.style?.bg)).toBe(true);
  });

  it('the cursor row has inverse line numbers on its first screen row only', () => {
    const { rows } = rowFor(model, 4, 14); // narrow: the text wraps
    expect(rows.length).toBeGreaterThan(1);
    const first = renderDiffRow(rows[0], rc);
    const second = renderDiffRow(rows[1], rc);
    expect(first.some((s) => s.style?.inverse)).toBe(true);
    expect(second.some((s) => s.style?.inverse)).toBe(false);
    expect(segsText(second).slice(0, model.gutterWidth).trim()).toBe('│'); // no numbers, no sign on a continuation
  });
});

describe('buildDiffFrame', () => {
  const model = buildDiffModel(OLD, NEW, { from: 1, to: 2 });
  const mk = (extra = {}) => {
    const view = buildThreadView([thread('t1', anchor(4)), thread('t2', anchor(5))], 6);
    const s = { ...initialState(), diff: { base: null, cursor: null, top: null }, ...extra };
    return { view, s, doc: new DocLayout([]) };
  };

  it('starts on the first change; the panel puts cards next to their new lines', () => {
    const { view, s, doc } = mk();
    const f = buildDiffFrame({ s, doc, model, view, meta: { kind: 'doc', status: 'in_review', currentRevision: 2 }, size: { columns: 160, rows: 30 } });
    expect(f.cursor).toBe(3);
    expect(f.state.diff.cursor).toBe(3);
    expect(f.state.diff.top).toBeTruthy();
    expect(f.docRows).toHaveLength(f.geo.bodyH);
    expect(f.wide).toBe(true);
    expect(f.panelRows).toHaveLength(f.geo.bodyH);
    expect(f.panel.cards.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(f.layout.length).toBeGreaterThan(0);
    expect(f.dctx.lineCount).toBe(model.rows.length);
  });

  it('an empty panel explains that the diff is read-only instead of offering to select text', () => {
    const view = buildThreadView([], 6);
    const f = buildDiffFrame({ s: { ...initialState(), diff: { base: null, cursor: null, top: null } }, doc: new DocLayout([]), model, view, meta: { kind: 'doc', status: 'in_review', currentRevision: 2 }, size: { columns: 160, rows: 30 } });
    const text = f.panelRows.map(segsText).join('\n');
    expect(text).toContain('the diff view is read-only');
    expect(text).not.toContain('v selects text');
  });

  it('narrow layout: the drawer shows the threads of the cursor row (none on a removed line)', () => {
    const { view, s, doc } = mk();
    const m = { kind: 'doc', status: 'in_review', currentRevision: 2 };
    const narrow = buildDiffFrame({ s, doc, model, view, meta: m, size: { columns: 80, rows: 30 } });
    expect(narrow.wide).toBe(false);
    expect(narrow.drawer).toBeTruthy();
    expect(segsText(narrow.drawer.rows[0])).toContain('no comment'); // the cursor is on the removed line
    const moved = buildDiffFrame({ s: { ...s, diff: { ...narrow.state.diff, cursor: 4 }, focusId: 't1' }, doc, model, view, meta: m, size: { columns: 80, rows: 30 } });
    expect(moved.drawer.rows.map(segsText).join('\n')).toContain('t1');
  });

  it('too large / identical comparisons show a message instead of rows', () => {
    const big = { ...buildDiffModel('a', 'b', { from: 1, to: 2 }), kind: 'tooLarge', approximate: true, summary: { added: 3000, removed: 2500 } };
    const rows = diffMessageRows(big, 60, 6).map(segsText).join('\n');
    expect(rows).toContain('too many changes');
    expect(rows).toContain('+3000 / -2500');
    expect(rows).toContain('about');
    const same = diffMessageRows(buildDiffModel('a', 'a', { from: 1, to: 2 }), 60, 6).map(segsText).join('\n');
    expect(same).toContain('no differences');
    const view = buildThreadView([], 1);
    const f = buildDiffFrame({ s: { ...initialState(), diff: { base: null, cursor: null, top: null } }, doc: new DocLayout([]), model: big, view, meta: { kind: 'doc', status: 'in_review', currentRevision: 2 }, size: { columns: 100, rows: 24 } });
    expect(f.docRows.map(segsText).join('\n')).toContain('too many changes');
    expect(f.cursorNew).toBeNull();
  });
});

describe('diffNav', () => {
  const model = buildDiffModel(OLD, NEW, { from: 1, to: 2 });
  const view = buildThreadView([thread('t1', anchor(4)), thread('t2', anchor(6))], 6);
  const doc = new DocLayout(model.texts).configure({ width: 80, gutterWidth: model.gutterWidth, tabWidth: 4 });
  const dctx = { doc, bodyH: 5, model, view, lineCount: model.rows.length };
  const open = () => ({ ...dnav.openDiff({ ...initialState(), mode: 'visual', visual: { kind: 'line', anchor: { line: 0, off: 0 } } }), diff: { base: null, cursor: 3, top: { line: 0, sub: 0 } } });

  it('opening drops a selection; moving keeps the cursor in the pane and follows the thread under it', () => {
    const o = dnav.openDiff({ ...initialState(), mode: 'visual', visual: { kind: 'char', anchor: { line: 1, off: 0 } } });
    expect(o.mode).toBe('normal');
    expect(o.visual).toBeNull();
    expect(o.diff).toEqual({ base: null, cursor: null, top: null });
    let s = open();
    s = dnav.moveDiffCursor(s, dctx, 1); // row 4 = new line 4: t1
    expect(s.diff.cursor).toBe(4);
    expect(s.focusId).toBe('t1');
    s = dnav.moveDiffCursor(s, dctx, 100);
    expect(s.diff.cursor).toBe(model.rows.length - 1);
    expect(s.focusId).toBeNull(); // a removed line has no threads
    s = dnav.setDiffCursor(s, dctx, 0);
    expect(s.diff.cursor).toBe(0);
    expect(s.diff.top.line).toBe(0);
  });

  it('page and wheel scrolling drag the cursor along', () => {
    const s = open();
    const down = dnav.pageDiff(s, dctx, 1, 1);
    expect(down.diff.cursor).toBeGreaterThan(3);
    expect(down.diff.top.line).toBeGreaterThan(0);
    const wheel = dnav.scrollDiff({ ...s, diff: { ...s.diff, cursor: 0 } }, dctx, 3);
    expect(wheel.diff.top.line).toBeGreaterThanOrEqual(1);
    expect(wheel.diff.cursor).toBeGreaterThanOrEqual(0);
  });

  it('change stepping returns the same state at the ends; the base steps and resets the position', () => {
    const s = open();
    const next = dnav.stepDiffChange(s, dctx, 1);
    expect(next.diff.cursor).toBe(7);
    expect(dnav.stepDiffChange(next, dctx, 1)).toBe(next);
    expect(dnav.stepDiffChange(s, dctx, -1)).toBe(s);
    const m = meta([1, 2, 3]);
    const older = dnav.stepDiffBase(s, m, -1);
    expect(older.diff).toEqual({ base: 1, cursor: null, top: null });
    expect(dnav.stepDiffBase(older, m, -1)).toBe(older);
    expect(dnav.stepDiffBase(older, m, 1).diff.base).toBe(2);
  });

  it('Enter leaves the diff and puts the normal cursor on the new line, focusing its thread', () => {
    const s = { ...open(), diff: { base: null, cursor: 4, top: { line: 0, sub: 0 } } };
    const back = dnav.jumpToNormal(s, dctx, { lineCount: 6, bodyH: 20 });
    expect(back.diff).toBeNull();
    expect(back.cursor).toBe(3);
    expect(back.col).toBe(0);
    expect(back.focusId).toBe('t1');
    expect(back.keepRow).toBe(6);
    expect(dnav.closeDiff(s).diff).toBeNull();
  });

  it('mouse: the wheel scrolls, a click moves the cursor, a card click focuses its line, status buttons are effects', () => {
    const s = open();
    const geo = { cols: 160, rows: 30, wide: true, bodyY: 2, bodyH: 5, docX: 0, docW: 100, panelX: 101, panelW: 59, statusY: 29, headerY: 0, drawerH: 0 };
    const win = doc.window(s.diff.top, geo.bodyH);
    const layout = Object.assign(win.rows.slice(), {});
    Object.defineProperty(layout, 'meta', { value: { width: 80, gutterWidth: model.gutterWidth, textWidth: 80 - model.gutterWidth, tabWidth: 4 } });
    const f = { geo, dctx, layout, panel: { shift: 0, clamp: (n) => n, cards: [{ id: 't2', y0: 0, y1: 3 }] }, statusButtons: [{ x0: 1, x1: 9, action: 'diffBack' }] };
    const wheel = dnav.handleDiffMouse(mouse('wheel', 10, 4, 'wheelDown'), s, f);
    expect(wheel.state.diff.top.line).toBeGreaterThan(s.diff.top.line);
    const click = dnav.handleDiffMouse(mouse('press', 20, 3 + 2), s, f); // body row 3 = row 3 of the pane
    expect(click.state.diff.cursor).toBe(win.rows[3].line);
    const card = dnav.handleDiffMouse(mouse('press', 120, 3), s, f);
    expect(card.state.focusId).toBe('t2');
    expect(card.state.diff.cursor).toBe(model.rowOfNew.get(5)); // t2 is anchored at new line 6
    const btn = dnav.handleDiffMouse(mouse('press', 3, 29), s, f);
    expect(btn.effect).toEqual({ type: 'action', name: 'diffBack' });
  });
});

describe('diff keymap', () => {
  const k = (extra = {}) => ({ ctrl: false, meta: false, shift: false, escape: false, return: false, tab: false, ...extra });
  it('navigation, base, jump and back', () => {
    expect(mapDiffKey('j', k(), null)).toEqual({ action: 'down' });
    expect(mapDiffKey('', k({ upArrow: true }), null)).toEqual({ action: 'up' });
    expect(mapDiffKey('<', k(), null)).toEqual({ action: 'diffOlder' });
    expect(mapDiffKey('>', k(), null)).toEqual({ action: 'diffNewer' });
    expect(mapDiffKey('', k({ return: true }), null)).toEqual({ action: 'diffJump' });
    for (const back of ['d', 'q']) expect(mapDiffKey(back, k(), null)).toEqual({ action: 'diffBack' });
    expect(mapDiffKey('', k({ escape: true }), null)).toEqual({ action: 'diffBack' });
    expect(mapDiffKey('c', k({ ctrl: true }), null)).toEqual({ action: 'diffBack' });
    expect(mapDiffKey(']', k(), null)).toEqual({ action: 'pendingKey', pending: ']' });
    expect(mapDiffKey('c', k(), ']')).toEqual({ action: 'diffNext' });
    expect(mapDiffKey('c', k(), '[')).toEqual({ action: 'diffPrev' });
    expect(mapDiffKey('d', k({ ctrl: true }), null)).toEqual({ action: 'halfDown' });
    expect(mapDiffKey('?', k(), null)).toEqual({ action: 'help' });
  });
  it('every key that would change something only says the view is read-only', () => {
    for (const key of 'cCrRxDvVsBAEMUOS') expect(mapDiffKey(key, k(), null)).toEqual({ action: 'diffReadOnly' });
    expect(mapDiffKey('z', k(), null)).toBeNull();
  });
  it('dialog and picker keys', () => {
    expect(mapDialogKey('c', k())).toBe('show');
    expect(mapDialogKey('h', k())).toBe('headless');
    for (const leave of ['l', 'q']) expect(mapDialogKey(leave, k())).toBe('leave');
    expect(mapDialogKey('', k({ escape: true }))).toBe('leave');
    expect(mapDialogKey('x', k())).toBeNull();
    expect(mapPickerKey('j', k())).toBe('down');
    expect(mapPickerKey('', k({ upArrow: true }))).toBe('up');
    expect(mapPickerKey('', k({ return: true }))).toBe('pick');
    expect(mapPickerKey('', k({ escape: true }))).toBe('cancel');
    expect(mapPickerKey('G', k())).toBe('bottom');
  });
});
