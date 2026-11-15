/**
 * Pure editor model for the comment box: `{ text, cursor }`.
 *
 *  - `text` is a string with `\n` line breaks only (input is normalised by {@link insert}).
 *  - `cursor` is a UTF-16 code-unit offset that always sits on a grapheme boundary.
 *  - Every function returns a NEW state (or the same object when nothing changes), never mutates.
 *  - Vertical movement works on *visual* rows (after soft wrapping at `width` columns) and uses
 *    the display column, so it behaves sensibly with CJK/double-width text. The column the user
 *    started from is remembered in the optional `goalCol` field across consecutive up/down moves;
 *    every other operation drops it.
 *
 * `width` arguments are the number of columns available for TEXT (the component reserves one
 * extra column for the caret at the end of a full row).
 *
 * No Ink / React imports, so everything here is unit-testable.
 */
import { buildLayout, hitTest, locate } from '../mouse/layout.js';
import { prevBoundary, nextBoundary, snapToBoundary, sanitizeInput } from './text.js';

export { sanitizeInput };

/**
 * @typedef {object} EditorState
 * @property {string} text
 * @property {number} cursor    UTF-16 offset in `text`, on a grapheme boundary.
 * @property {number} [goalCol] Column remembered for consecutive up/down moves.
 */

/**
 * @param {string} [text='']
 * @param {number} [cursor]  Defaults to the end of the text.
 * @returns {EditorState}
 */
export function createEditor(text = '', cursor = text.length) {
  return { text, cursor: snapToBoundary(text, Math.max(0, Math.min(cursor, text.length))) };
}

/**
 * Insert a string at the cursor (a whole IME commit or paste in one operation). CRLF/CR become
 * `\n`; ANSI sequences and control characters other than TAB/LF are dropped.
 * @param {EditorState} state
 * @param {string} str
 * @returns {EditorState}
 */
export function insert(state, str) {
  const s = sanitizeInput(str);
  if (!s) return state;
  const { text, cursor } = state;
  const next = text.slice(0, cursor) + s + text.slice(cursor);
  return { text: next, cursor: snapToBoundary(next, cursor + s.length) };
}

/** Insert a line break. */
export function newline(state) {
  return insert(state, '\n');
}

/** Delete the grapheme before the cursor (a whole emoji / base+combining cluster). */
export function backspace(state) {
  const { text, cursor } = state;
  if (cursor <= 0) return state;
  const prev = prevBoundary(text, cursor);
  return { text: text.slice(0, prev) + text.slice(cursor), cursor: prev };
}

/** Delete the grapheme after the cursor. */
export function deleteForward(state) {
  const { text, cursor } = state;
  if (cursor >= text.length) return state;
  const next = nextBoundary(text, cursor);
  return { text: text.slice(0, cursor) + text.slice(next), cursor };
}

/** Move one grapheme left (crosses line breaks). */
export function left(state) {
  if (state.cursor <= 0) return state;
  return { text: state.text, cursor: prevBoundary(state.text, state.cursor) };
}

/** Move one grapheme right (crosses line breaks). */
export function right(state) {
  if (state.cursor >= state.text.length) return state;
  return { text: state.text, cursor: nextBoundary(state.text, state.cursor) };
}

/** Move to the start of the current logical line (between `\n`s). */
export function home(state) {
  const start = state.text.lastIndexOf('\n', state.cursor - 1) + 1;
  return start === state.cursor ? state : { text: state.text, cursor: start };
}

/** Move to the end of the current logical line. */
export function end(state) {
  let e = state.text.indexOf('\n', state.cursor);
  if (e === -1) e = state.text.length;
  return e === state.cursor ? state : { text: state.text, cursor: e };
}

/**
 * Place the cursor at an arbitrary offset (snapped to a grapheme boundary and clamped).
 * @param {EditorState} state
 * @param {number} offset
 */
export function setCursor(state, offset) {
  const c = snapToBoundary(state.text, Math.max(0, Math.min(offset, state.text.length)));
  return c === state.cursor ? state : { text: state.text, cursor: c };
}

/**
 * Wrapped view of the text.
 * @typedef {object} VisualRow
 * @property {number} start   Global offset where the row starts.
 * @property {number} end     Global offset just past the row.
 * @property {string} text    Printable text of the row (tabs expanded).
 * @property {number} width   Columns used.
 * @property {import('../mouse/layout.js').Cell[]} cells  Cells; `start`/`end` are relative to the source line.
 * @property {number} lineStart  Global offset of the source line this row belongs to.
 *
 * @typedef {object} VisualView
 * @property {VisualRow[]} rows
 * @property {{row: number, col: number, cell: number}} cursor  Caret row/col (col relative to the text area),
 *           `cell` is the index into `rows[row].cells` under the caret or -1 at the end of the row.
 * @property {import('../mouse/layout.js').Layout} layout  The underlying layout (one source line per `\n`-separated line).
 * @property {number[]} _starts  Global offset of each logical line (internal helper for up/down).
 */

/**
 * Wrap the text at `width` columns and locate the cursor.
 * @param {EditorState} state
 * @param {number} width       Text columns.
 * @param {{tabWidth?: number}} [opts]
 * @returns {VisualView}
 */
export function visualRows(state, width, { tabWidth = 4 } = {}) {
  const lines = state.text.split('\n');
  const starts = [];
  let acc = 0;
  for (const l of lines) {
    starts.push(acc);
    acc += l.length + 1;
  }
  const layout = buildLayout(lines, { width, tabWidth });
  const rows = layout.map((r) => ({
    start: starts[r.line] + r.startOffset,
    end: starts[r.line] + r.endOffset,
    text: r.text,
    width: r.width,
    cells: r.cells,
    lineStart: starts[r.line],
  }));
  // Locate the cursor: find the logical line, then the row inside it.
  let line = lines.length - 1;
  while (line > 0 && starts[line] > state.cursor) line--;
  const loc = locate(layout, line, state.cursor - starts[line]) ?? { row: 0, col: 0, cell: -1 };
  return { rows, cursor: loc, layout, _starts: starts };
}

function moveVertical(state, width, delta) {
  const view = visualRows(state, width);
  const target = view.cursor.row + delta;
  if (target < 0 || target >= view.rows.length) return state;
  const goal = state.goalCol ?? view.cursor.col;
  const hit = hitTest(view.layout, target, goal);
  const offset = view._starts[hit.line] + hit.offset;
  return { text: state.text, cursor: offset, goalCol: goal };
}

/**
 * Move up one visual row, keeping the display column. No-op on the first row.
 * @param {EditorState} state
 * @param {number} width  Text columns.
 */
export function up(state, width) {
  return moveVertical(state, width, -1);
}

/** Move down one visual row, keeping the display column. No-op on the last row. */
export function down(state, width) {
  return moveVertical(state, width, 1);
}

/**
 * Number of visual rows the text needs at `width` text columns (at least 1).
 * @param {string} text
 * @param {number} width
 */
export function countRows(text, width) {
  return visualRows({ text, cursor: 0 }, width).rows.length;
}
