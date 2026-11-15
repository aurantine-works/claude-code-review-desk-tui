/**
 * Screen layout and mouse hit-testing for text panes (document body, comment editor).
 *
 * `buildLayout` turns source lines into wrapped screen rows while remembering which UTF-16
 * offsets of the source line each screen cell shows. `hitTest` maps a mouse cell back to a
 * (source line, offset) pair, and `locate` maps a (line, offset) caret back to a screen cell.
 *
 * Conventions:
 *  - Offsets are UTF-16 code-unit offsets into the *source line*.
 *  - Rows are cut on grapheme boundaries (`Intl.Segmenter`), never inside an emoji / combining
 *    sequence. Widths come from `string-width`; TAB expands to the next tab stop of the screen
 *    row; control characters occupy no columns and are never emitted (`display === ''`).
 *  - Wrapping prefers to break after a space/TAB (word wrap) and falls back to a hard break
 *    when a word is longer than the row (always the case for CJK text).
 *  - Only build layouts for the lines that are visible (virtual scrolling); every grapheme
 *    allocates a small cell object.
 *
 * Pure module: no Ink / React imports.
 */
import { splitGraphemes, graphemeWidth, isControl } from '../input/text.js';

/**
 * One grapheme as placed on a screen row.
 * @typedef {object} Cell
 * @property {number} start    Offset of the grapheme in the source line.
 * @property {number} end      Offset just past the grapheme.
 * @property {number} col      First column, relative to the text area (gutter excluded).
 * @property {number} width    Columns occupied (0 for control / zero-width, 2 for CJK, N for TAB).
 * @property {string} text     The source grapheme.
 * @property {string} display  What to print: TAB becomes spaces, control characters become ''.
 */

/**
 * One wrapped screen row.
 * @typedef {object} ScreenRow
 * @property {number} line         Source line index (`firstLine` + index into `lines`).
 * @property {number} startOffset  Offset in the source line where this row starts.
 * @property {number} endOffset    Offset just past this row (== next row's startOffset when wrapped).
 * @property {Cell[]} cells        One entry per grapheme of the row.
 * @property {number} width        Columns used by the row (text area only).
 * @property {string} text         Concatenated `display` of all cells.
 * @property {boolean} first       First screen row of its source line (draw the line number here).
 * @property {boolean} last        Last screen row of its source line.
 */

/**
 * @typedef {object} LayoutMeta
 * @property {number} width        Total columns, gutter included.
 * @property {number} gutterWidth
 * @property {number} textWidth    Columns available for text (`width - gutterWidth`, at least 1).
 * @property {number} tabWidth
 */

/**
 * A layout is a plain array of {@link ScreenRow} with a non-enumerable `meta` property.
 * @typedef {ScreenRow[] & { meta: LayoutMeta }} Layout
 */

/**
 * @param {string[]} lines  Source lines (without line terminators).
 * @param {object} opts
 * @param {number} opts.width            Total columns of the pane, gutter included.
 * @param {number} [opts.gutterWidth=0]  Columns reserved on the left (line numbers, markers).
 * @param {number} [opts.tabWidth=4]
 * @param {boolean} [opts.wordWrap=true] Break after spaces when possible.
 * @param {number} [opts.firstLine=0]    Index assigned to `lines[0]` (for windowed layouts).
 * @param {Map<number, number[]> | null} [opts.breaks]  Per line index (`firstLine` + i): offsets where a new row must
 *                                       start whatever the width allows (wrapped table rows, see mdRender.js).
 * @returns {Layout}
 */
export function buildLayout(lines, { width, gutterWidth = 0, tabWidth = 4, wordWrap = true, firstLine = 0, breaks = null } = {}) {
  const textWidth = Math.max(1, width - gutterWidth);
  const tw = Math.max(1, tabWidth);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    layoutLine(lines[i], firstLine + i, textWidth, tw, wordWrap, rows, breaks?.get(firstLine + i));
  }
  Object.defineProperty(rows, 'meta', {
    value: { width, gutterWidth, textWidth, tabWidth: tw },
    enumerable: false,
  });
  return /** @type {Layout} */ (rows);
}

function isBreakSpace(g) {
  return g === ' ' || g === '\t';
}

function cellFor(g, col, textWidth, tabWidth) {
  let width;
  let display = g.text;
  if (g.text === '\t') {
    width = Math.min(tabWidth - (col % tabWidth), Math.max(1, textWidth - col));
    display = ' '.repeat(width);
  } else if (isControl(g.text)) {
    width = 0;
    display = '';
  } else {
    width = graphemeWidth(g.text);
  }
  return { start: g.start, end: g.end, col, width, text: g.text, display };
}

function layoutLine(text, line, textWidth, tabWidth, wordWrap, out, breakAt) {
  const forced = breakAt?.length ? new Set(breakAt) : null;
  const gs = splitGraphemes(text);
  if (gs.length === 0) {
    out.push({ line, startOffset: 0, endOffset: 0, cells: [], width: 0, text: '', first: true, last: true });
    return;
  }
  let i = 0;
  let first = true;
  while (i < gs.length) {
    const startIdx = i;
    const cells = [];
    let col = 0;
    let lastBreak = -1; // grapheme index where a word-wrap break may happen (after a space)
    while (i < gs.length) {
      const g = gs[i];
      if (forced && cells.length > 0 && forced.has(g.start)) break; // a row ends here, no word-wrap look-back
      const cell = cellFor(g, col, textWidth, tabWidth);
      if (cell.width > 0 && col + cell.width > textWidth && cells.length > 0) {
        if (wordWrap && !isBreakSpace(g.text) && lastBreak > startIdx) {
          cells.length = lastBreak - startIdx;
          i = lastBreak;
        }
        break;
      }
      cells.push(cell);
      col += cell.width;
      if (isBreakSpace(g.text)) lastBreak = i + 1;
      i++;
    }
    const last = i >= gs.length;
    const rowWidth = cells.length ? cells[cells.length - 1].col + cells[cells.length - 1].width : 0;
    out.push({
      line,
      startOffset: gs[startIdx].start,
      endOffset: last ? text.length : gs[i].start,
      cells,
      width: rowWidth,
      text: cells.map((c) => c.display).join(''),
      first,
      last,
    });
    first = false;
  }
}

/**
 * Result of {@link hitTest}.
 * @typedef {object} Hit
 * @property {number} line    Source line index.
 * @property {number} offset  Caret offset inside the line, UTF-16, always on a grapheme boundary.
 *                            For a click on a character this is that character's start.
 * @property {number} row     Screen row index inside the layout.
 * @property {'gutter'|'text'|'eol'} region  Where the click landed.
 */

/**
 * Map a mouse cell to a source position.
 *
 *  - Click on either half of a double-width character -> that character's start offset.
 *  - Click in the gutter -> start of that screen row (the line start for its first row).
 *  - Click right of the text -> end of the line on its last screen row; on a wrapped (non-last)
 *    row it stays on that row and returns the start of the row's last character.
 *
 * @param {Layout} layout
 * @param {number} row  0-based screen row relative to the layout's top.
 * @param {number} col  0-based column relative to the layout's left edge (gutter included).
 * @param {{clampRow?: boolean}} [opts]  With `clampRow`, rows outside the layout snap to the first/last row
 *                                       (useful while dragging); otherwise they return null.
 * @returns {Hit | null}
 */
export function hitTest(layout, row, col, { clampRow = false } = {}) {
  if (layout.length === 0) return null;
  let r = row;
  if (r < 0 || r >= layout.length) {
    if (!clampRow) return null;
    r = r < 0 ? 0 : layout.length - 1;
  }
  const R = layout[r];
  const tc = col - layout.meta.gutterWidth;
  if (tc < 0) return { line: R.line, offset: R.startOffset, row: r, region: 'gutter' };
  for (const cell of R.cells) {
    if (cell.width > 0 && tc >= cell.col && tc < cell.col + cell.width) {
      return { line: R.line, offset: cell.start, row: r, region: 'text' };
    }
  }
  let offset = R.endOffset;
  if (!R.last) {
    const lastCell = [...R.cells].reverse().find((c) => c.width > 0) ?? R.cells[R.cells.length - 1];
    offset = lastCell ? lastCell.start : R.startOffset;
  }
  return { line: R.line, offset, row: r, region: 'eol' };
}

/**
 * Inverse of {@link hitTest}: where is the caret `(line, offset)` drawn?
 * A caret exactly on a wrap point belongs to the *next* row. A caret at the end of the line is
 * reported one column after the last character (possibly == textWidth on a full row).
 *
 * @param {Layout} layout
 * @param {number} line    Source line index (same numbering as `firstLine`).
 * @param {number} offset  Caret offset in that line.
 * @returns {{row: number, col: number, cell: number} | null}
 *   `col` is relative to the layout's left edge (gutter included); `cell` is the index into
 *   `layout[row].cells` of the grapheme under the caret, or -1 at the end of the row.
 */
export function locate(layout, line, offset) {
  let lastIdx = -1;
  for (let r = 0; r < layout.length; r++) {
    const R = layout[r];
    if (R.line !== line) {
      if (lastIdx !== -1) break;
      continue;
    }
    lastIdx = r;
    if (offset >= R.startOffset && (offset < R.endOffset || (R.last && offset <= R.endOffset))) {
      return place(layout, r, offset);
    }
  }
  if (lastIdx === -1) return null;
  // Offset beyond the line: clamp to its end.
  return place(layout, lastIdx, layout[lastIdx].endOffset);
}

function place(layout, r, offset) {
  const R = layout[r];
  const gutter = layout.meta.gutterWidth;
  for (let i = 0; i < R.cells.length; i++) {
    const c = R.cells[i];
    if (offset >= c.start && offset < c.end) return { row: r, col: gutter + c.col, cell: i };
  }
  return { row: r, col: gutter + R.width, cell: -1 };
}
