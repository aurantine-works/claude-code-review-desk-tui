// Builds the same frame / ctx objects the Review screen passes to the pure nav and mouse modules.
import { DocLayout, viewLayout } from '../../src/tui/lib/viewport.js';
import { computeGeometry } from '../../src/tui/lib/geometry.js';
import { buildThreadView } from '../../src/tui/lib/threadView.js';
import { gutterWidthFor } from '../../src/tui/lib/rowRender.js';
import { initialState } from '../../src/tui/lib/reviewNav.js';
import { layoutPanel } from '../../src/tui/lib/panelModel.js';

export const anchor = (startLine, endLine = startLine, extra = {}) => ({ revision: 1, startLine, endLine, startCol: null, endCol: null, quote: `q${startLine}`, before: '', after: '', orphaned: false, ...extra });
export const msg = (id, author, text, extra = {}) => ({ id, author, text, at: 't', revision: 1, ...extra });
export const thread = (id, a, messages = [msg('m1', 'user', `c-${id}`, { state: 'sent' })], status = 'open') => ({ id, status, anchor: a, messages });

export function makeFrame({ lines, threads = [], cols = 160, rows = 40, state = {}, statusButtons = [] } = {}) {
  const geo = computeGeometry({ cols, rows });
  const doc = new DocLayout(lines).configure({ width: geo.docW, gutterWidth: gutterWidthFor(lines.length), tabWidth: 4 });
  const view = buildThreadView(threads, lines.length);
  const s = { ...initialState(), ...state };
  const ctx = { doc, bodyH: geo.bodyH, view, lineCount: lines.length, lines };
  const win = doc.window(s.top, geo.bodyH);
  const layout = viewLayout(win, doc);
  const panel = geo.wide
    ? layoutPanel({ view, focusId: s.focusId, width: geo.panelW, height: geo.bodyH, rowOfLine: win.rowOf, topLine: s.top.line, scroll: s.panelScroll, meta: { kind: 'doc', status: 'in_review', currentRevision: 1 } })
    : null;
  const frame = {
    geo,
    doc,
    lines,
    view,
    layout,
    ctx,
    panel: panel ? { shift: panel.shift, clamp: panel.clamp, cards: panel.cards } : { shift: 0, clamp: (n) => n, cards: [] },
    commentButton: null,
    box: null,
    statusButtons,
  };
  return { s, frame, ctx, geo, doc, view, win };
}

/** Mouse event factory (0-based cell coordinates). */
export const mouse = (kind, x, y, button = 'left') => ({ type: 'mouse', kind, x, y, button, shift: false, meta: false, ctrl: false });
