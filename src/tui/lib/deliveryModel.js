// How the delivery backend (src/delivery) shows up in the TUI: a compact summary that is read once per poll,
// the header hints, the per-thread waiting lines and the messages after sending. Pure functions; the only
// store access is `summarizeDelivery`'s inputs, which the poller passes in.
import { t } from '../../i18n/index.js';

/**
 * Reduce planDelivery() + deliveryState() to what the screen needs. `idleForMs` is dropped on purpose: it changes
 * every second and would make every poll look like a change.
 * @returns {{channel: string, reason: string, sessionState: string, injectorUsable: boolean, injectorKind: string,
 *            awaitingAlive: boolean, watcherAlive: boolean, interrupted: boolean, instantEnded: boolean, queuedIds: string[], queuedCount: number,
 *            answeringIds: string[], wakeNeeded: boolean, oldestReceivedAt: string|null}}
 */
export function summarizeDelivery(plan, state) {
  return {
    channel: plan.channel,
    reason: plan.reason,
    sessionState: plan.sessionState,
    injectorKind: plan.injector?.kind ?? 'none',
    injectorUsable: plan.injector?.usable === true,
    awaitingAlive: state.awaiting?.alive === true,
    watcherAlive: state.watcher?.alive === true,
    interrupted: state.interrupted === true,
    instantEnded: state.instantEnded === true,
    queuedIds: [...new Set(state.queued.map((e) => e.threadId))],
    queuedCount: state.queued.length,
    answeringIds: state.answering,
    wakeNeeded: state.wakeNeeded === true,
    oldestReceivedAt: state.oldestReceivedAt,
  };
}

export const wakeText = () => t('delivery.wake');
export const aHint = () => t('delivery.aHint');
/** The session's wake-up watcher is alive: submitted comments reach Claude by themselves, idle or busy, nothing to do in Claude. */
export const watchText = () => t('delivery.watch');

/** "After you send: ..." text for a channel (header). */
export function channelHint(d) {
  switch (d.channel) {
    case 'await':
      return null; // shown as the "instant Q&A" part
    case 'hook':
      return { text: t('delivery.hintHook'), short: t('delivery.hintHookShort'), kind: 'dim' };
    case 'watch':
      return { text: watchText(), short: t('delivery.watchShort'), kind: 'dim' };
    case 'inject':
      return { text: t('delivery.hintInject'), kind: 'dim' };
    case 'A':
      return { text: t('delivery.hintA'), short: t('delivery.hintAShort'), kind: 'dim' };
    case 'B':
      return { text: t('delivery.hintB'), short: t('delivery.hintBShort'), kind: 'dim' };
    case 'C':
      if (d.reason === 'no-session') return { text: t('delivery.noSession'), kind: 'warn' };
      if (d.reason === 'headless-running' || d.headlessRunning) return null; // the header's headless part says "resuming in the background"
      // Something is queued: O reopens the resume dialog. Nothing queued: there is nothing to resume yet.
      return d.queuedCount > 0 ? { text: t('delivery.endedResume'), short: t('delivery.ended'), kind: 'warn' } : { text: t('delivery.ended'), kind: 'warn' };
    default:
      return null;
  }
}

/**
 * Header parts about delivery, most important first. Each has a priority (higher survives narrow terminals).
 * @returns {{id: string, prio: number, text: string, short?: string, kind: 'ok'|'warn'|'dim'}[]}
 */
export function deliveryParts(d) {
  if (!d || d.channel === 'none') return [];
  const parts = [];
  if (d.wakeNeeded) parts.push({ id: 'wake', prio: 10, text: wakeText(), kind: 'warn' });
  if (d.interrupted) parts.push({ id: 'qna', prio: 8, text: t('delivery.qnaInterrupted'), kind: 'warn' });
  else if (d.awaitingAlive) parts.push({ id: 'qna', prio: 7, text: t('delivery.qnaLive'), kind: 'ok' });
  else if (d.instantEnded) parts.push({ id: 'qna', prio: 4, text: t('delivery.qnaEnded'), kind: 'dim' });
  if (!d.awaitingAlive) {
    const hint = channelHint(d);
    if (hint) parts.push({ id: 'channel', prio: 5, text: hint.text, short: hint.short, kind: hint.kind });
  }
  return parts;
}

/** Is this the situation where the user has to start the loop in Claude (idle, nothing can reach it)? */
export const needsReviewReplyHint = (d) => !!d && d.channel === 'A' && d.sessionState === 'idle';

/**
 * The waiting line of a pending thread. Threads Claude has received are being answered; threads that were sent but
 * not received yet wait for a channel.
 */
export function pendingLabelFor(thread, d) {
  if (!d) return t('delivery.answering');
  if (d.answeringIds.includes(thread.id)) return t('delivery.answering');
  if (d.queuedIds.includes(thread.id)) {
    switch (d.channel) {
      case 'await':
        return t('delivery.pendAwait');
      case 'hook':
        return t('delivery.pendHook');
      case 'watch':
        return t('delivery.pendWatch');
      case 'inject':
        return t('delivery.pendInject');
      case 'A':
        return t('delivery.pendA');
      case 'B':
        return t('delivery.pendB');
      case 'C':
        if (d.reason === 'no-session') return t('delivery.pendNoSession');
        return d.reason === 'headless-running' || d.headlessRunning ? t('delivery.pendHeadless') : t('delivery.pendEnded');
      default:
        return t('delivery.pendWaiting');
    }
  }
  return t('delivery.answering');
}

/**
 * The status message after a send, from deliver()'s result.
 * @param {{channel: string, reason?: string, action?: string, error?: string}} res
 * @returns {{text: string, kind: 'info'|'warn'}}
 */
export function deliveryNotice(res) {
  if (res.action === 'failed') return { text: t('delivery.noticeInjectFailed', { error: res.error ?? res.reason }), kind: 'warn' };
  if (res.action === 'injected') return { text: t('delivery.noticeInjected'), kind: 'info' };
  if (res.reason === 'nothing-waiting') return { text: t('delivery.noticeReceived'), kind: 'info' };
  switch (res.channel) {
    case 'await':
      return { text: t('delivery.noticeAwait'), kind: 'info' };
    case 'hook':
      return { text: t('delivery.noticeHook'), kind: 'info' };
    case 'watch':
      return { text: t('delivery.noticeWatch'), kind: 'info' };
    case 'inject':
      return { text: t('delivery.noticeInject'), kind: 'info' };
    case 'A':
      return { text: t('delivery.noticeA'), kind: 'info' };
    case 'B':
      return { text: t('delivery.noticeB'), kind: 'info' };
    case 'C':
      if (res.reason === 'no-session') return { text: t('delivery.noticeNoSession'), kind: 'warn' };
      if (res.reason === 'headless-running') return { text: t('delivery.noticeHeadless'), kind: 'info' };
      return { text: t('delivery.noticeEnded'), kind: 'warn' };
    default:
      return { text: t('delivery.noticeSent'), kind: 'info' };
  }
}

/**
 * Message after pressing E. `res` is endInstant()'s result: `ended` (ids of the reviews of this session whose Q&A
 * was ended by this press; [] when it had been ended already) and `awaitingAlive` (a live `rd await` covered by
 * them: it prints `end` on its next poll, <= 1 s).
 * With the wake-up watcher alive (`res.watcherAlive`, filled in by the caller from the delivery summary) E only ends a model-started
 * `rd await`: comments are still delivered automatically, and the notice says so.
 * @param {{ended: string[], awaitingAlive: boolean, watcherAlive?: boolean}} res
 */
export function endInstantNotice(res) {
  const n = res?.ended?.length ?? 0;
  if (n === 0) return { text: t('delivery.endNone'), kind: 'info' };
  if (res.awaitingAlive) return { text: t('delivery.endAwaiting', { n }), kind: 'info' };
  if (res.watcherAlive) return { text: t('delivery.endWatcher'), kind: 'info' };
  return { text: t('delivery.endPlain'), kind: 'info' };
}

export const approvedPendingText = () => t('delivery.approvedPending');
// Claude waits in `rd await`: its next poll (<= 1 s) prints `end-plan` and it resubmits the plan.
// The wake-up watcher is alive: it tells the idle Claude (within a second) to call ExitPlanMode again.
export const approvedWakeText = () => t('delivery.approvedWake');
export const approvedNotifyText = () => t('delivery.approvedNotify');
