// The wake-up watcher behind `rd hook watch` (hooks/watch.js). Claude Code starts it from SessionStart and from every Stop
// as a background hook with `asyncRewake: true` (verified on 2.1.325): when it exits with code 2 its
// stderr is shown to Claude and wakes the session immediately, idle or not. So comments reach an idle session by themselves.
//
// Contract:
//  - one watcher per session id: `sessions[sid].watcher = {pid, startTime, since}` is registered under the sessions lock
//    (like `awaiting`); another live one makes this run exit 0 at once;
//  - polls once per second (never fs.watch). Exits 0, silently, when it is signalled (/exit sends SIGTERM), when the session
//    record says `ended` (/clear: the old watcher is not signalled), or when the owning claude process is gone;
//  - when a review of the session has unreceived feedback it takes it with takeUnreceived(id, {via: 'watch'}) (the lock makes that
//    exclusive against the Stop hook, `rd await` and channel A), returns the text and the caller exits with code 2. Delivered
//    whatever the recorded busy / idle state says: an exit 2 in the middle of a turn arrives at the next tool boundary, and the
//    recorded state can be stale after an Esc interrupt. NOT taken: plan reviews whose blocking hook is alive (its deny message
//    delivers) and reviews a live model-started `rd await` covers (it delivers within a second);
//  - an approved plan nobody acted on (`meta.approvedPendingExit`: approved while no hook was waiting) is announced once per approval
//    (`meta.exitNotifiedAt`, written before the text goes out, so it also holds across watcher restarts): Claude calls ExitPlanMode
//    again with the unchanged plan and the plan-review hook allows it;
//  - the registration is cleared BEFORE anything is returned. The next watcher is armed by the Stop that ends the wake-up turn.
// Errors never wake Claude: an exception ends the run (the dispatcher logs it) without a result.
import { isSessionId } from '../store/sessions.js';
import { findClaudeProcess, isSameProcessAlive, awaitingAlive, watcherAlive } from '../store/proc.js';
import { readSessionReviews, planHookAlive } from '../store/outbox.js';
import { withReview } from '../store/reviews.js';
import { nowIso } from '../store/time.js';
import { logLine } from '../store/log.js';
import { renderWatchOutput } from '../feedback/instructions.js';
import { isHeadlessEnv } from '../feedback/marker.js';
import { sleep, claimSlot, clearSlot, safeSession, takeReady } from './loop.js';

/** A failing poll is retried (a locked or briefly unreadable file); this many in a row end the run. */
const MAX_POLL_ERRORS = 10;

/**
 * Tell Claude about the approval of `meta` once: true for the caller that wins the (locked) check-and-set.
 * @param {string} id
 */
async function noteApproval(id) {
  return withReview(id, (ctx) => {
    if (ctx.meta.status !== 'approved' || !ctx.meta.approvedPendingExit || ctx.meta.exitNotifiedAt) return false;
    ctx.meta.exitNotifiedAt = nowIso();
    return true;
  });
}

/**
 * Run the watcher.
 * @param {{session_id?: string}} input the hook's stdin JSON
 * @param {object} [deps] env, signal (AbortSignal), pollMs (default 1000), claude ({pid, via, startTime}), isClaudeAlive()
 * @returns {Promise<{result: 'delivered'|'aborted'|'already-watching'|'ended'|'orphaned'|'superseded'|'skipped', output: string|null, reviewIds: string[]}>}
 */
export async function runWatch(input, deps = {}) {
  const sid = input?.session_id;
  const env = deps.env ?? process.env;
  const { signal } = deps;
  const pollMs = deps.pollMs ?? 1000;
  const none = (result) => ({ result, output: null, reviewIds: [] });
  if (!isSessionId(sid) || isHeadlessEnv(env)) return none('skipped');

  // The claude process this watcher belongs to (CLAUDE_PID first). Without a trustworthy pid (via 'ppid') liveness is not checked.
  const claude = deps.claude ?? findClaudeProcess({ env });
  const initialPpid = process.ppid;
  const claudeAlive = deps.isClaudeAlive ?? (() => process.ppid === initialPpid && (claude.via === 'ppid' || isSameProcessAlive(claude)));

  const register = () => claimSlot(sid, 'watcher', { isAlive: watcherAlive, claude });
  if (!(await register())) return none('already-watching');
  // A resumed session still carries the endedAt of its previous run until SessionStart clears it (that hook runs in parallel
  // with this one): only an end that happens AFTER we started means the session is over.
  const endedBaseline = safeSession(sid)?.endedAt ?? null;

  /** Clear the registration FIRST: the text must not be visible while we still look alive. */
  const finish = async (result, extra = {}) => {
    await clearSlot(sid, 'watcher', 'hook watch');
    return { result, output: extra.output ?? null, reviewIds: extra.reviewIds ?? [] };
  };

  let errors = 0;
  try {
    for (;;) {
      if (signal?.aborted) return await finish('aborted');
      try {
        const session = safeSession(sid);
        if (session?.state === 'ended' && (session.endedAt ?? null) !== endedBaseline) return await finish('ended');
        if (!claudeAlive()) return await finish('orphaned');
        if (session) {
          const rec = session.watcher;
          if (rec && rec.pid !== process.pid && watcherAlive(session)) return await finish('superseded'); // not our record: left alone
          // Our record vanished (SessionStart's pid-change cleanup races with a first watcher): register again.
          if ((!rec || rec.pid !== process.pid) && !(await register())) return await finish('superseded');
        }

        // A live `rd await` delivers what it covers (a session-wide one everything, one bound to a review only that review).
        const waiting = session?.awaiting && awaitingAlive(session) ? session.awaiting : null;
        const covered = (meta) => !!waiting && (waiting.reviewId == null || waiting.reviewId === meta.id);
        const reviews = readSessionReviews(sid, { pendingExit: true });

        const items = await takeReady(reviews, { via: 'watch', skip: (meta) => planHookAlive(meta) || covered(meta) });
        const approvedPlans = [];
        for (const r of reviews) {
          if (r.meta.status === 'approved' && r.meta.approvedPendingExit && !covered(r.meta) && (await noteApproval(r.meta.id))) approvedPlans.push(r.meta);
        }
        if (items.length > 0 || approvedPlans.length > 0) {
          const output = renderWatchOutput(items, { approvedPlans });
          const reviewIds = [...items.map((i) => i.meta.id), ...approvedPlans.map((m) => m.id)];
          logLine('hook watch', `woke the session for ${reviewIds.join(', ')} (${output.length} chars)`);
          return await finish('delivered', { output, reviewIds });
        }
        errors = 0;
      } catch (err) {
        if (++errors === 1 || errors >= MAX_POLL_ERRORS) logLine('hook watch', err);
        if (errors >= MAX_POLL_ERRORS) throw err;
      }
      await sleep(pollMs, signal);
    }
  } catch (err) {
    await clearSlot(sid, 'watcher', 'hook watch');
    throw err;
  }
}
