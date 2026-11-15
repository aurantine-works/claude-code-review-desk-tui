// Placement maths for floating / aligned elements: thread cards next to their anchors, the comment box
// next to the selection. Everything is expressed in plain row / column numbers so it can be unit tested.

/**
 * Vertical positions of thread cards in the side panel.
 *
 * Cards come in document order. `desired` is the viewport row of the card's anchor (null when the anchor
 * is off screen). The pivot card is put at its desired row; cards after it are pushed down just far enough
 * to avoid overlapping, cards before it are pushed up. Off-screen cards simply pack against their
 * neighbours, so the panel is never empty while threads exist below or above the viewport.
 *
 * @param {{h: number, desired: number | null}[]} cards
 * @param {{pivot: number, gap?: number}} o
 * @returns {number[]} top row of each card (may be negative or beyond the pane)
 */
export function placeCards(cards, { pivot, gap = 1 }) {
  const n = cards.length;
  const tops = new Array(n);
  if (n === 0) return tops;
  const p = Math.max(0, Math.min(n - 1, pivot));
  tops[p] = cards[p].desired ?? 0;
  for (let i = p + 1; i < n; i++) tops[i] = Math.max(cards[i].desired ?? -Infinity, tops[i - 1] + cards[i - 1].h + gap);
  for (let i = p - 1; i >= 0; i--) tops[i] = Math.min(cards[i].desired ?? Infinity, tops[i + 1] - gap - cards[i].h);
  return tops;
}

/** Scroll needed to bring a card of height `h` at row `top` fully into a pane of `viewH` rows. */
export function revealShift(top, h, viewH) {
  if (top < 0) return top;
  if (top + h > viewH) return Math.min(top, top + h - viewH);
  return 0;
}

/** Limit a manual panel scroll to the extent of the placed content. */
export function clampPanelScroll(scroll, tops, heights, viewH) {
  if (tops.length === 0) return 0;
  const min = Math.min(0, tops[0]);
  const last = tops.length - 1;
  const max = Math.max(0, tops[last] + heights[last] - viewH);
  return Math.max(min, Math.min(max, scroll));
}

const clampTop = (top, paneH, boxH) => Math.max(0, Math.min(top, paneH - boxH));

/**
 * Where the comment box goes, in the coordinates of the document pane (row 0 = first body row).
 * Below the selection when it fits, otherwise above, otherwise pinned to the bottom (covering part of the
 * selection only when the pane is too small for anything else). The box is always completely inside the pane.
 *
 * @param {object} o
 * @param {number} o.paneW @param {number} o.paneH
 * @param {number} o.selTop     first selected viewport row (clamped into the pane)
 * @param {number} o.selBottom  last selected viewport row
 * @param {number} o.selLeft    column of the selection start
 * @param {number} o.boxW @param {number} o.boxH
 * @returns {{top: number, left: number, side: 'below' | 'above' | 'overlap'}}
 */
export function placeCommentBox({ paneW, paneH, selTop, selBottom, selLeft, boxW, boxH }) {
  const left = Math.max(0, Math.min(selLeft, paneW - boxW));
  const below = selBottom + 1;
  if (below + boxH <= paneH) return { top: below, left, side: 'below' };
  const above = selTop - boxH;
  if (above >= 0) return { top: above, left, side: 'above' };
  return { top: clampTop(paneH - boxH, paneH, boxH), left, side: 'overlap' };
}

/**
 * Where the reply box goes in the side panel: right below the thread's card, else above it, else pinned to the
 * bottom (over the card's tail). `cardTop` / `cardBottom` are pane rows and may lie outside the pane (a card that
 * is partly scrolled away); the box is always completely inside it.
 * @returns {{top: number, side: 'below' | 'above' | 'overlap'}}
 */
export function placeReplyBox({ cardTop, cardBottom, paneH, boxH }) {
  if (cardBottom >= 0 && cardBottom + boxH <= paneH) return { top: cardBottom, side: 'below' };
  if (cardTop - boxH >= 0 && cardTop <= paneH) return { top: cardTop - boxH, side: 'above' };
  return { top: clampTop(paneH - boxH, paneH, boxH), side: 'overlap' };
}

/** Width of the comment box: the document text width capped at 72 columns. */
export const commentBoxWidth = (textWidth, cap = 72) => Math.max(20, Math.min(textWidth, cap));
