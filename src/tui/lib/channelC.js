// Channel C in the TUI: the review's Claude Code session is gone while feedback waits for it. Pure helpers (plus two
// cheap synchronous store reads) for the dialog that offers [c] show the resume command, [h] resume in the background,
// [l] leave it queued - see delivery/resume.js for what each does.
import os from 'node:os';
import { planDelivery, deliveryState } from '../../delivery/index.js';
import { t } from '../../i18n/index.js';

/** planDelivery() reasons of channel C where resuming the session makes sense (`headless-running` is already being resumed). */
export const RESUMABLE_REASONS = new Set(['session-ended', 'process-gone']);

/**
 * Should the "session ended" dialog be offered for this review right now? Yes when its feedback sits in the outbox and the
 * session cannot take it. `key` identifies the queued batch (the review + when its oldest waiting message was queued):
 * a message sent while the batch is still waiting belongs to the same batch.
 * @param {string} id
 * @param {{planDelivery?: Function, deliveryState?: Function}} [deps]
 * @returns {{offer: boolean, channel: string, reason: string, queued: number, key: string | null}}
 */
export function channelCOffer(id, deps = {}) {
  const plan = (deps.planDelivery ?? planDelivery)(id);
  if (plan.channel !== 'C') return { offer: false, channel: plan.channel, reason: plan.reason, queued: 0, key: null };
  const queued = (deps.deliveryState ?? deliveryState)(id).queued;
  const oldest = queued.map((e) => e.at ?? '').sort()[0] ?? null;
  return {
    offer: RESUMABLE_REASONS.has(plan.reason) && queued.length > 0,
    channel: 'C',
    reason: plan.reason,
    queued: queued.length,
    key: queued.length ? `${id}|${oldest}` : null,
  };
}

// The dialog opens by itself once per batch (module level: leaving the review and coming back does not open it again).
const autoOpened = new Set();

/** True the first time a batch is seen (and remembers it). */
export function takeAutoOpen(offer) {
  if (!offer.offer || !offer.key || autoOpened.has(offer.key)) return false;
  autoOpened.add(offer.key);
  return true;
}

/** Forget which batches were announced (tests). */
export const resetAutoOpen = () => autoOpened.clear();

/**
 * startHeadless() refusal -> a readable message. `r` = {reason, message?, error?, cwd?}.
 */
export function refusalText(r) {
  switch (r?.reason) {
    case 'review-finished':
      return t('resume.refReviewFinished');
    case 'no-session':
      return t('resume.refNoSession');
    case 'invalid-session-id':
      return t('resume.refInvalidSession');
    case 'nothing-waiting':
      return t('resume.refNothingWaiting');
    case 'session-alive':
      return t('resume.refSessionAlive');
    case 'headless-running':
      return t('resume.refHeadlessRunning');
    case 'cwd-missing':
      return t('resume.refCwdMissing', { cwd: r.cwd });
    case 'spawn-failed':
      return t('resume.refSpawnFailed', { error: r.error });
    default:
      return t('resume.refOther', { message: r?.message ?? r?.reason ?? 'unknown' });
  }
}

/** `/home/me/x` -> `~/x` for display. */
export function tildePath(p, home = os.homedir()) {
  if (!p) return '';
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/**
 * The top bar part for a headlessStatus() result, or null.
 * running -> "resuming in background" (pid), failed -> "failed: see <log>", finished -> "finished" (with the number of threads still unanswered).
 * @returns {{id: string, prio: number, text: string, short?: string, kind: 'ok'|'warn'|'info'|'dim'} | null}
 */
export function headlessPart(h, { home } = {}) {
  if (!h) return null;
  const log = tildePath(h.log, home);
  switch (h.state) {
    case 'running':
      return { id: 'headless', prio: 9, text: t('resume.partRunning', { pid: h.pid }), short: t('resume.partRunningShort'), kind: 'info' };
    case 'failed':
      return { id: 'headless', prio: 9, text: t('resume.partFailed', { log }), short: t('resume.partFailedShort'), kind: 'warn' };
    default:
      if (h.pending > 0) return { id: 'headless', prio: 8, text: t('resume.partPending', { n: h.pending, log }), short: t('resume.partFinishedShort'), kind: 'warn' };
      return { id: 'headless', prio: 3, text: t('resume.partFinished'), kind: 'dim' };
  }
}

/** One-line description of a headlessStatus() result for the dialog. */
export function headlessLine(h, { home } = {}) {
  if (!h) return null;
  const log = tildePath(h.log, home);
  if (h.state === 'running') return t('resume.lineRunning', { pid: h.pid, log });
  if (h.state === 'failed') {
    const why = h.signal ? t('resume.whySignal', { signal: h.signal }) : h.exitCode != null && h.exitCode !== 0 ? t('resume.whyExit', { code: h.exitCode }) : t('resume.whyNothing');
    return t('resume.lineFailed', { why, log });
  }
  return h.pending > 0 ? t('resume.linePending', { n: h.pending, log }) : t('resume.lineFinished', { log });
}

/** Notice for a headless run that ended while the screen was open (running -> finished / failed). */
export function headlessEndNotice(h, { home } = {}) {
  const log = tildePath(h.log, home);
  if (h.state === 'failed') return { text: t('resume.noticeFailed', { log }), kind: 'err', ms: 8000 };
  if (h.pending > 0) return { text: t('resume.noticePending', { n: h.pending, log }), kind: 'warn', ms: 8000 };
  return { text: t('resume.noticeFinished'), kind: 'info', ms: 5000 };
}
