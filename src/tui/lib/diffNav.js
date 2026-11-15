// State transitions and mouse handling of the diff view. Pure, like reviewNav.js / reviewMouse.js; the diff state lives in
// `s.diff` (see diffView.js) next to the normal view's state, which stays untouched while the diff is open.
//
// `dctx` = {doc: DocLayout over the diff rows, bodyH, model: DiffModel, view: threadView, lineCount: rows}
import { hitTest } from '../mouse/layout.js';
import { regionAt } from './geometry.js';
import { clearSelection } from './reviewNav.js';
import { newLine0, jumpLine0, stepChange, stepBase } from './diffModel.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const WHEEL_ROWS = 3;

/** Thread to focus for a diff row: the current one when it is on the row's new line, else the first there, else none. */
function focusForRow(s, dctx, idx) {
  const l0 = newLine0(dctx.model, idx);
  const list = l0 == null ? null : dctx.view.byLine.get(l0);
  if (!list || list.length === 0) return null;
  return list.some((t) => t.id === s.focusId) ? s.focusId : list[0].id;
}

/** `d`: open the diff view (a Visual selection is dropped). */
export function openDiff(s) {
  return { ...clearSelection(s), diff: { base: null, cursor: null, top: null }, panelScroll: null, drawerScroll: 0, pending: null };
}

export const closeDiff = (s) => ({ ...s, diff: null, pending: null, panelScroll: null, drawerScroll: 0 });

/** Move the cursor to row `idx` and scroll it into view. */
export function setDiffCursor(s, dctx, idx, { margin = 2, focusId } = {}) {
  if (dctx.lineCount === 0) return s;
  const cursor = clamp(idx, 0, dctx.lineCount - 1);
  const top = dctx.doc.ensureVisible(s.diff.top ?? { line: 0, sub: 0 }, cursor, dctx.bodyH, margin);
  const next = { ...s, diff: { ...s.diff, cursor, top }, panelScroll: null, drawerScroll: 0, pending: null };
  next.focusId = focusId !== undefined ? focusId : focusForRow(next, dctx, cursor);
  return next;
}

export const moveDiffCursor = (s, dctx, delta) => setDiffCursor(s, dctx, (s.diff.cursor ?? 0) + delta);

/** Ctrl-d / Ctrl-u (fraction 0.5) and PageDown / PageUp (1): scroll and drag the cursor along. */
export function pageDiff(s, dctx, dir, fraction = 0.5) {
  if (dctx.lineCount === 0) return s;
  const rows = Math.max(1, Math.floor(dctx.bodyH * fraction) - (fraction >= 1 ? 1 : 0));
  const cur = s.diff.cursor ?? 0;
  const top = dctx.doc.scrollBy(s.diff.top ?? { line: 0, sub: 0 }, dir * rows, dctx.bodyH);
  const wanted = dctx.doc.advance({ line: cur, sub: 0 }, dir * rows).line;
  const { lo, hi } = dctx.doc.cursorBounds(top, dctx.bodyH);
  const cursor = clamp(wanted, lo, hi);
  const next = { ...s, diff: { ...s.diff, cursor, top }, panelScroll: null, drawerScroll: 0, pending: null };
  next.focusId = focusForRow(next, dctx, cursor);
  return next;
}

/** Mouse wheel: scroll by `rows` screen rows, dragging the cursor along when it would leave the pane. */
export function scrollDiff(s, dctx, rows) {
  if (dctx.lineCount === 0) return s;
  const top = dctx.doc.scrollBy(s.diff.top ?? { line: 0, sub: 0 }, rows, dctx.bodyH);
  const { lo, hi } = dctx.doc.cursorBounds(top, dctx.bodyH);
  const cur = s.diff.cursor ?? 0;
  const cursor = clamp(cur, lo, hi);
  const next = { ...s, diff: { ...s.diff, cursor, top }, panelScroll: null, drawerScroll: 0, pending: null };
  if (cursor !== cur) next.focusId = focusForRow(next, dctx, cursor);
  return next;
}

/** `]c` / `[c`: the next / previous block of changes. Returns `s` itself when there is none that way. */
export function stepDiffChange(s, dctx, dir) {
  const to = stepChange(dctx.model, s.diff.cursor ?? 0, dir);
  if (to == null) return s;
  return setDiffCursor(s, dctx, to, { margin: 3 });
}

/** `<` (older base) / `>` (newer base). Returns `s` itself at the end of the range. The view starts at the first change again. */
export function stepDiffBase(s, meta, dir) {
  const r = stepBase(meta, s.diff.base, dir);
  if (r.edge) return s;
  return { ...s, diff: { base: r.base, cursor: null, top: null }, panelScroll: null, drawerScroll: 0, pending: null };
}

/**
 * `Enter`: leave the diff and put the normal view's cursor on the line of the row (a removed line: where it was removed).
 * The normal view's frame places the cursor line about a third from the top (`keepRow`).
 * @param {number} lineCount  lines of the current document
 */
export function jumpToNormal(s, dctx, { lineCount, bodyH }) {
  const line = jumpLine0(dctx.model, s.diff.cursor ?? 0, lineCount);
  const list = dctx.view.byLine.get(line);
  const focusId = list && list.length ? (list.some((t) => t.id === s.focusId) ? s.focusId : list[0].id) : null;
  return { ...s, diff: null, cursor: line, col: 0, goalCol: 0, keepRow: Math.floor(Math.max(1, bodyH) / 3), focusId, panelScroll: null, drawerScroll: 0, pending: null };
}

/**
 * Mouse in the diff view. `f` = {geo, layout, panel, statusButtons, dctx}.
 * @returns {{state: object, effect: object | null}}
 */
export function handleDiffMouse(ev, s, f) {
  const { geo, dctx } = f;
  const none = (state) => ({ state, effect: null });
  const left = ev.button === 'left';
  const region = regionAt(geo, ev.x, ev.y);

  if (ev.kind === 'wheel') {
    const dir = ev.button === 'wheelUp' ? -1 : ev.button === 'wheelDown' ? 1 : 0;
    if (!dir) return none(s);
    if (region === 'doc') return none(scrollDiff(s, dctx, dir * WHEEL_ROWS));
    if (region === 'drawer') return none({ ...s, drawerScroll: Math.max(0, s.drawerScroll + dir * WHEEL_ROWS) });
    if (region === 'panel') return none({ ...s, panelScroll: f.panel.clamp((s.panelScroll ?? f.panel.shift) + dir * WHEEL_ROWS) });
    return none(s);
  }
  if (ev.kind !== 'press' || !left) return none(s);

  if (region === 'status') {
    const b = f.statusButtons.find((x) => ev.x >= x.x0 && ev.x < x.x1);
    return b ? { state: s, effect: { type: 'action', name: b.action } } : none(s);
  }
  if (region === 'panel') {
    const y = ev.y - geo.bodyY;
    const card = f.panel.cards.find((c) => y >= c.y0 && y < c.y1);
    if (!card) return none(s);
    const t = dctx.view.order.find((x) => x.id === card.id);
    if (!t) return none(s);
    const idx = t.anchor.orphaned ? undefined : dctx.model.rowOfNew.get(t.anchor.startLine - 1);
    if (idx == null) return none({ ...s, focusId: t.id, panelScroll: null });
    return none(setDiffCursor(s, dctx, idx, { margin: 3, focusId: t.id }));
  }
  if (region === 'doc') {
    if (dctx.lineCount === 0) return none(s);
    const hit = hitTest(f.layout, ev.y - geo.bodyY, ev.x - geo.docX);
    if (!hit) return none(s);
    return none(setDiffCursor(s, dctx, hit.line, { margin: 0 }));
  }
  return none(s);
}
