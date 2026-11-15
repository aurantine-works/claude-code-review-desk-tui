// Delivery engine: which channel carries a review's feedback back to its Claude Code session, and the
// optional auto-injection.
//
//   await   a background `rd await` of the session is alive and delivers within a second (instant Q&A)
//   hook    a plan-review hook is blocking on this review and delivers the feedback as its deny message
//   watch   the session's wake-up watcher (`rd hook watch`, delivery/watch.js) is alive: it hands the feedback to Claude within a
//           second, idle or busy, and wakes an idle session. Nothing is typed anywhere (no injection) and nothing is needed in Claude
//   inject  the session is idle and an injector adapter (tmux / ccd) can type `/review-reply <id>` for the user
//   A       idle, no injector: the feedback rides along with the user's next prompt (prompt-submit hook)
//   B       busy: the Stop hook hands it over when the turn ends
//   C       the session is gone: resume it (delivery/resume.js: interactive command, headless run, leave it). Also while a
//           headless run of the session is alive (reason `headless-running`): it fetches the feedback by itself
//   none    the review is finished
//
// planDelivery() is a cheap synchronous read for the TUI header. deliver() acts (only `inject` needs action:
// the other channels are carried by hooks and `rd await`). Every channel hands feedback over through
// takeUnreceived(), so a message is delivered exactly once whichever channel wins.
import { getMeta } from '../store/reviews.js';
import { assertReviewId, REVIEW_ID_RE } from '../store/ids.js';
import { readSessions, getSession, isPidAlive } from '../store/sessions.js';
import { awaitingAlive, watcherAlive } from '../store/proc.js';
import { readJson } from '../store/io.js';
import { paths } from '../store/paths.js';
import { unreceived, claimInjection, releaseInjection, isFinalStatus } from '../store/outbox.js';
import { isPending } from '../store/threads.js';
import { loadConfig } from '../config.js';
import { getAdapter } from './adapters/index.js';
import { sleep } from './adapters/util.js';

// The TUI's `E` key; re-exported so everything the instant Q&A UI needs is importable from here.
export { endInstant } from '../store/lifecycle.js';

/** A message received by Claude but unanswered for this long while the session is idle: Claude was not woken. */
export const WAKE_AFTER_MS = 60_000;
/** Do not type into a terminal twice for the same waiting feedback within this window. */
const REINJECT_AFTER_MS = 60_000;

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/** How long the session has been in its current state, in ms (NaN when unknown). */
export function stateAgeMs(session, now = Date.now()) {
  return now - ms(session?.stateSince ?? session?.updatedAt);
}

function injectorInfo(session, config) {
  const inj = session?.injector;
  if (!inj || inj.kind === 'none' || !getAdapter(inj.kind)) return { kind: 'none', usable: false };
  const autoInject = config.delivery?.autoInject !== false;
  return { ...inj, usable: autoInject, ...(autoInject ? {} : { reason: 'autoInject-off' }) };
}

/**
 * Which channel will carry this review's feedback. Pure read (no spawning, no writing), cheap enough
 * to call on every TUI refresh.
 * @param {string} reviewId
 * @param {{config?: object, now?: number}} [deps]
 * @returns {{channel: 'await'|'hook'|'watch'|'inject'|'A'|'B'|'C'|'none', reason: string,
 *            sessionState: 'idle'|'busy'|'ended'|'unknown', idleForMs: number|null,
 *            injector: {kind: string, target?: string, usable: boolean, reason?: string}}}
 */
export function planDelivery(reviewId, deps = {}) {
  const meta = getMeta(assertReviewId(reviewId));
  const config = deps.config ?? loadConfig();
  const now = deps.now ?? Date.now();
  const session = meta.sessionId ? getSession(meta.sessionId) : null;
  const injector = injectorInfo(session, config);
  const out = (channel, reason, sessionState) => ({
    channel,
    reason,
    sessionState,
    idleForMs: sessionState === 'idle' ? stateAgeMs(session, now) : null,
    injector,
  });

  if (isFinalStatus(meta.status)) return out('none', 'review-finished', session?.state ?? 'unknown');
  if (!session) return out('C', 'no-session', 'unknown');
  if (session.state === 'ended') return out('C', 'session-ended', 'ended');
  // A recorded pid that is gone means claude died without SessionEnd (SIGKILL, SSH drop).
  if (Number.isInteger(session.pid) && !isPidAlive(session.pid)) return out('C', 'process-gone', 'ended');
  const state = session.state === 'busy' ? 'busy' : 'idle';
  // `claude --resume <id> -p` (rd's own background resume) took over the session record: it delivers by itself
  // (prompt-submit hook, channel A), so the review is still waiting on channel C as far as the user is concerned.
  if (session.headless === true && !isFinalStatus(meta.status)) return out('C', 'headless-running', state);

  if (meta.kind === 'plan' && meta.hook && isPidAlive(meta.hook.pid)) return out('hook', 'plan-hook-waiting', state);
  const a = session.awaiting;
  if (a && awaitingAlive(session) && (a.reviewId == null || a.reviewId === meta.id)) return out('await', 'awaiting-alive', state);
  if (watcherAlive(session)) return out('watch', 'watcher-alive', state);
  if (state === 'busy') return out('B', 'busy', state);
  if (injector.usable) return out('inject', 'idle-injector', state);
  return out('A', injector.reason === 'autoInject-off' ? 'idle-autoinject-off' : 'idle-no-injector', state);
}

/** Which session record owns this injection target? The live one that started last (nested `claude -p` loses). */
function targetOwner(injector, sessions) {
  const same = (a, b) => a?.kind === b.kind && a.target === b.target && (a.socket ?? null) === (b.socket ?? null);
  const owners = Object.values(sessions).filter((s) => s.state !== 'ended' && same(s.injector, injector) && (!Number.isInteger(s.pid) || isPidAlive(s.pid)));
  owners.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return owners[0]?.sessionId ?? null;
}

/**
 * All the safety checks before typing into a terminal: the session is idle for long enough, it has an
 * adapter, the pane / session is alive and is registered to THIS session (not a later claude in the same
 * pane), and the adapter itself agrees it is that session's terminal.
 * @returns {Promise<{ok: boolean, reason?: string, adapter?: object, injector?: object}>}
 */
async function checkInjectable(session, config, deps) {
  const now = deps.now ?? Date.now();
  if (!session || session.state !== 'idle') return { ok: false, reason: 'not-idle' };
  // The wake-up watcher delivers (and wakes the session) by itself: a typed `/review-reply` would only land in the user's prompt.
  if (watcherAlive(session)) return { ok: false, reason: 'watcher-alive' };
  const idleMs = (config.delivery?.injectIdleSeconds ?? 2) * 1000;
  if (!(stateAgeMs(session, now) >= idleMs)) return { ok: false, reason: 'idle-too-short' };
  if (Number.isInteger(session.pid) && !isPidAlive(session.pid)) return { ok: false, reason: 'process-gone' };
  const info = injectorInfo(session, config);
  if (!info.usable) return { ok: false, reason: info.reason ?? 'no-injector' };
  const adapter = deps.adapter ?? getAdapter(info.kind);
  const { usable, reason, ...injector } = info; // the record as registered
  if (!(await adapter.isAlive(injector, deps))) return { ok: false, reason: 'target-gone' };
  if (targetOwner(injector, deps.sessions ?? readSessions()) !== session.sessionId) return { ok: false, reason: 'target-owned-by-another-session' };
  if (adapter.verify) {
    const v = await adapter.verify(injector, session, deps);
    if (!v.ok) return { ok: false, reason: v.reason ?? 'verify-failed' };
  }
  return { ok: true, adapter, injector };
}

const waitingEntries = (id) => unreceived(readJson(paths.outbox(id), []));

/**
 * Carry out the delivery of a review's waiting feedback. The user pressed send/submit in the TUI (or ran
 * `rd deliver`). Only the `inject` channel has anything to do here; `await`, `hook`, `A`, `B` are carried by
 * the processes and hooks that are already there, and `C` is the TUI dialog (delivery/resume.js).
 *
 * inject: waits until the session has been idle for `delivery.injectIdleSeconds` (at most
 * `delivery.injectWaitSeconds`), re-checks everything, then types `/review-reply <id>` and records
 * `injectedAt` on the waiting entries. When the session does not become idle in time (or the checks fail)
 * the feedback simply stays queued and is reported as channel A (idle) or B (busy).
 *
 * @param {string} reviewId
 * @param {{whenIdle?: boolean}} [opts] whenIdle: also wait for a BUSY session to become idle and then inject
 *        (otherwise a busy session is left to the Stop hook, channel B)
 * @param {object} [deps] config, adapter, now (() => ms), sleep, sessions, pollMs (tests)
 * @returns {Promise<{channel: string, reason: string, action: 'none'|'injected'|'skipped'|'failed', error?: string, plan: object}>}
 */
export async function deliver(reviewId, opts = {}, deps = {}) {
  assertReviewId(reviewId);
  const config = deps.config ?? loadConfig();
  const pause = deps.sleep ?? sleep;
  const waitMs = (config.delivery?.injectWaitSeconds ?? 30) * 1000;
  const clock = typeof deps.now === 'function' ? deps.now : Date.now; // deps.now: () => ms (tests)
  const started = clock();
  const result = (plan, action, extra = {}) => ({ channel: plan.channel, reason: plan.reason, action, plan, ...extra });

  for (;;) {
    const plan = planDelivery(reviewId, { config, now: clock() });
    if (waitingEntries(reviewId).length === 0) return result(plan, 'none', { reason: 'nothing-waiting' });
    const wantsInject = plan.channel === 'inject' || (opts.whenIdle && plan.channel === 'B' && plan.injector.usable);
    if (!wantsInject) return result(plan, 'none');

    const session = getSession(getMeta(reviewId).sessionId);
    const check = await checkInjectable(session, config, { ...deps, now: clock() });
    if (check.ok) {
      // Claim first, type second: a burst of sent messages calls deliver() several times.
      if (!(await claimInjection(reviewId, { now: clock(), staleMs: REINJECT_AFTER_MS }))) return result(plan, 'skipped', { reason: 'already-injected' });
      try {
        await check.adapter.inject(check.injector, `/review-reply ${reviewId}`, deps);
      } catch (err) {
        await releaseInjection(reviewId);
        return { channel: 'A', reason: 'inject-failed', action: 'failed', error: err.message, plan };
      }
      return result(plan, 'injected', { channel: 'inject' });
    }
    // Not yet: wait for the idle period; any other reason ends the attempt.
    if (['not-idle', 'idle-too-short'].includes(check.reason) && clock() - started < waitMs) {
      await pause(deps.pollMs ?? 250);
      continue;
    }
    const fallback = session?.state === 'busy' ? 'B' : 'A';
    return { channel: fallback, reason: `inject-${check.reason}`, action: 'none', plan: { ...plan, channel: fallback } };
  }
}

/**
 * Wake an idle session whose `rd await` output was received but not acted on (the known "background task did
 * not wake Claude" case): type `/review-reply <reviewId>` (or the bare `/review-reply`), subject to the same
 * checks as deliver(). The text is fixed; nothing of the comments is typed.
 * @param {string} sessionId
 * @param {{reviewId?: string}} [opts]
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function injectWake(sessionId, opts = {}, deps = {}) {
  const config = deps.config ?? loadConfig();
  const session = getSession(sessionId);
  if (opts.reviewId !== undefined && !REVIEW_ID_RE.test(opts.reviewId)) return { ok: false, reason: 'invalid-review-id' };
  const clock = typeof deps.now === 'function' ? deps.now : Date.now;
  const check = await checkInjectable(session, config, { ...deps, now: clock() });
  if (!check.ok) return { ok: false, reason: check.reason };
  try {
    await check.adapter.inject(check.injector, opts.reviewId ? `/review-reply ${opts.reviewId}` : '/review-reply', deps);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'inject-failed', error: err.message };
  }
}

/**
 * What the TUI shows about the delivery of a review's feedback (read-only, cheap).
 * @returns {{
 *   status: string,
 *   session: {state: string, alive: boolean, idleForMs: number|null}|null,
 *   awaiting: {alive: boolean, reviewId: string|null, since: string, pid: number}|null,
 *   watcher: {alive: boolean, since: string, pid: number}|null,   // the wake-up watcher of the session
 *   interrupted: boolean,            // an `rd await` was recorded but its process is gone
 *   instantEnded: boolean,           // the user pressed E
 *   queued: object[],                // sent, not received yet
 *   received: object[],              // handed to Claude (receivedAt), until `rd done`
 *   answering: string[],             // thread ids Claude has received a message of and not answered yet
 *   oldestReceivedAt: string|null,
 *   wakeNeeded: boolean,             // received >= 60 s ago, unanswered, session idle, no await alive: Claude was not woken
 * }}
 */
export function deliveryState(reviewId, deps = {}) {
  const meta = getMeta(assertReviewId(reviewId));
  const now = deps.now ?? Date.now();
  const session = meta.sessionId ? getSession(meta.sessionId) : null;
  const outbox = readJson(paths.outbox(reviewId), []);
  const threads = readJson(paths.threads(reviewId), []);
  const queued = outbox.filter((e) => !e.receivedAt);
  const received = outbox.filter((e) => e.receivedAt);
  const pendingIds = new Set(threads.filter(isPending).map((t) => t.id));
  const answering = [...new Set(received.map((e) => e.threadId))].filter((id) => pendingIds.has(id));
  const oldest = received.map((e) => e.receivedAt).sort()[0] ?? null;
  const a = session?.awaiting ?? null;
  const alive = !!a && awaitingAlive(session);
  const w = session?.watcher ?? null;
  const idle = session?.state === 'idle';
  return {
    status: meta.status,
    session: session ? { state: session.state, alive: !Number.isInteger(session.pid) || isPidAlive(session.pid), idleForMs: idle ? stateAgeMs(session, now) : null } : null,
    awaiting: a ? { alive, reviewId: a.reviewId ?? null, since: a.since, pid: a.pid } : null,
    watcher: w ? { alive: watcherAlive(session), since: w.since, pid: w.pid } : null,
    interrupted: !!a && !alive,
    instantEnded: !!meta.instant?.endedAt,
    queued,
    received,
    answering,
    oldestReceivedAt: oldest,
    wakeNeeded: answering.length > 0 && idle && !alive && now - ms(oldest) >= WAKE_AFTER_MS,
  };
}
