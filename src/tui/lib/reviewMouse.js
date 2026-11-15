// Mouse handling of the review screen as a pure function: (event, state, frame) -> {state, effect}.
//
// The mouse does four things: scroll (wheel over the document / panel / drawer), place the cursor (click in the
// document), pick a thread (click a card, or an overlapping highlight), and press buttons (status bar, comment box).
// Selecting text is done with the keyboard (`v` / `V`), not by dragging.
//
// `frame` describes what is on screen right now:
//   geo           computeGeometry() result
//   doc, lines, view   DocLayout, display lines, buildThreadView() result
//   dv            the document view (docView.js; absent = the source view of `lines`). hitTest offsets are DISPLAY offsets: the
//                 cursor stores them as they are, thread highlights (source anchors) are compared through the view.
//   layout        viewLayout() of the visible rows (for hitTest)
//   panel         {shift, clamp(n), cards: [{id, y0, y1}]}  panel rows relative to the body top
//   box           {y, send: [x0, x1], cancel: [x0, x1]} | null  comment box buttons, absolute cells
//   statusButtons [{x0, x1, action}]
//   dctx, helpMax, overlay  diff view context (diffView.js `dctx`; present while s.diff is set), the largest help scroll, and the
//                 rectangle + press targets of the open dialog / picker: {hits: [{y, x0, x1, action}]} in absolute cells
//
// Effects tell the screen what to do beyond the state change:
//   {type: 'action', name}   run the same handler as the key bound to `name`
//   {type: 'boxSend'} / {type: 'boxCancel'} / {type: 'closeHelp'} / {type: 'overlay', action}  (a press on a dialog / picker row)
import { hitTest } from '../mouse/layout.js';
import { regionAt } from './geometry.js';
import { spanOfAnchor } from './selection.js';
import { makeSourceView, viewCovers } from './docView.js';
import { jumpToThread, scrollView, setCursor, focusFor, clearSelection } from './reviewNav.js';
import { handleDiffMouse } from './diffNav.js';

const WHEEL_ROWS = 3;
const none = (state) => ({ state, effect: null });

/** Geometry of the overlap menu relative to the document pane. */
export function menuRect(menu, geo, minCol = 0) {
  const height = menu.ids.length;
  const width = Math.max(10, Math.min(44, geo.docW - minCol - 1));
  const below = menu.row + 1;
  const row = below + height <= geo.bodyH ? below : Math.max(0, menu.row - height);
  const col = Math.max(minCol, Math.min(menu.col, geo.docW - width));
  return { row, col, width, height };
}

const hits = (b, x) => x >= b.x0 && x < b.x1;

/** Wheel over the document, panel or drawer. Allowed while the comment box is open: it only moves the view. */
function wheel(ev, s, f, ctx, region) {
  const dir = ev.button === 'wheelUp' ? -1 : ev.button === 'wheelDown' ? 1 : 0;
  if (!dir) return none(s);
  if (region === 'doc') return none(scrollView(s, ctx, dir * WHEEL_ROWS));
  if (region === 'drawer') return none({ ...s, drawerScroll: Math.max(0, s.drawerScroll + dir * WHEEL_ROWS) });
  if (region === 'panel') {
    const base = s.panelScroll ?? f.panel.shift;
    return none({ ...s, panelScroll: f.panel.clamp(base + dir * WHEEL_ROWS) });
  }
  return none(s);
}

/**
 * @returns {{state: object, effect: object | null}}
 */
export function handleMouse(ev, s, f, ctx) {
  const { geo } = f;
  const left = ev.button === 'left';

  if (s.mode === 'help') {
    if (ev.kind === 'wheel') {
      const dir = ev.button === 'wheelUp' ? -1 : ev.button === 'wheelDown' ? 1 : 0;
      return none({ ...s, helpTop: Math.max(0, Math.min(f.helpMax ?? 0, (s.helpTop ?? 0) + dir * WHEEL_ROWS)) });
    }
    return ev.kind === 'press' && left ? { state: s, effect: { type: 'closeHelp' } } : none(s);
  }

  if (s.mode === 'dialog' || s.mode === 'picker') {
    if (ev.kind === 'press' && left) {
      const hit = (f.overlay?.hits ?? []).find((b) => ev.y === b.y && ev.x >= b.x0 && ev.x < b.x1);
      if (hit) return { state: s, effect: { type: 'overlay', action: hit.action } };
    }
    return none(s);
  }

  if (s.mode === 'confirm') {
    if (ev.kind === 'press' && left && ev.y === geo.statusY) {
      const b = f.statusButtons.find((x) => hits(x, ev.x));
      if (b) return { state: s, effect: { type: 'action', name: b.action } };
    }
    return none(s);
  }

  if (s.mode === 'input') {
    // Keys belong to the box; the mouse may still scroll what is underneath and press the box's buttons.
    if (ev.kind === 'wheel') return wheel(ev, s, f, ctx, regionAt(geo, ev.x, ev.y));
    if (ev.kind === 'press' && left && f.box && ev.y === f.box.y) {
      if (ev.x >= f.box.send[0] && ev.x < f.box.send[1]) return { state: s, effect: { type: 'boxSend' } };
      if (ev.x >= f.box.cancel[0] && ev.x < f.box.cancel[1]) return { state: s, effect: { type: 'boxCancel' } };
    }
    return none(s);
  }

  if (s.mode === 'menu') {
    if (ev.kind === 'press' && left && s.menu) {
      const r = menuRect(s.menu, geo, ctx.doc.gutterWidth);
      const row = ev.y - geo.bodyY - r.row;
      const col = ev.x - geo.docX - r.col;
      const closed = { ...s, mode: 'normal', menu: null };
      if (row >= 0 && row < r.height && col >= 0 && col < r.width) {
        const t = ctx.view.order.find((x) => x.id === s.menu.ids[row]);
        return { state: jumpToThread(closed, ctx, t), effect: null };
      }
      return none(closed);
    }
    return none(s);
  }

  if (s.diff) return handleDiffMouse(ev, s, f);

  // --- normal / visual ---------------------------------------------------------------------------------------
  const region = regionAt(geo, ev.x, ev.y);

  if (ev.kind === 'wheel') return wheel(ev, s, f, ctx, region);
  if (ev.kind !== 'press' || !left) return none(s);

  if (region === 'status') {
    const b = f.statusButtons.find((x) => hits(x, ev.x));
    return b ? { state: s, effect: { type: 'action', name: b.action } } : none(s);
  }

  if (region === 'panel') {
    const y = ev.y - geo.bodyY;
    const card = f.panel.cards.find((c) => y >= c.y0 && y < c.y1);
    if (!card) return none(s);
    const t = ctx.view.order.find((x) => x.id === card.id);
    return none(jumpToThread(clearSelection(s), ctx, t));
  }

  if (region !== 'doc') return none(s);

  const row = ev.y - geo.bodyY;
  const col = ev.x - geo.docX;
  const hit = hitTest(f.layout, row, col);
  if (!hit) return none(s);

  // A click puts the cursor on the character and leaves any selection mode.
  let next = clearSelection(s);
  next = setCursor(next, ctx, hit.line, { focusId: null, margin: 0, off: hit.offset }); // never scroll under the pointer
  next = { ...next, focusId: focusFor(next, ctx) };

  // Several threads overlap the character: let the user pick one.
  const dv = f.dv ?? ctx.dv ?? makeSourceView(f.lines);
  const list = ctx.view.byLine.get(hit.line) ?? [];
  const covering = list.filter((t) => viewCovers(dv, spanOfAnchor(t.anchor), hit.line, hit.offset));
  if (covering.length >= 2) {
    return none({ ...next, mode: 'menu', menu: { ids: covering.map((t) => t.id), index: 0, row: hit.row, col } });
  }
  if (covering.length === 1) return none({ ...next, focusId: covering[0].id });
  return none(next);
}
