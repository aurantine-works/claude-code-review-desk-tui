// The top bar of the review screen.
import stringWidth from 'string-width';
import { fitSegs, pushSeg } from './ansi.js';
import { COLOR, GLYPH } from './theme.js';
import { deliveryParts } from './deliveryModel.js';
import { headlessPart } from './channelC.js';
import { externalPart } from './externalModel.js';
import { t } from '../../i18n/index.js';

export function sessionText(session, alive) {
  if (!session) return 'session ?';
  if (session.state === 'ended') return 'session ended';
  if (!alive) return 'session gone';
  return `session ${session.state}${session.pid ? ` (pid ${session.pid})` : ''}`;
}

/**
 * What the top bar says about the review's state. {text, kind: 'info' | 'warn' | 'ok'} or null.
 * @param {object} meta
 * @param {boolean} hookAlive  a plan-review hook is blocking on this review
 * @param {{awaitingAlive?: boolean, channel?: string} | null} [delivery]
 */
export function stateText(meta, hookAlive, delivery = null) {
  const s = meta.status;
  if (s === 'approved') {
    return meta.approvedPendingExit ? { text: t('header.approvedWaiting'), short: t('header.approvedWaitingShort'), kind: 'info' } : { text: t('header.approved'), kind: 'ok' };
  }
  if (s === 'closed') return { text: t('header.closed'), kind: 'warn' };
  if (meta.kind !== 'plan') return null;
  // `delivered` means Claude has the feedback and is answering; `rd reply` turns it into `answered`. Neither says
  // anything about a resubmission any more (instant Q&A goes on without one).
  if (s === 'feedback_pending') return { text: t('header.feedbackPending'), short: t('header.feedbackPendingShort'), kind: 'info' };
  if (s === 'delivered') return { text: t('header.delivered'), kind: 'info' };
  if (s === 'answered') return { text: t('header.answered'), kind: 'ok' };
  if (hookAlive) return { text: t('header.planWaiting'), short: t('header.planWaitingShort'), kind: 'ok' };
  if (delivery?.awaitingAlive) return null; // the Q&A part says "instant Q&A"
  if (delivery?.channel === 'watch') return null; // the wake-up watcher wakes Claude for the next comment or the approval; the channel part says automatic delivery
  return { text: t('header.notWaiting'), short: t('header.notWaitingShort'), kind: 'warn' };
}

/** Header parts that are only dropped after every other part has been shortened. */
const ESSENTIAL = new Set(['rev', 'session']);

const KIND_STYLE = {
  ok: { fg: COLOR.ok, bold: true },
  warn: { fg: COLOR.warn, bold: true },
  info: { fg: COLOR.accent, bold: true },
  dim: { dim: true },
};

/** Header text of the diff view: which revisions are compared and how much changed. */
export function diffPart(d) {
  const range = `rev ${d.from}→${d.to}`;
  if (d.kind === 'tooLarge') return { id: 'diff', prio: 9, text: `diff ${range} · ${t('header.diffTooLarge')}`, short: `diff ${range}`, kind: 'warn' };
  if (d.kind === 'identical') return { id: 'diff', prio: 9, text: `diff ${range} · ${t('header.diffIdentical')}`, short: `diff ${range}`, kind: 'info' };
  const stat = `+${d.summary.added} -${d.summary.removed}`;
  return { id: 'diff', prio: 9, text: `diff ${range} · ${stat} · ${t('header.diffBase')}`, short: `diff ${range} ${stat}`, kind: 'info' };
}

/**
 * @param {object} p
 * @param {object} p.meta
 * @param {object | null} [p.delivery]  summarizeDelivery() result
 * @param {object | null} [p.headless]  headlessStatus() result: a background resume of the session (channel C [h])
 * @param {object | null} [p.external]  the reported external change (externalModel.js `observe()` result)
 * @param {{from: number, to: number, kind: string, summary: {added: number, removed: number}} | null} [p.diff]  the diff view is open
 * @returns {import('./ansi.js').Segment[]} exactly `cols` columns
 */
export function buildHeader({ meta, session, sessionAlive, hookAlive, sendMode, cols, incoming = null, delivery = null, headless = null, external = null, diff = null }) {
  const state = stateText(meta, hookAlive, delivery);
  const extra = [external && externalPart(external), headlessPart(headless), diff && diffPart(diff)].filter(Boolean);
  // While rd's own background resume runs, "session ended" is no longer the news (the headless part says what happens).
  const channelParts = deliveryParts(delivery).filter((p) => !(p.id === 'channel' && headless?.state === 'running'));
  const channelC = delivery?.channel === 'C' && channelParts.some((p) => p.id === 'channel');
  const parts = [
    { id: 'rev', prio: 6, text: `rev ${meta.currentRevision}/${meta.revisions?.length ?? meta.currentRevision}`, style: null },
    meta.round > 0 && { id: 'round', prio: 5, text: `round ${meta.round}`, style: null },
    state && { id: 'state', prio: 8, text: state.text, short: state.short, style: KIND_STYLE[state.kind] },
    ...extra.map((p) => ({ id: p.id, prio: p.prio, text: p.text, short: p.short, style: KIND_STYLE[p.kind] })),
    ...channelParts.map((p) => ({ id: p.id, prio: p.prio, text: p.text, short: p.short, style: KIND_STYLE[p.kind] })),
    // Channel C's own hint ("session ended", "session not found") already says what is wrong with the session: no second part.
    !channelC && { id: 'session', prio: 3, text: sessionText(session, sessionAlive), style: { dim: true } },
    { id: 'mode', prio: 4, text: sendMode === 'batch' ? t('header.modeBatch') : t('header.modeInstant'), style: { dim: true } },
  ].filter(Boolean);
  const right = incoming ? t('header.incoming', { name: incoming.length > 24 ? `${incoming.slice(0, 23)}…` : incoming }) : diff ? t('header.backToText') : '[d] diff';
  const title = meta.title || meta.id;

  const width = (list, ttl) => 1 + stringWidth(ttl) + list.reduce((n, p) => n + stringWidth(GLYPH.sep) + stringWidth(p.text), 0);
  let list = parts.map((p) => ({ ...p }));
  let showRight = true;
  let shownTitle = title;
  const room = () => cols - (showRight ? stringWidth(right) + 2 : 0);
  while (width(list, shownTitle) > room() && list.length > 0) {
    // The least important part gives way first: it switches to its short wording, and once it has nothing shorter it is
    // dropped. The revision and the session state are essential, though: before one of them is dropped, any other part
    // that has a shorter wording (a long state or delivery hint) switches to it, lowest priority first. Pressing warnings
    // (prio >= 9: file changed outside, diff, ...) are the exception and keep their full text until the essentials are gone.
    const lowest = list.reduce((a, b) => (b.prio < a.prio ? b : a));
    const shortenable = (p) => p.short && p.text !== p.short;
    if (shortenable(lowest)) {
      lowest.text = lowest.short;
      continue;
    }
    const softer = (p) => shortenable(p) && p.prio < 9;
    if (ESSENTIAL.has(lowest.id) && list.some(softer)) {
      const next = list.filter(softer).reduce((a, b) => (b.prio < a.prio ? b : a));
      next.text = next.short;
      continue;
    }
    if (lowest.prio >= 8 && showRight) {
      // the diff hint goes before the state / wake-up hint does
      showRight = false;
      continue;
    }
    list = list.filter((p) => p !== lowest);
  }
  if (width(list, shownTitle) > room()) {
    // Cut the title itself.
    const budget = Math.max(4, room() - 2);
    let out = '';
    for (const ch of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(shownTitle)) {
      if (stringWidth(out + ch.segment) > budget - 1) break;
      out += ch.segment;
    }
    shownTitle = `${out}…`;
  }

  const segs = [];
  pushSeg(segs, ' ', null);
  pushSeg(segs, shownTitle, { bold: true });
  for (const p of list) {
    pushSeg(segs, GLYPH.sep, { dim: true });
    pushSeg(segs, p.text, p.style);
  }
  if (showRight) {
    const used = segs.reduce((n, s) => n + stringWidth(s.text), 0);
    const gap = cols - used - stringWidth(right) - 1;
    if (gap >= 1) {
      pushSeg(segs, ' '.repeat(gap), null);
      pushSeg(segs, right, incoming ? { fg: COLOR.warn, bold: true } : { dim: true });
    }
  }
  return fitSegs(segs, cols);
}
