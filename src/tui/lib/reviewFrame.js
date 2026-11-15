// Everything the review screen draws, derived from (UI state, store data, terminal size) in one pure function:
// geometry, the visible document rows with their highlights and overlays, the panel / drawer rows, and the
// rectangles the mouse handler hit-tests against. Rendering and mouse handling both read the result, so what is
// drawn and what is clickable cannot drift apart.
import { locate } from '../mouse/layout.js';
import { viewLayout } from './viewport.js';
import { computeGeometry, MAX_DRAWER_ROWS, WIDE_MIN_COLS } from './geometry.js';
import { gutterWidthFor, renderDocRow } from './rowRender.js';
import { fitSegs, fitVariant } from './ansi.js';
import { layoutPanel, layoutDrawer } from './panelModel.js';
import { placeCommentBox, placeReplyBox, commentBoxWidth } from './placement.js';
import { spanOfAnchor } from './selection.js';
import { menuRect } from './reviewMouse.js';
import { lineLabel } from './threadView.js';
import { COLOR, GLYPH } from './theme.js';
import * as nav from './reviewNav.js';
import { clampOff } from './motions.js';
import { commentBoxModel } from './commentBoxModel.js';
import { makeSourceView } from './docView.js';
import { t } from '../../i18n/index.js';

/**
 * Rows (viewport-relative) and left column of a selection, for placing the comment box.
 * `sel` is a store selection (source columns); the layout is made of display text, so the columns go through the view.
 */
function selectionBox(sel, win, layout, doc, geo, dv) {
  const l0 = sel.startLine - 1;
  const l1 = sel.endLine - 1;
  let top;
  let left = doc.gutterWidth;
  if (l0 < win.firstLine) top = 0;
  else if (l0 > win.lastLine) top = geo.bodyH - 1;
  else {
    const r = win.rowOf(l0);
    top = r === -1 ? 0 : r;
    if (sel.startCol != null) {
      const loc = locate(layout, l0, dv.toDisp(l0, sel.startCol));
      if (loc) {
        top = loc.row;
        left = loc.col;
      }
    }
  }
  let bottom;
  if (l1 > win.lastLine) bottom = geo.bodyH - 1;
  else if (l1 < win.firstLine) bottom = 0;
  else {
    const r = win.rowOf(l1);
    bottom = r === -1 ? 0 : Math.min(geo.bodyH - 1, r + doc.rowCount(l1) - 1);
    if (sel.endCol != null) {
      const loc = locate(layout, l1, dv.toDisp(l1, Math.max(0, sel.endCol - 1)));
      if (loc) bottom = loc.row;
    }
  }
  return { top, bottom: Math.max(top, bottom), left };
}


/**
 * @param {object} p
 * @param {object} p.s              UI state (see reviewNav.js)
 * @param {import('./viewport.js').DocLayout} p.doc
 * @param {ReturnType<typeof import('./docView.js').createDocViews>} [p.views]  the document's views; the mode comes from `s.md`
 * @param {string[]} [p.lines] @param {object[]} [p.info]  without `views`: source lines and their Markdown classes (source view only)
 * @param {ReturnType<typeof import('./threadView.js').buildThreadView>} p.view
 * @param {object} p.meta
 * @param {object | null} [p.delivery]  summarizeDelivery() result
 * @param {{columns: number, rows: number}} p.size
 * @returns {object}  `state` is `s` with cursor / scroll / drawer scroll normalised for this geometry
 */
export function buildReviewFrame({ s: s0, doc, views, lines: srcLines, info, view, meta, size, delivery = null }) {
  let s = s0;
  const vs = views ?? (() => {
    const only = makeSourceView(srcLines, info);
    return { markdown: false, source: only, pick: () => only };
  })();
  const lineCount = vs.source.count;
  const cols = size.columns;
  const rowsTotal = size.rows;
  const wide = cols >= WIDE_MIN_COLS;
  // The box never grows taller than the area it lives in (4 rows are frame, title and footer).
  const maxRows = Math.max(1, Math.min(8, (wide ? rowsTotal - 4 : rowsTotal - 9) - 4));
  // The comment / reply box floats over the screen, so it never changes the layout underneath.
  const drawerRows = !wide && view.order.length ? Math.min(MAX_DRAWER_ROWS, Math.max(3, Math.floor((rowsTotal - 4) / 3))) : 0;
  const geo = computeGeometry({ cols, rows: rowsTotal, drawerRows });

  // The box in the narrow layout sits at the bottom of the screen; the document keeps the cursor above it.
  let box = null; // {x, y, w, h, kind}  absolute cells, always inside the screen
  let boxModel = null;
  if (s.input && !wide) {
    boxModel = commentBoxModel({ width: cols, text: s.input.text, maxRows });
    const h = Math.min(boxModel.height, rowsTotal - geo.bodyY - 1);
    box = { x: 0, y: geo.statusY - h, w: cols, h };
  }
  /** Rows of the document that stay visible (the narrow box covers the lower ones). */
  const visH = box ? Math.max(1, Math.min(geo.bodyH, box.y - geo.bodyY)) : geo.bodyH;
  const gutterWidth = gutterWidthFor(lineCount);
  // The document as shown now: the rendered view depends on the text width, so it is picked after the geometry.
  const dv = vs.pick(s.md, Math.max(1, geo.docW - gutterWidth));
  const lines = dv.lines; // display lines: what is laid out, what the cursor moves over
  // The cursor column and the Visual anchor are display offsets of the view they were made in: carry them over.
  if (s.offView !== dv) s = { ...nav.convertOffsets(s, s.offView, dv), offView: dv };
  doc.setLines(lines, dv.breaks ?? null);
  doc.configure({ width: geo.docW, gutterWidth, tabWidth: 4 });

  // Keep the cursor and the scroll position valid (resize, new revision, drawer opening, a switch of view).
  const cursor = Math.max(0, Math.min(s.cursor, Math.max(0, lineCount - 1)));
  const col = clampOff(lines[cursor] ?? '', s.col);
  if (s.keepRow != null) {
    // M just switched the view: put the cursor line on the screen row it had before.
    s = { ...s, top: doc.advance({ line: cursor, sub: 0 }, -Math.max(0, s.keepRow)), keepRow: null };
  }
  const top = doc.ensureVisible(s.top, cursor, visH, 0);
  if (cursor !== s.cursor || col !== s.col || top.line !== s.top.line || top.sub !== s.top.sub) s = { ...s, cursor, col, top };

  const ctx = { doc, bodyH: visH, view, lineCount, lines, dv };
  const win = doc.window(s.top, geo.bodyH);
  const layout = viewLayout(win, doc);
  const focus = s.focusId ? view.order.find((t) => t.id === s.focusId) ?? null : null;

  // Highlight regions.
  const covers = [];
  for (const t of view.placed) {
    if (t.status !== 'resolved') covers.push({ span: spanOfAnchor(t.anchor), kind: 'anchor', focused: t.id === s.focusId });
  }
  if (s.input?.kind === 'comment') {
    covers.push({ span: spanOfAnchor({ startLine: s.input.sel.startLine, endLine: s.input.sel.endLine, startCol: s.input.sel.startCol, endCol: s.input.sel.endCol }), kind: 'sel' });
  } else {
    const span = nav.visualSpan(s, lines);
    if (span) covers.push({ span, kind: 'sel', space: 'disp' }); // made on the display text
  }

  // Overlays that live inside the document pane: the overlap menu and the mask under the comment box.
  const inserts = new Map(); // viewport row -> Insert[]
  const addInsert = (row, ins) => {
    if (row < 0 || row >= geo.bodyH) return;
    const list = inserts.get(row);
    if (list) list.push(ins);
    else inserts.set(row, [ins]);
  };
  let menu = null;
  if (s.mode === 'menu' && s.menu) {
    const r = menuRect(s.menu, geo, gutterWidth);
    menu = r;
    s.menu.ids.forEach((tid, i) => {
      const t = view.order.find((x) => x.id === tid);
      if (!t) return;
      const text = ` ${i === s.menu.index ? '›' : ' '} ${t.id} ${GLYPH.sep.trim()} ${lineLabel(t.anchor)} ${GLYPH.sep.trim()} ${t.status}`;
      addInsert(r.row + i, {
        col: r.col - gutterWidth,
        width: r.width,
        text: fitSegs([{ text, style: null }], r.width).map((x) => x.text).join(''),
        style: { bg: i === s.menu.index ? COLOR.bgFocus : COLOR.bgBadge, fg: '#e6e6e6' },
      });
    });
  }

  // The comment box next to the document selection (wide layout). It floats: the rows under it are blanked to the
  // right of its left edge, nothing is re-laid out.
  if (s.input?.kind === 'comment' && wide) {
    const textW = geo.docW - gutterWidth;
    const w = commentBoxWidth(textW);
    boxModel = commentBoxModel({ width: w, text: s.input.text, maxRows });
    const sb = selectionBox(s.input.sel, win, layout, doc, geo, dv);
    const p = placeCommentBox({ paneW: geo.docW, paneH: geo.bodyH, selTop: sb.top, selBottom: sb.bottom, selLeft: sb.left, boxW: w, boxH: boxModel.height });
    box = { x: geo.docX + p.left, y: geo.bodyY + p.top, w, h: boxModel.height };
    const maskCol = Math.max(0, p.left - gutterWidth);
    const maskW = Math.max(1, geo.docW - gutterWidth - maskCol);
    for (let r = p.top; r < p.top + boxModel.height; r++) addInsert(r, { col: maskCol, width: maskW, text: ' '.repeat(maskW), style: null });
  }

  // Right panel (wide) / drawer (narrow). A reply box floats over them next to the thread's card.
  let panel = null;
  let panelRows = null;
  if (wide) {
    let reveal = null;
    if (s.input?.kind === 'reply') {
      boxModel = commentBoxModel({ width: geo.panelW - 2, text: s.input.text, maxRows });
      reveal = { threadId: s.input.threadId, extra: boxModel.height };
    }
    panel = layoutPanel({ view, focusId: s.focusId, width: geo.panelW, height: geo.bodyH, rowOfLine: win.rowOf, topLine: s.top.line, scroll: s.panelScroll, meta, delivery, reveal });
    panelRows = panel.rows;
    if (reveal) {
      const card = panel.cardExtent(reveal.threadId);
      const p = placeReplyBox({ cardTop: card?.top ?? 0, cardBottom: card?.bottom ?? 0, paneH: geo.bodyH, boxH: boxModel.height });
      box = { x: geo.panelX + 1, y: geo.bodyY + p.top, w: geo.panelW - 2, h: boxModel.height };
    }
  }
  let drawer = null;
  if (!wide && geo.drawerH > 0) {
    const ids = nav.drawerThreadIds(s, ctx);
    const list = ids.map((tid) => view.order.find((t) => t.id === tid)).filter(Boolean);
    drawer = layoutDrawer({ threads: list, focusId: s.focusId, width: geo.cols, height: geo.drawerH, scroll: s.drawerScroll, meta, delivery });
    if (drawer.scroll !== s.drawerScroll) {
      s = { ...s, drawerScroll: drawer.scroll };
    }
    if (list.length === 0) {
      drawer.rows[0] = fitSegs([{ text: fitVariant(geo.cols - 1, t('panel.drawerEmpty')), style: { dim: true } }], geo.cols);
    }
  }

  // Rows of the document pane.
  const showCursor = s.mode === 'normal' || s.mode === 'visual';
  const rowCtx = { dv, numWidth: gutterWidth - 3, textWidth: doc.textWidth, cursorLine: cursor, cursorOff: s.col, showCursor, covers, markers: view.markers };
  const docRows = win.rows.map((row, i) => renderDocRow(row, rowCtx, inserts.get(i) ?? []));
  while (docRows.length < geo.bodyH) docRows.push(fitSegs([{ text: '~', style: { dim: true } }], geo.docW));

  return {
    state: s,
    geo,
    wide,
    gutterWidth,
    maxRows,
    doc,
    lines,
    dv,
    views: vs,
    view,
    layout,
    ctx,
    win,
    focus,
    cursor,
    visH,
    docRows,
    panelRows,
    drawer,
    boxRect: box,
    boxModel,
    menu,
    panel: panel ? { shift: panel.shift, clamp: panel.clamp, cards: panel.cards } : { shift: 0, clamp: (n) => n, cards: [] },
  };
}
