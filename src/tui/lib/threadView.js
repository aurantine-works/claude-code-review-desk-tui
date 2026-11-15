// Pure helpers over the thread list: ordering, per-line lookup, gutter markers, navigation.
import { isPending } from '../../store/threads.js';

const RANK = { resolved: 0, answered: 1, open: 2 };

export const isOrphan = (t) => t.anchor?.orphaned === true;

/** Anchors drawn as highlights in the document. */
export const isHighlightable = (t) => t.status !== 'resolved' && !isOrphan(t);

export function lineLabel(a) {
  return a.startLine === a.endLine ? `L${a.startLine}` : `L${a.startLine}-${a.endLine}`;
}

const num = (id) => Number(String(id).slice(1)) || 0;

/**
 * @param {object[]} threads
 * @param {number} lineCount
 * @returns {{placed: object[], orphans: object[], order: object[], byLine: Map<number, object[]>, markers: Map<number, string>}}
 *   `byLine` / `markers` use 0-based line indexes.
 */
export function buildThreadView(threads, lineCount) {
  const placed = [];
  const orphans = [];
  for (const t of threads) (isOrphan(t) ? orphans : placed).push(t);
  const key = (t) => [t.anchor.startLine, t.anchor.startCol ?? -1, num(t.id)];
  const byKey = (a, b) => {
    const x = key(a);
    const y = key(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  placed.sort(byKey);
  orphans.sort((a, b) => num(a.id) - num(b.id));

  const byLine = new Map();
  const markers = new Map();
  for (const t of placed) {
    const status = t.status === 'open' && !isPending(t) && t.messages.some((m) => m.author !== 'user') ? 'answered' : t.status;
    const last = Math.min(t.anchor.endLine, lineCount) - 1;
    for (let l = Math.max(0, t.anchor.startLine - 1); l <= last; l++) {
      const list = byLine.get(l);
      if (list) list.push(t);
      else byLine.set(l, [t]);
      if ((RANK[status] ?? 2) >= (RANK[markers.get(l)] ?? -1)) markers.set(l, status);
    }
  }
  return { placed, orphans, order: [...placed, ...orphans], byLine, markers };
}

/** Next / previous thread in document order; wraps around. */
export function stepThread(order, currentId, dir) {
  if (order.length === 0) return null;
  const i = order.findIndex((t) => t.id === currentId);
  if (i === -1) return dir > 0 ? order[0] : order[order.length - 1];
  return order[(i + dir + order.length) % order.length];
}

/** The thread after / before the cursor line (strictly beyond the current line); wraps around. */
export function threadFromCursor(placed, cursorLine, dir) {
  if (placed.length === 0) return null;
  const line1 = cursorLine + 1;
  if (dir > 0) return placed.find((t) => t.anchor.startLine > line1) ?? placed[0];
  for (let i = placed.length - 1; i >= 0; i--) if (placed[i].anchor.startLine < line1) return placed[i];
  return placed[placed.length - 1];
}

/** Status a thread returns to when reopened. */
export const reopenStatus = (t) => (!isPending(t) && t.messages.some((m) => m.author !== 'user') ? 'answered' : 'open');

/** The user's last draft message in a thread, if any. */
export function lastDraft(t) {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.author === 'user' && m.state === 'draft') return m;
  }
  return null;
}

export const countDrafts = (threads) =>
  threads.reduce((n, t) => n + t.messages.filter((m) => m.author === 'user' && m.state === 'draft').length, 0);
