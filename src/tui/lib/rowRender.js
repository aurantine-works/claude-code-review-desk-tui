// Turns one wrapped document row into styled segments: gutter (line number, thread marker) + text with
// Markdown colours, anchor / selection backgrounds and optional overlay inserts (buttons, masks, menus).
import { spanLineInterval } from './selection.js';
import { makeSourceView } from './docView.js';
import { COLOR, GLYPH, threadColor } from './theme.js';
import { pushSeg } from './ansi.js';

/**
 * @typedef {object} Cover  A region of text drawn with a background.
 * @property {import('./selection.js').Span} span
 * @property {'anchor' | 'sel'} kind
 * @property {boolean} [focused]
 * @property {'src' | 'disp'} [space]  'src' (default): the span is in source offsets (anchors, the comment box's selection),
 *           'disp': in display offsets (the Visual-mode selection, which is made on what is on screen)
 *
 * @typedef {object} Insert  Replaces the cells in [col, col + width) of one row (text-area columns).
 * @property {number} col
 * @property {number} width
 * @property {string} text   visible width must equal `width`
 * @property {import('./ansi.js').Style | null} [style]
 *
 * @typedef {object} RowCtx
 * @property {ReturnType<typeof makeSourceView>} [dv]  the document view (docView.js); without it `lines` + `info` are the source
 * @property {string[]} [lines]
 * @property {import('./markdown.js').LineInfo[]} [info]
 * @property {number} numWidth
 * @property {number} textWidth
 * @property {number} cursorLine
 * @property {number} [cursorOff]    display offset of the cursor character in `cursorLine`
 * @property {boolean} [showCursor]  draw the cursor character in inverse video
 * @property {Cover[]} covers
 * @property {Map<number, string>} markers   line -> thread status of the strongest thread on it
 */

export const gutterWidthFor = (lineCount) => String(Math.max(1, lineCount)).length + 3;

const withBgMemo = new WeakMap();
function withBg(base, bg) {
  const key = base ?? NO_BASE;
  let m = withBgMemo.get(key);
  if (!m) withBgMemo.set(key, (m = new Map()));
  let s = m.get(bg);
  if (!s) m.set(bg, (s = { ...(base ?? {}), bg }));
  return s;
}
const NO_BASE = {};
const inverseMemo = new WeakMap();
function withInverse(base) {
  const key = base ?? NO_BASE;
  let s = inverseMemo.get(key);
  if (!s) inverseMemo.set(key, (s = { ...(base ?? {}), inverse: true }));
  return s;
}

export function coverBg(count, sel, focused) {
  if (sel) return COLOR.bgSelect;
  if (count >= 2) return COLOR.bgOverlap;
  if (count === 1) return focused ? COLOR.bgFocus : COLOR.bgAnchor;
  return null;
}

/** Cut / pad `cells` so [col, col + width) holds exactly the insert. */
function applyInsert(cells, ins) {
  const ie = ins.col + ins.width;
  const out = [];
  for (const c of cells) {
    const ce = c.col + c.width;
    if (ce <= ins.col || c.col >= ie) {
      out.push(c);
      continue;
    }
    // A double-width cell cut by the insert leaves blanks on the side that remains.
    if (c.col < ins.col) out.push({ col: c.col, width: ins.col - c.col, display: ' '.repeat(ins.col - c.col), style: c.style });
    if (ce > ie) out.push({ col: ie, width: ce - ie, display: ' '.repeat(ce - ie), style: c.style });
  }
  out.push({ col: ins.col, width: ins.width, display: ins.text, style: ins.style ?? null });
  out.sort((a, b) => a.col - b.col);
  return out;
}

/**
 * @param {import('../mouse/layout.js').ScreenRow} row
 * @param {RowCtx} ctx
 * @param {Insert[]} [inserts]
 * @returns {import('./ansi.js').Segment[]}  exactly `gutterWidth + textWidth` columns wide
 */
export function renderDocRow(row, ctx, inserts = []) {
  const dv = ctx.dv ?? (ctx.dv = makeSourceView(ctx.lines, ctx.info));
  const text = dv.lines[row.line] ?? '';
  const len = text.length;

  const ivs = [];
  for (const c of ctx.covers) {
    if (row.line < c.span.l0 || row.line > c.span.l1) continue;
    const disp = c.space === 'disp';
    const iv = spanLineInterval(c.span, row.line, disp ? len : dv.srcLen(row.line));
    if (iv) ivs.push({ ...iv, sel: c.kind === 'sel', focused: !!c.focused, disp });
  }
  const styleOf = dv.styler(row.line);
  const onCursorLine = ctx.showCursor === true && row.line === ctx.cursorLine;

  let cells = [];
  for (const cell of row.cells) {
    if (cell.display === '') continue;
    let n = 0;
    let sel = false;
    let foc = false;
    for (const iv of ivs) {
      if (iv.whole || (iv.disp ? cell.start >= iv.from && cell.start < iv.to : dv.covered(row.line, cell.start, iv.from, iv.to))) {
        if (iv.sel) sel = true;
        else {
          n++;
          if (iv.focused) foc = true;
        }
      }
    }
    const base = styleOf(cell.start);
    const bg = coverBg(n, sel, foc);
    let style = bg ? withBg(base, bg) : base;
    if (onCursorLine && cell.start === ctx.cursorOff) style = withInverse(style);
    cells.push({ col: cell.col, width: cell.width, display: cell.display, style });
  }
  // An empty line has no character to invert: show the cursor as one blank cell.
  if (onCursorLine && len === 0 && row.first) cells.push({ col: 0, width: 1, display: ' ', style: { inverse: true } });

  // The blank rest of the row: a code block's background, or the highlight when the whole line is covered.
  let padStyle = dv.rowStyle(row.line);
  const wholes = ivs.filter((iv) => iv.whole);
  if (wholes.length) {
    const bg = coverBg(wholes.filter((iv) => !iv.sel).length, wholes.some((iv) => iv.sel), wholes.some((iv) => iv.focused));
    if (bg) padStyle = { bg };
  }

  for (const ins of inserts) cells = applyInsert(cells, ins);

  const segs = [];
  // Gutter: line number (first row of a line only), thread marker, rule.
  const first = row.first;
  const isCursor = row.line === ctx.cursorLine;
  pushSeg(
    segs,
    first ? String(row.line + 1).padStart(ctx.numWidth) : ' '.repeat(ctx.numWidth),
    first && isCursor ? { inverse: true, bold: true } : { dim: true },
  );
  const status = ctx.markers.get(row.line);
  if (status) pushSeg(segs, GLYPH.marker, { fg: threadColor(status) });
  else pushSeg(segs, ' ', null);
  pushSeg(segs, GLYPH.vbar, { dim: true });
  pushSeg(segs, ' ', null);

  let pos = 0;
  for (const c of cells) {
    if (c.col > pos) {
      pushSeg(segs, ' '.repeat(c.col - pos), padStyle);
      pos = c.col;
    }
    pushSeg(segs, c.display, c.style);
    pos = Math.max(pos, c.col + c.width);
  }
  if (pos < ctx.textWidth) pushSeg(segs, ' '.repeat(ctx.textWidth - pos), padStyle);
  return segs;
}
