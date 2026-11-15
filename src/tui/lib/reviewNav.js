// Pure state transitions of the review screen: cursor, scrolling, focus, selection. Nothing here touches Ink or the
// store.
//
// State (all fields are plain data):
//   cursor     0-based source line
//   col        UTF-16 offset of the cursor character in that line (a grapheme start), in the coordinates of the
//              current document view: the display text (hidden Markdown markers are not cursor positions) in rendered
//              mode, the source in source mode. Same for `visual.anchor.off`. `selectionToSel` converts to source.
//   md         'rendered' | 'source': how a Markdown document is shown (docView.js); keepRow: see switchView
//   offView    the document view the offsets above were last made relative to (set by buildReviewFrame, see convertOffsets)
//   goalCol    display column j / k try to keep (Infinity after `$`)
//   top        {line, sub} first visible row
//   mode       'normal' | 'visual' | 'input' | 'confirm' | 'help' | 'menu' | 'dialog' | 'picker'
//   diff       null, or the diff view's state while it is open (diffView.js); the fields above stay as they were
//   dialog     the channel C dialog's state while mode is 'dialog' (Review.js); picker: {items, index, first} while mode is 'picker'
//   helpTop    scroll of the help screen
//   visual     null, or {kind: 'char' | 'line', anchor: {line, off}} while a selection is being made
//   focusId    thread the r / x / D keys act on
//   panelScroll  null = panel follows the document; number = manual scroll in rows
//   pending    first key of a two-key sequence (] or [)
//   input, confirm, menu, notice  overlays
//
// `ctx` = { doc: DocLayout, bodyH, view: threadView, lineCount, lines: display lines, dv: document view (optional) }
import { colOf, offsetAtCol, clampOff, moveLeft, moveRight, nextWord, prevWord, wordEnd, firstNonBlank, lastOff } from './motions.js';
import { nextBoundary } from '../input/text.js';
import { linesToSel, normalizeRange, rangeToSel, spanOfLines, spanOfRange } from './selection.js';
import { asView } from './docView.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function initialState({ sendMode = 'instant', mouseOn = true, md = 'rendered' } = {}) {
  return {
    cursor: 0,
    col: 0,
    goalCol: 0,
    top: { line: 0, sub: 0 },
    mode: 'normal',
    visual: null,
    focusId: null,
    panelScroll: null,
    drawerScroll: 0,
    pending: null,
    input: null,
    confirm: null,
    menu: null,
    notice: null,
    sendMode,
    mouseOn,
    inputVersion: 0,
    md,
    keepRow: null,
    diff: null,
    dialog: null,
    picker: null,
    helpTop: 0,
  };
}

/** The thread to focus when the cursor is on `line`: keep the current one if it is there, else the first. */
export function focusFor(s, ctx, line = s.cursor) {
  const list = ctx.view.byLine.get(line);
  if (!list || list.length === 0) return null;
  return list.some((t) => t.id === s.focusId) ? s.focusId : list[0].id;
}

/**
 * Move the cursor to `line` (clamped), scroll it into view and refresh the focus.
 * The column follows `off` when given, else the goal column (vertical movement).
 */
export function setCursor(s, ctx, line, { focusId, margin = 2, off } = {}) {
  if (ctx.lineCount === 0) return s;
  const cursor = clamp(line, 0, ctx.lineCount - 1);
  const text = ctx.lines?.[cursor] ?? '';
  const top = ctx.doc.ensureVisible(s.top, cursor, ctx.bodyH, margin);
  const col = off != null ? clampOff(text, off) : offsetAtCol(text, s.goalCol);
  const next = { ...s, cursor, col, top, panelScroll: null, drawerScroll: 0, pending: null };
  if (off != null) next.goalCol = colOf(text, col);
  next.focusId = focusId !== undefined ? focusId : focusFor(next, ctx);
  return next;
}

export const moveCursor = (s, ctx, delta) => setCursor(s, ctx, s.cursor + delta);

/** Column motions: h l w b e 0 ^ $ (word motions may cross lines). */
export function moveColumn(s, ctx, motion) {
  const lines = ctx.lines;
  if (!lines || lines.length === 0) return s;
  const line = lines[s.cursor] ?? '';
  const pos = { line: s.cursor, off: s.col };
  let to;
  switch (motion) {
    case 'left':
      to = { line: pos.line, off: moveLeft(line, pos.off) };
      break;
    case 'right':
      to = { line: pos.line, off: moveRight(line, pos.off) };
      break;
    case 'wordNext':
      to = nextWord(lines, pos);
      break;
    case 'wordPrev':
      to = prevWord(lines, pos);
      break;
    case 'wordEnd':
      to = wordEnd(lines, pos);
      break;
    case 'lineStart':
      to = { line: pos.line, off: 0 };
      break;
    case 'firstNonBlank':
      to = { line: pos.line, off: firstNonBlank(line) };
      break;
    case 'lineEnd':
      to = { line: pos.line, off: lastOff(line) };
      break;
    default:
      return s;
  }
  const next = setCursor(s, ctx, to.line, { off: to.off, margin: 2 });
  if (motion === 'lineEnd') next.goalCol = Infinity; // like vim: j / k then stay at the end of lines
  return next;
}

/** Scroll the view by `rows`, dragging the cursor along when it would leave the viewport. */
export function scrollView(s, ctx, rows) {
  const top = ctx.doc.scrollBy(s.top, rows, ctx.bodyH);
  const { lo, hi } = ctx.doc.cursorBounds(top, ctx.bodyH);
  const cursor = clamp(s.cursor, lo, hi);
  const next = { ...s, top, cursor, panelScroll: null, drawerScroll: 0, pending: null };
  if (cursor !== s.cursor) {
    next.col = offsetAtCol(ctx.lines?.[cursor] ?? '', s.goalCol);
    next.focusId = focusFor(next, ctx);
  }
  return next;
}

/** Ctrl-d / Ctrl-u (`fraction` 0.5) and PageDown / PageUp (`fraction` 1). */
export function pageStep(s, ctx, dir, fraction = 0.5) {
  const rows = Math.max(1, Math.floor(ctx.bodyH * fraction) - (fraction >= 1 ? 1 : 0));
  const top = ctx.doc.scrollBy(s.top, dir * rows, ctx.bodyH);
  const wanted = ctx.doc.advance({ line: s.cursor, sub: 0 }, dir * rows).line;
  const { lo, hi } = ctx.doc.cursorBounds(top, ctx.bodyH);
  const cursor = clamp(wanted, lo, hi);
  const next = { ...s, top, cursor, col: offsetAtCol(ctx.lines?.[cursor] ?? '', s.goalCol), panelScroll: null, drawerScroll: 0, pending: null };
  next.focusId = focusFor(next, ctx);
  return next;
}

/** Scroll so `line` sits about a third from the top unless it is already comfortably visible. */
export function revealLine(s, ctx, line) {
  const win = ctx.doc.window(s.top, ctx.bodyH);
  const row = win.rowOf(line);
  const m = 2;
  if (row >= m && row + ctx.doc.rowCount(line) - 1 <= ctx.bodyH - 1 - m) return s;
  const top = ctx.doc.scrollBy({ line, sub: 0 }, -Math.floor(ctx.bodyH / 3), ctx.bodyH);
  return { ...s, top };
}

/** Focus a thread and bring its anchor into view (panel click, ]c / [c). */
export function jumpToThread(s, ctx, thread) {
  if (!thread) return s;
  if (thread.anchor.orphaned) return { ...s, focusId: thread.id, panelScroll: null, pending: null };
  const line = clamp(thread.anchor.startLine - 1, 0, Math.max(0, ctx.lineCount - 1));
  const moved = revealLine({ ...s, cursor: line }, ctx, line);
  // The anchor column is a source offset; the cursor lives in view coordinates.
  const col = thread.anchor.startCol;
  const off = col == null ? 0 : ctx.dv ? ctx.dv.toDisp(line, col) : col;
  return setCursor({ ...moved, panelScroll: null }, ctx, line, { focusId: thread.id, off });
}

// --- visual mode ---------------------------------------------------------------------------------------------------

/**
 * `v` / `V`. From Normal mode start a selection at the cursor; inside Visual mode the other key switches between
 * character and line selection (keeping the anchor), the same key leaves Visual mode.
 */
export function enterVisual(s, kind) {
  if (s.visual) {
    if (s.visual.kind === kind) return clearSelection(s);
    return { ...s, visual: { ...s.visual, kind }, pending: null };
  }
  return { ...s, mode: 'visual', visual: { kind, anchor: { line: s.cursor, off: s.col } }, menu: null, pending: null };
}

/** Leave visual mode and drop the selection. */
export function clearSelection(s) {
  return { ...s, mode: s.mode === 'visual' ? 'normal' : s.mode, visual: null, pending: null };
}

/**
 * The selected text range of a character-wise selection (the character under the cursor is included), or null.
 * @returns {import('./selection.js').Range | null}
 */
export function visualRange(s, lines) {
  if (s.visual?.kind !== 'char') return null;
  const a = s.visual.anchor;
  const c = { line: s.cursor, off: s.col };
  const [from, to] = a.line < c.line || (a.line === c.line && a.off <= c.off) ? [a, c] : [c, a];
  const end = { line: to.line, off: nextBoundary(lines[to.line] ?? '', to.off) };
  return normalizeRange({ start: from, end }, lines);
}

/**
 * Store selection for makeAnchor: character columns for `v`, whole lines for `V` and for plain `c`.
 * The selection was made on the view's display text; the columns that leave here are SOURCE offsets: the first selected
 * real character to the end of the last one (a hidden marker between them is part of the quote, one outside is not).
 * @param {object} s
 * @param {string[] | import('./docView.js').makeSourceView} lines  a document view, or source lines (= the source view)
 */
export function selectionToSel(s, lines) {
  if (s.visual?.kind === 'char') {
    const dv = asView(lines);
    const r = visualRange(s, dv.lines);
    const sr = r ? dv.srcRange(r) : null;
    const norm = sr ? normalizeRange(sr, dv.srcLines) : null;
    return norm ? rangeToSel(norm) : linesToSel(s.cursor, s.cursor);
  }
  if (s.visual?.kind === 'line') return linesToSel(s.visual.anchor.line, s.cursor);
  return linesToSel(s.cursor, s.cursor);
}

/**
 * What the selection covers, for highlighting (null when nothing is selected). The span is in DISPLAY offsets of the
 * view, i.e. exactly the characters the user moved over; draw it with `space: 'disp'`.
 * @param {string[] | {lines: string[]}} lines  display lines, or a document view
 */
export function visualSpan(s, lines) {
  if (!s.visual) return null;
  if (s.visual.kind === 'line') return spanOfLines(s.visual.anchor.line, s.cursor);
  const r = visualRange(s, Array.isArray(lines) ? lines : lines.lines);
  return r ? spanOfRange(r) : spanOfLines(s.cursor, s.cursor);
}

// --- Markdown rendered / source ------------------------------------------------------------------------------------------

/**
 * Switch the document view (the `M` key). `row` (the cursor line's screen row before the switch, or null) is applied by
 * buildReviewFrame once the new layout exists, so the cursor line stays where it was on screen. The cursor and the
 * Visual anchor are converted there too (convertOffsets), like for any other change of the view.
 * @param {object} s
 * @param {'rendered' | 'source'} md  the mode being switched to
 * @param {number | null} row
 */
export function switchView(s, md, row) {
  return { ...s, md, keepRow: row, pending: null, panelScroll: null };
}

/**
 * The state's offsets (cursor column, Visual anchor) are relative to the view they were made in. When the view changes
 * (M, a resize that renders a table differently, a new revision) they keep pointing at the same SOURCE character:
 * display -> source in the old view, source -> display in the new one.
 * @param {object} s
 * @param {object | null | undefined} from  the view the offsets belong to
 * @param {object} to  the view being drawn now
 */
export function convertOffsets(s, from, to) {
  if (!from || from === to || (from.kind === 'source' && to.kind === 'source')) return s;
  const conv = (line, off) => {
    if (line < 0 || line >= from.count || line >= to.count) return off;
    return clampOff(to.lines[line] ?? '', to.toDisp(line, from.toSrc(line, off)));
  };
  const col = conv(s.cursor, s.col);
  const visual = s.visual ? { ...s.visual, anchor: { line: s.visual.anchor.line, off: conv(s.visual.anchor.line, s.visual.anchor.off) } } : null;
  return { ...s, col, goalCol: s.goalCol === Infinity ? Infinity : colOf(to.lines[s.cursor] ?? '', col), visual };
}

/** Ordered list of thread ids shown in the narrow drawer: the focused thread, then the others on the cursor line. */
export function drawerThreadIds(s, ctx) {
  const ids = [];
  if (s.focusId) ids.push(s.focusId);
  for (const t of ctx.view.byLine.get(s.cursor) ?? []) if (!ids.includes(t.id)) ids.push(t.id);
  return ids;
}
