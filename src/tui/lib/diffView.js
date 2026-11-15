// The diff view as a frame: everything it draws, derived from (UI state, diff model, store data, terminal size) in one
// pure function, like reviewFrame.js does for the normal view. The thread panel (wide) / drawer (narrow) stay visible and
// follow the cursor row's new-side line; the comment box and Visual mode do not exist here (the view is read-only).
//
// The rows are laid out by a second `DocLayout` over the rows' texts, so wrapping, virtual scrolling (only the visible
// rows are laid out) and hit testing are exactly those of the normal view.
//
// Diff state `s.diff` = {base: number | null (null = the previous revision), cursor: number | null (row index; null = the
// first change), top: {line, sub} | null (null = scroll the cursor to about a third of the pane)}.
import { viewLayout } from './viewport.js';
import { computeGeometry, MAX_DRAWER_ROWS, WIDE_MIN_COLS } from './geometry.js';
import { layoutPanel, layoutDrawer } from './panelModel.js';
import { fitSegs, pushSeg, fitVariant } from './ansi.js';
import { COLOR, GLYPH, threadColor } from './theme.js';
import { newLine0, firstNewLine0 } from './diffModel.js';
import { t } from '../../i18n/index.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const STYLES = {
  add: { bg: COLOR.bgAdd },
  del: { bg: COLOR.bgDel },
  addWord: { bg: COLOR.bgAddWord, bold: true },
  delWord: { bg: COLOR.bgDelWord, bold: true },
};

/**
 * One wrapped row of the diff body as segments of exactly `gutterWidth + textWidth` columns.
 * Gutter (first row of a line only): old number, new number, thread marker (new lines only), `+` / `-`, bar.
 * @param {import('../mouse/layout.js').ScreenRow} row  `row.line` is the diff row index
 * @param {{rows: object[], numWidth: number, textWidth: number, cursor: number, markers: Map<number, string>}} ctx
 */
export function renderDiffRow(row, ctx) {
  const dl = ctx.rows[row.line];
  const kind = dl?.kind ?? 'ctx';
  const lineStyle = kind === 'add' ? STYLES.add : kind === 'del' ? STYLES.del : null;
  const wordStyle = kind === 'add' ? STYLES.addWord : STYLES.delWord;
  const words = dl?.words ?? null;

  const segs = [];
  const w = ctx.numWidth;
  const isCursor = row.line === ctx.cursor;
  const num = (n) => (row.first && n != null ? String(n).padStart(w) : ' '.repeat(w));
  const inv = (on, style) => (on && row.first ? { ...style, inverse: true, bold: true } : style);
  pushSeg(segs, num(dl?.oldLine), inv(isCursor && dl?.oldLine != null, kind === 'del' ? { fg: COLOR.err } : { dim: true }));
  pushSeg(segs, ' ', null);
  pushSeg(segs, num(dl?.newLine), inv(isCursor && dl?.newLine != null, kind === 'add' ? { fg: COLOR.ok } : { dim: true }));
  const status = row.first && dl?.newLine != null ? ctx.markers.get(dl.newLine - 1) : null;
  if (status) pushSeg(segs, GLYPH.marker, { fg: threadColor(status) });
  else pushSeg(segs, ' ', null);
  const sign = row.first ? (kind === 'add' ? '+' : kind === 'del' ? '-' : ' ') : ' ';
  pushSeg(segs, sign, kind === 'add' ? { fg: COLOR.ok, bold: true } : kind === 'del' ? { fg: COLOR.err, bold: true } : null);
  pushSeg(segs, GLYPH.vbar, { dim: true });
  pushSeg(segs, ' ', null);

  let pos = 0;
  for (const c of row.cells) {
    if (c.display === '') continue;
    if (c.col > pos) {
      pushSeg(segs, ' '.repeat(c.col - pos), lineStyle);
      pos = c.col;
    }
    const inWord = words !== null && words.some(([a, b]) => c.start >= a && c.start < b);
    pushSeg(segs, c.display, inWord ? wordStyle : lineStyle);
    pos = Math.max(pos, c.col + c.width);
  }
  if (pos < ctx.textWidth) pushSeg(segs, ' '.repeat(ctx.textWidth - pos), lineStyle);
  return segs;
}

/** What the body says instead of rows when the comparison cannot be shown line by line. */
export function diffMessageRows(model, width, height) {
  const range = `rev ${model.from} → rev ${model.to}`;
  let lines;
  if (model.kind === 'tooLarge') {
    const { added, removed } = model.summary;
    lines = [
      { text: t('diff.tooLarge', { range }), style: { bold: true, fg: COLOR.warn } },
      { text: t('diff.tooLargeStat', { approx: model.approximate, added, removed }), style: null },
      { text: t('diff.tooLargeHint'), style: { dim: true } },
    ];
  } else if (model.kind === 'error') {
    lines = [
      { text: t('diff.errorTitle', { range }), style: { bold: true, fg: COLOR.err } },
      { text: ` ${model.error ?? ''}`, style: { dim: true } },
      { text: t('diff.errorHint'), style: { dim: true } },
    ];
  } else {
    lines = [
      { text: t('diff.identicalTitle', { range }), style: { bold: true, fg: COLOR.ok } },
      { text: t('diff.identicalNote'), style: { dim: true } },
      { text: t('diff.identicalHint'), style: { dim: true } },
    ];
  }
  const rows = lines.map((l) => fitSegs([l], width));
  while (rows.length < height) rows.push(fitSegs([], width));
  return rows.slice(0, height);
}

/**
 * @param {object} p
 * @param {object} p.s              UI state (reviewNav.js) with `s.diff` set
 * @param {import('./viewport.js').DocLayout} p.doc  layout over the diff rows (not the normal view's)
 * @param {import('./diffModel.js').DiffModel} p.model
 * @param {ReturnType<typeof import('./threadView.js').buildThreadView>} p.view
 * @param {object} p.meta
 * @param {object | null} [p.delivery]
 * @param {{columns: number, rows: number}} p.size
 */
export function buildDiffFrame({ s: s0, doc, model, view, meta, size, delivery = null }) {
  let s = s0;
  const cols = size.columns;
  const rowsTotal = size.rows;
  const wide = cols >= WIDE_MIN_COLS;
  const drawerRows = !wide && view.order.length ? Math.min(MAX_DRAWER_ROWS, Math.max(3, Math.floor((rowsTotal - 4) / 3))) : 0;
  const geo = computeGeometry({ cols, rows: rowsTotal, drawerRows });
  const n = model.rows.length;

  doc.setLines(model.texts);
  doc.configure({ width: geo.docW, gutterWidth: model.gutterWidth, tabWidth: 4 });

  // Cursor and scroll position, normalised for this geometry and this comparison.
  const d0 = s.diff;
  const cursor = n === 0 ? 0 : clamp(d0.cursor ?? model.changeStarts[0] ?? 0, 0, n - 1);
  let top = d0.top;
  if (n > 0) {
    if (!top) top = doc.scrollBy({ line: cursor, sub: 0 }, -Math.floor(geo.bodyH / 3), geo.bodyH);
    top = doc.ensureVisible(top, cursor, geo.bodyH, 2);
  } else top = { line: 0, sub: 0 };
  if (cursor !== d0.cursor || !d0.top || top.line !== d0.top.line || top.sub !== d0.top.sub) s = { ...s, diff: { ...d0, cursor, top } };

  const win = doc.window(top, geo.bodyH);
  const layout = viewLayout(win, doc);
  const cursorNew = newLine0(model, cursor);
  const focus = s.focusId ? view.order.find((t) => t.id === s.focusId) ?? null : null;

  // Thread cards are placed by the new-side line of their anchor, which is a row of this diff.
  const rowOfLine = (l0) => {
    const idx = model.rowOfNew.get(l0);
    return idx == null ? -1 : win.rowOf(idx);
  };
  const topLine = firstNewLine0(model, win.rows.map((r) => r.line)) ?? 0;

  let panel = null;
  let panelRows = null;
  if (wide) {
    panel = layoutPanel({ view, focusId: s.focusId, width: geo.panelW, height: geo.bodyH, rowOfLine, topLine, scroll: s.panelScroll, meta, delivery, emptyHint: t('panel.hintDiff') });
    panelRows = panel.rows;
  }
  let drawer = null;
  if (!wide && geo.drawerH > 0) {
    const ids = [];
    if (s.focusId) ids.push(s.focusId);
    for (const t of (cursorNew != null ? view.byLine.get(cursorNew) : null) ?? []) if (!ids.includes(t.id)) ids.push(t.id);
    const list = ids.map((tid) => view.order.find((t) => t.id === tid)).filter(Boolean);
    drawer = layoutDrawer({ threads: list, focusId: s.focusId, width: geo.cols, height: geo.drawerH, scroll: s.drawerScroll, meta, delivery });
    if (drawer.scroll !== s.drawerScroll) s = { ...s, drawerScroll: drawer.scroll };
    if (list.length === 0) drawer.rows[0] = fitSegs([{ text: fitVariant(geo.cols - 1, t('panel.drawerDiff')), style: { dim: true } }], geo.cols);
  }

  let docRows;
  if (model.kind === 'rows') {
    const rc = { rows: model.rows, numWidth: model.numWidth, textWidth: doc.textWidth, cursor, markers: view.markers };
    docRows = win.rows.map((row) => renderDiffRow(row, rc));
    while (docRows.length < geo.bodyH) docRows.push(fitSegs([{ text: '~', style: { dim: true } }], geo.docW));
  } else {
    docRows = diffMessageRows(model, geo.docW, geo.bodyH);
  }

  return {
    state: s,
    geo,
    wide,
    doc,
    win,
    layout,
    focus,
    cursor,
    cursorNew,
    docRows,
    panelRows,
    drawer,
    panel: panel ? { shift: panel.shift, clamp: panel.clamp, cards: panel.cards } : { shift: 0, clamp: (x) => x, cards: [] },
    /** What the diff key / mouse handlers need (lib/diffNav.js). */
    dctx: { doc, bodyH: geo.bodyH, model, view, lineCount: n },
  };
}
