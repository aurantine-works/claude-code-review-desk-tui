// Content of the thread side panel (wide layout) and the bottom drawer (narrow layout) as rows of segments.
import { buildCard } from './cards.js';
import { fitSegs } from './ansi.js';
import { clampPanelScroll, placeCards, revealShift } from './placement.js';
import { COLOR } from './theme.js';
import { pendingLabelFor } from './deliveryModel.js';
import { t } from '../../i18n/index.js';

// There is no mouse selection any more: v selects characters, V whole lines.
const blankRow = (w) => [{ text: ' '.repeat(w), style: null }];
const padCard = (rows, width) => rows.map((r) => fitSegs([{ text: ' ', style: null }, ...r], width));

/**
 * Side panel: thread cards aligned with their anchors.
 *
 * @param {object} o
 * @param {{placed: object[], orphans: object[]}} o.view
 * @param {string | null} o.focusId
 * @param {number} o.width            panel width including its 1-column padding on both sides
 * @param {number} o.height           rows of the pane
 * @param {(line: number) => number} o.rowOfLine  viewport row of a source line's first row, -1 if not visible
 * @param {number} o.topLine          first visible source line
 * @param {number | null} o.scroll    manual scroll (rows) or null to follow the document
 * @param {object} o.meta
 * @param {object | null} [o.delivery]  summarizeDelivery() result: decides the waiting line of pending threads
 * @param {string[]} [o.emptyHint]  the lines shown while there are no threads
 * @param {{threadId: string, extra: number} | null} [o.reveal]  a floating reply box of `extra` rows will sit below this thread's
 *        card: scroll so the card and the box are visible together when they fit (nothing is reserved or reflowed)
 */
export function layoutPanel({ view, focusId, width, height, rowOfLine, topLine, scroll, meta, delivery = null, reveal = null, emptyHint = t('panel.hint') }) {
  const inner = Math.max(8, width - 2);
  const items = [];
  for (const t of view.placed) items.push({ thread: t, orphan: false });
  if (view.orphans.length) {
    items.push({ group: t('panel.orphans') });
    for (const t of view.orphans) items.push({ thread: t, orphan: true });
  }

  const cards = items.map((it) => {
    if (it.group) {
      return { ...it, rows: [fitSegs([{ text: `── ${it.group} ──`, style: { fg: COLOR.dim } }], inner)], h: 1, desired: null };
    }
    const rows = buildCard(it.thread, inner, { focused: it.thread.id === focusId, pendingLabel: pendingLabelFor(it.thread, delivery), currentRevision: meta.currentRevision });
    let desired = null;
    if (!it.orphan) {
      const r = rowOfLine(it.thread.anchor.startLine - 1);
      desired = r >= 0 ? r : null;
    }
    return { ...it, rows, h: rows.length, desired };
  });

  let pivot = cards.findIndex((c) => c.thread && c.thread.id === focusId);
  if (pivot === -1) {
    pivot = cards.findIndex((c) => c.thread && !c.orphan && c.thread.anchor.endLine - 1 >= topLine);
    if (pivot === -1) {
      const lastPlaced = view.placed.length - 1;
      pivot = lastPlaced >= 0 ? lastPlaced : 0;
    }
  }

  const tops = placeCards(cards, { pivot, gap: 1 });
  const heights = cards.map((c) => c.h);
  let shift;
  if (scroll != null) shift = clampPanelScroll(scroll, tops, heights, height);
  else if (pivot >= 0 && cards[pivot]?.thread && cards[pivot].thread.id === focusId) {
    const extra = reveal && reveal.threadId === focusId ? reveal.extra : 0;
    // Card plus floating box together when they fit; a taller card only gets its top shown.
    shift = revealShift(tops[pivot], heights[pivot] + extra <= height ? heights[pivot] + extra : heights[pivot], height);
  }
  else shift = 0;

  const rows = Array.from({ length: height }, () => blankRow(width));
  const rects = [];
  const extents = new Map(); // thread id -> unclipped rows of its card (after the scroll)
  cards.forEach((c, i) => {
    const y0 = tops[i] - shift;
    if (c.thread) rects.push({ id: c.thread.id, y0: Math.max(0, y0), y1: Math.min(height, y0 + c.rows.length) });
    if (c.thread) extents.set(c.thread.id, { top: y0, bottom: y0 + c.rows.length });
    if (y0 >= height || y0 + c.rows.length <= 0) return; // off screen: nothing to paint
    padCard(c.rows, width).forEach((r, k) => {
      const y = y0 + k;
      if (y >= 0 && y < height) rows[y] = r;
    });
  });

  if (cards.length === 0) {
    emptyHint.forEach((text, i) => {
      if (i < height) rows[i] = fitSegs([{ text: ` ${text}`, style: { dim: true } }], width);
    });
  }

  return {
    rows,
    cards: rects.filter((r) => r.y1 > r.y0),
    shift,
    cardExtent: (id) => extents.get(id) ?? null,
    clamp: (n) => clampPanelScroll(n, tops, heights, height),
    empty: cards.length === 0,
  };
}

/**
 * Narrow-layout drawer: the given threads stacked, scrolled by `scroll` rows.
 * @returns {{rows: import('./ansi.js').Segment[][], total: number, scroll: number}}
 */
export function layoutDrawer({ threads, focusId, width, height, scroll, meta, delivery = null }) {
  const inner = Math.max(8, width - 2);
  const all = [];
  threads.forEach((t, i) => {
    if (i > 0) all.push(blankRow(width));
    for (const r of padCard(buildCard(t, inner, { focused: t.id === focusId && threads.length > 1, pendingLabel: pendingLabelFor(t, delivery), currentRevision: meta.currentRevision }), width)) all.push(r);
  });
  const max = Math.max(0, all.length - height);
  const sc = Math.max(0, Math.min(max, scroll));
  const rows = all.slice(sc, sc + height);
  while (rows.length < height) rows.push(blankRow(width));
  return { rows, total: all.length, scroll: sc };
}
