// `rd await [--review <id>]`: the wait loop behind instant Q&A. Claude starts it as a BACKGROUND Bash task and
// ends its turn; when feedback arrives the task prints it and exits, and the task-completion notification
// wakes Claude (the notification carries no stdout, so the prompt-submit hook adds the
// output as additionalContext; the text also tells Claude to Read the output file).
//
// Contract (see the design notes on `rd await`):
//  - one per session: a live `awaiting` record makes a new run print `already-waiting` and exit;
//  - `awaiting = {reviewId|null, since, pid, startTime}` is registered while waiting and cleared on every exit
//    (signals included); the TUI shows "instant Q&A" from it;
//  - polls (1 s, never fs.watch) the outbox of the session's reviews (or of the one given): unreceived entries are
//    marked received (`deliveredVia: 'await'`) and printed in `rd show --format prompt` style, exit 0;
//  - prints `end` when the review is closed / approved or the user ended instant mode (`E`), `end-plan` when a plan
//    was approved (Claude then calls ExitPlanMode once more with the same plan), `end` after
//    `config.review.idleEndMinutes` of silence;
//  - plan reviews whose hook is blocking are left to the hook (its deny message delivers).
// Every output starts with AWAIT_MARKER and has the result keyword on line 2.
//
// Since M5 a session normally has a wake-up watcher too (`rd hook watch`, delivery/watch.js): `rd await` stays as the
// fallback (older Claude Code, hooks not re-installed). The registration / polling pieces are shared with it in delivery/loop.js; while a live
// `rd await` covers a review the watcher leaves it alone, and its `feedback` output tells Claude not to start another wait when a watcher is alive.
import { assertReviewId } from '../store/ids.js';
import { getSession } from '../store/sessions.js';
import { findClaudeProcess, isSameProcessAlive, awaitingAlive, watcherAlive } from '../store/proc.js';
import { readSessionReviews, planHookAlive, isFinalStatus } from '../store/outbox.js';
import { getMeta } from '../store/reviews.js';
import { loadConfig } from '../config.js';
import { renderAwaitOutput } from '../feedback/instructions.js';
import { isHeadlessEnv } from '../feedback/marker.js';
import { resolveSession } from './session.js';
import { sleep, readReview, claimSlot, clearSlot, takeReady } from './loop.js';

/**
 * Run the wait loop.
 * @param {{review?: string, session?: string, pollMs?: number}} opts
 * @param {object} [deps] env, signal (AbortSignal), config, claude ({pid, via, startTime}), isClaudeAlive(), now() (ms)
 * @returns {Promise<{result: 'feedback'|'end'|'end-plan'|'already-waiting'|'aborted'|'orphaned', output: string|null, reviewIds: string[]}>}
 */
export async function runAwait(opts = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const { signal } = deps;
  const pollMs = opts.pollMs ?? 1000;
  if (opts.review !== undefined) {
    assertReviewId(opts.review);
    getMeta(opts.review); // fail early: "review not found"
  }
  const found = opts.session ? { sessionId: opts.session } : resolveSession({ env });
  if (!found) {
    throw new Error('cannot tell which Claude Code session this runs in (CLAUDE_CODE_SESSION_ID is not set); start it from Claude with the Bash tool or pass --session <id>');
  }
  const sid = found.sessionId;
  // A headless run (`claude -p`, channel C [h]) ends with its turn: a wait loop would only be killed with the process,
  // and `rd await` is not in its --allowedTools. Say so instead of registering an `awaiting` nobody serves.
  if (isHeadlessEnv(env)) return { result: 'end', output: renderAwaitOutput('end', { reason: 'this is a non-interactive run (claude -p): finish your turn after rd done' }), reviewIds: [] };
  const config = deps.config ?? loadConfig();
  const idleEndMs = config.review?.idleEndMinutes > 0 ? config.review.idleEndMinutes * 60_000 : null;
  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  const awaitCmd = opts.review ? `rd await --review ${opts.review}` : 'rd await';

  // The claude process this wait belongs to. Without a trustworthy pid (via 'ppid': our parent is the Bash
  // tool's shell, which may already be gone) liveness is not checked.
  const claude = deps.claude ?? findClaudeProcess({ env });
  const claudeAlive = deps.isClaudeAlive ?? (() => claude.via === 'ppid' || isSameProcessAlive(claude));

  // Register; the check-and-set runs inside the sessions lock, so two starts cannot both win.
  const won = await claimSlot(sid, 'awaiting', { isAlive: awaitingAlive, claude, extra: { reviewId: opts.review ?? null } });
  if (!won) return { result: 'already-waiting', output: renderAwaitOutput('already-waiting'), reviewIds: [] };

  const clearAwaiting = () => clearSlot(sid, 'awaiting', 'rd await');

  /** Clear the registration FIRST: the output must not be visible while we still look alive. */
  const finish = async (result, extra = {}) => {
    await clearAwaiting();
    // With the wake-up watcher running Claude does not have to start another wait: say so (instructions.js `auto`).
    const auto = result === 'feedback' && watcherAlive(getSession(sid));
    const output = result === 'aborted' || result === 'orphaned' ? null : renderAwaitOutput(result, { awaitCmd, auto, ...extra });
    return { result, output, reviewIds: extra.reviewIds ?? [] };
  };

  const seenPlans = new Map(); // session-wide mode: plan reviews seen active -> approved later means end-plan
  try {
    for (;;) {
      if (signal?.aborted) return await finish('aborted');

      const session = getSession(sid);
      if (session?.state === 'ended') return await finish('end', { reason: 'the Claude Code session ended' });
      if (!claudeAlive()) return await finish('orphaned');

      const active = opts.review ? [readReview(opts.review)].filter((r) => r && !isFinalStatus(r.meta.status)) : readSessionReviews(sid);
      for (const r of active) if (r.meta.kind === 'plan') seenPlans.set(r.meta.id, true);

      // 1. feedback first: a message queued just before the user ended Q&A is still delivered.
      const items = await takeReady(active, { via: 'await', skip: planHookAlive });
      if (items.length > 0) return await finish('feedback', { items, reviewIds: items.map((i) => i.meta.id) });

      // 2. the end of the conversation
      const ended = endOf(opts.review, active, seenPlans);
      if (ended) return await finish(ended.result, { reason: ended.reason, reviewIds: ended.reviewIds });

      if (idleEndMs !== null && clock() - startedAt >= idleEndMs) {
        return await finish('end', { reason: `no feedback for ${config.review.idleEndMinutes} minutes (review.idleEndMinutes)` });
      }
      await sleep(pollMs, signal);
    }
  } catch (err) {
    await clearAwaiting();
    throw err;
  }
}

/**
 * Has the conversation ended? `review` given: that review is finished (approved plan -> end-plan) or its instant
 * mode was ended. Session-wide: no review is left that still takes feedback (and then end-plan when a plan seen
 * on the way was approved).
 */
function endOf(review, active, seenPlans) {
  const finalReason = (meta) => (meta.status === 'approved' ? 'the plan was approved' : meta.kind === 'plan' ? 'the plan review was closed' : 'the review was closed');
  if (review) {
    const r = readReview(review);
    if (!r) return { result: 'end', reason: 'the review no longer exists', reviewIds: [review] };
    if (isFinalStatus(r.meta.status)) {
      return { result: r.meta.kind === 'plan' && r.meta.status === 'approved' ? 'end-plan' : 'end', reason: finalReason(r.meta), reviewIds: [review] };
    }
    if (r.meta.instant?.endedAt) return { result: 'end', reason: 'the user ended instant Q&A', reviewIds: [review] };
    return null;
  }
  if (active.some((r) => !r.meta.instant?.endedAt)) return null;
  // Nothing left that takes feedback. Was one of the plans approved?
  for (const id of seenPlans.keys()) {
    const m = readReview(id)?.meta;
    if (m?.status === 'approved') return { result: 'end-plan', reason: 'the plan was approved', reviewIds: [id] };
  }
  return { result: 'end', reason: active.length ? 'the user ended instant Q&A' : 'no open review is waiting for feedback', reviewIds: active.map((r) => r.meta.id) };
}

/**
 * CLI entry: print the output, exit code 0 (1 on error, with a message on stderr by bin/rd.js).
 * Installs signal handlers so that the `awaiting` record is cleared when the task is stopped.
 */
export async function awaitCommand(opts, deps = {}) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  // process.on, not once: proper-lockfile's signal-exit re-raises the signal when it finds no other listener.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, onSignal);
  const { result, output } = await runAwait(opts, { signal: controller.signal, ...deps });
  if (output) await new Promise((resolve) => process.stdout.write(output, resolve));
  process.exit(result === 'aborted' ? 130 : 0);
}
