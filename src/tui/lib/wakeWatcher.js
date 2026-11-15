// App-level wake-up watcher. A review whose feedback Claude received (`rd await` printed it, or a hook handed it
// over) but never answered, while its session sits idle, means the known "background task did not wake an idle
// session" case. deliveryState() flags it (`wakeNeeded`, after WAKE_AFTER_MS); this module types the fixed
// `/review-reply <id>` command into the session's terminal (injectWake) when an injector is usable.
//
// It runs from App on a timer, for every unfinished review, so it works in the inbox as well as in a review
// screen. Rules:
//  - nothing is typed while the session's wake-up watcher is alive (channel 'watch'), the header hint is all that is left;
//  - one injection per session at a time: when several of its reviews need a wake-up, the one waiting longest wins;
//  - a (sessionId, oldestReceivedAt) pair that was woken successfully is never woken again;
//  - a refusal for a transient reason is retried after WAKE_RETRY_MS, at most WAKE_MAX_RETRIES times
//    (so 1 + 3 attempts); a permanent refusal is final for that pair.
// Pure logic: the clock, the review list, deliveryState / planDelivery / injectWake are injectable.
import { deliveryState as realDeliveryState, planDelivery as realPlanDelivery, injectWake as realInjectWake } from '../../delivery/index.js';
import { listMetas } from '../../store/reviews.js';
import { t } from '../../i18n/index.js';

/** How often App runs a check. */
export const WAKE_POLL_MS = 2500;
/** Wait before trying again after a transient refusal. */
export const WAKE_RETRY_MS = 15_000;
/** Retries after the first attempt. */
export const WAKE_MAX_RETRIES = 3;
/** The one-time message after a successful wake-up (review screen notice, inbox footer). */
export const wakeOkText = () => t('wake.ok');

/**
 * Reasons injectWake() gives for a refusal that can go away by itself:
 *   not-idle / idle-too-short   the session is working, or went idle less than delivery.injectIdleSeconds ago
 *   inject-failed               the adapter threw while typing (tmux hiccup)
 * Every other reason is permanent: no-injector, autoInject-off (configuration), target-owned-by-another-session
 * (the terminal belongs to a later session: the sessionId does not match), target-gone / pane-gone /
 * pane-process-mismatch / no-session-pid / verify-failed (the terminal is not that session's any more),
 * process-gone, invalid-review-id, and anything unknown (do not type into a terminal on a guess).
 */
const TRANSIENT_REASONS = new Set(['not-idle', 'idle-too-short', 'inject-failed']);
export const isTransientWakeReason = (reason) => TRANSIENT_REASONS.has(reason);

const FINAL = new Set(['approved', 'closed']);

/**
 * @param {object} [deps]
 * @param {() => Array<{id: string, sessionId?: string, status?: string}>} [deps.listReviews] review metas to look at
 *        (App passes its polled inbox list; the default reads the store)
 * @param {(id: string, d?: object) => object} [deps.deliveryState]
 * @param {(id: string, d?: object) => {injector?: {usable?: boolean}}} [deps.planDelivery]
 * @param {(sessionId: string, opts: {reviewId: string}) => Promise<{ok: boolean, reason?: string}>} [deps.injectWake]
 * @param {() => number} [deps.now] ms
 * @param {number} [deps.retryMs]
 * @param {number} [deps.maxRetries]
 */
export function createWakeWatcher(deps = {}) {
  const listReviews = deps.listReviews ?? listMetas;
  const stateOf = deps.deliveryState ?? realDeliveryState;
  const planOf = deps.planDelivery ?? realPlanDelivery;
  const inject = deps.injectWake ?? realInjectWake;
  const clock = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? WAKE_RETRY_MS;
  const maxRetries = deps.maxRetries ?? WAKE_MAX_RETRIES;

  /** key `${sessionId}|${oldestReceivedAt}` -> {state: 'done'|'dead'|'retry', failures, nextAt, reason} */
  const records = new Map();

  /** The review of each session that has been waiting for a wake-up longest. */
  function candidates(t) {
    const bySession = new Map();
    for (const m of listReviews()) {
      if (!m.sessionId || FINAL.has(m.status)) continue;
      let st;
      try {
        st = stateOf(m.id, { now: t });
      } catch {
        continue; // vanished or half-written
      }
      if (FINAL.has(st.status) || !st.wakeNeeded || !st.oldestReceivedAt) continue;
      const cur = bySession.get(m.sessionId);
      if (!cur || st.oldestReceivedAt < cur.oldestReceivedAt) bySession.set(m.sessionId, { sessionId: m.sessionId, reviewId: m.id, oldestReceivedAt: st.oldestReceivedAt });
    }
    return [...bySession.values()];
  }

  /**
   * One check. Resolves to the wake-ups that succeeded in this run: [{sessionId, reviewId}].
   */
  async function tick() {
    const woke = [];
    for (const c of candidates(clock())) {
      const key = `${c.sessionId}|${c.oldestReceivedAt}`;
      const rec = records.get(key);
      if (rec && (rec.state === 'done' || rec.state === 'dead')) continue;
      if (rec && clock() < rec.nextAt) continue;
      // No usable injector (none registered, autoInject off): only the header hint helps. Cheap to re-check
      // every run, so an injector registered later is picked up. Likewise while the session's wake-up watcher is alive: it
      // wakes Claude by itself, a typed `/review-reply` would only land in the prompt (the header's hint stays).
      try {
        const plan = planOf(c.reviewId, { now: clock() });
        if (plan.injector?.usable !== true || plan.channel === 'watch') continue;
      } catch {
        continue;
      }

      let res;
      try {
        res = await inject(c.sessionId, { reviewId: c.reviewId });
      } catch (err) {
        res = { ok: false, reason: 'inject-failed', error: err?.message };
      }
      if (res?.ok) {
        records.set(key, { state: 'done', failures: rec?.failures ?? 0 });
        woke.push({ sessionId: c.sessionId, reviewId: c.reviewId });
      } else if (isTransientWakeReason(res?.reason)) {
        const failures = (rec?.failures ?? 0) + 1;
        records.set(key, failures > maxRetries ? { state: 'dead', failures, reason: res.reason } : { state: 'retry', failures, nextAt: clock() + retryMs, reason: res.reason });
      } else {
        records.set(key, { state: 'dead', failures: (rec?.failures ?? 0) + 1, reason: res?.reason ?? 'unknown' });
      }
    }
    return woke;
  }

  return { tick };
}
