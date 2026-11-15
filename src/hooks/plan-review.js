// PermissionRequest(ExitPlanMode): the blocking plan review hook.
//
//  1. find the plan text: tool_input.plan, else the file tool_input.planFilePath, else the newest
//     ExitPlanMode tool_use in the transcript (tool_input is {} when Claude wrote no plan file);
//  2. register the plan (new review, or a new revision of this session's open plan review),
//     first collecting Claude's answers after a deny round (`rd reply` writes them straight into the store;
//     <rd-reply> blocks in the transcript are the fallback);
//  3. ring claude's terminal, then poll meta.json once per second until the user approves or submits
//     feedback in the TUI, while also watching for the native dialog being answered without us;
//  4. answer with allow (+ updatedInput) or deny + the rendered feedback.
//
// Claude Code shows its own "Ready to code?" dialog at the same time and answering it does NOT stop
// this process, so the transcript tail (a tool_result for our ExitPlanMode tool_use, or a
// plan_mode_exit attachment) and the claude pid are watched too.
//
// Anything unexpected (bad input, closed review, claude gone, native answer, internal error) makes the
// hook exit silently, so Claude Code falls back to its own approval dialog. A plan is never
// auto-approved by accident.
import fs from 'node:fs';
import { listMetas, createReview, withReview, readRevision } from '../store/reviews.js';
import { appendRevision } from '../store/revisions.js';
import { listThreads, pendingThreads, replyToThread, addSystemMessage, isPendingAtRound } from '../store/threads.js';
import { readJson } from '../store/io.js';
import { paths } from '../store/paths.js';
import { getSession, isSessionId } from '../store/sessions.js';
import { findClaudeProcess, isSameProcessAlive, watcherAlive } from '../store/proc.js';
import { approveReview } from '../store/lifecycle.js';
import { nowIso } from '../store/time.js';
import { logLine } from '../store/log.js';
import { renderPlanDeny, parseRdReplies } from '../feedback/index.js';
import { assistantTextSince, denyMarker, findPendingExitPlan, ExitPlanWatcher } from '../feedback/transcript.js';
import { ringBell } from './bell.js';
import en from '../i18n/en.js';

/**
 * The note stored for a thread Claude did not answer one by one. The stored text is always English (it is shown to Claude in
 * resubmitted thread history, whatever the UI language); `kind` lets the TUI show it in the reader's language instead.
 */
export const UNANSWERED_KIND = 'unanswered';
export const UNANSWERED_NOTE = en.notes.unanswered;
const FINAL = new Set(['approved', 'closed']);
const BELL = '\u0007';
const MAX_PLAN_FILE_BYTES = 4 * 1024 * 1024;

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;

/** Plan text from the plan file Claude Code names in tool_input.planFilePath (null if unreadable/empty). */
function readPlanFile(file) {
  try {
    if (!hasText(file) || fs.statSync(file).size > MAX_PLAN_FILE_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    return hasText(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Where the plan text comes from, in order: tool_input.plan, the plan file, the newest unresolved
 * ExitPlanMode tool_use in the transcript (retried briefly, the transcript can lag).
 * Also returns where to start tailing the transcript and which tool_use is ours, if already known.
 */
async function resolvePlan(toolInput, transcriptPath, opts) {
  let plan = hasText(toolInput.plan) ? toolInput.plan : null;
  let source = plan ? 'tool_input' : null;
  if (!plan) {
    plan = readPlanFile(toolInput.planFilePath);
    if (plan) source = 'planFilePath';
  }
  const { pending, offset } = await findPendingExitPlan(transcriptPath, plan ? {} : { timeoutMs: opts.planTimeoutMs ?? 2000, needPlan: true });
  if (!plan && pending?.plan && hasText(pending.plan)) {
    plan = pending.plan;
    source = 'transcript';
  }
  return { plan, source, targetId: pending?.id ?? null, offset };
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Write the answers Claude gave after the last deny into the threads of that round.
 * Threads Claude did not answer get a system note (and stop being pending).
 */
async function recoverReplies(meta, transcriptPath, opts) {
  let d = meta.delivered;
  if (!d && meta.status === 'delivered') {
    // Status was set without the bookkeeping record: assume the whole current round.
    const threadIds = listThreads(meta.id)
      .filter((t) => isPendingAtRound(t, meta.round))
      .map((t) => t.id);
    d = { round: meta.round, threadIds };
  }
  if (!d) return;

  // Claude normally answered with `rd reply` (already in the store); the transcript is only consulted, and
  // waited for, when some thread of the round is still unanswered.
  const unanswered = () => listThreads(meta.id).filter((t) => (d.threadIds ?? []).includes(t.id) && isPendingAtRound(t, d.round));
  let replies = new Map();
  if (unanswered().length > 0) {
    const text = await assistantTextSince(transcriptPath, denyMarker(meta.id, d.round), {
      timeoutMs: opts.recoverTimeoutMs ?? 2000,
      intervalMs: opts.recoverIntervalMs ?? 100,
      ready: (r) => r.found && r.text.includes('</rd-reply>'),
    });
    replies = new Map(parseRdReplies(text).map((r) => [r.threadId, r.text]));
  }
  const threads = listThreads(meta.id);
  for (const tid of d.threadIds ?? []) {
    const t = threads.find((x) => x.id === tid);
    if (!t || !isPendingAtRound(t, d.round)) continue;
    try {
      if (replies.has(tid)) await replyToThread(meta.id, tid, replies.get(tid), { round: d.round });
      else await addSystemMessage(meta.id, tid, UNANSWERED_NOTE, { round: d.round, kind: UNANSWERED_KIND });
    } catch (err) {
      logLine('plan-review', err);
    }
  }
  await withReview(meta.id, (ctx) => {
    delete ctx.meta.delivered;
  });
}

/**
 * The user approved the plan while no hook was waiting (instant Q&A: Claude ended its turn behind a background
 * `rd await`, which told it to call ExitPlanMode again). That call must be allowed at once, without a new review.
 * Only the plan that was approved is let through: when Claude submits different text, the stale approval is
 * dropped and the call is reviewed like any new plan. Returns the hook result, or null.
 */
async function consumeApprovedExit(sid, toolInput) {
  const pending = listMetas().find((m) => m.kind === 'plan' && m.sessionId === sid && m.status === 'approved' && m.approvedPendingExit);
  if (!pending) return null;
  const approved = readRevision(pending.id, pending.currentRevision);
  const submitted = hasText(toolInput.plan) ? toolInput.plan : readPlanFile(toolInput.planFilePath);
  const same = !submitted || submitted.trim() === approved.trim();
  await withReview(pending.id, (ctx) => {
    delete ctx.meta.approvedPendingExit; // single use, whatever the outcome
    if (same) ctx.meta.exitedAt = nowIso();
  });
  if (!same) {
    logLine('plan-review', `plan submitted after approval of ${pending.id} differs from the approved revision; reviewing it as a new plan`);
    return null;
  }
  // Same updatedInput rule as a normal approval.
  const updatedInput = hasText(toolInput.plan) ? toolInput : { ...toolInput, plan: approved };
  const output = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput } } };
  return { outcome: 'approved', reviewId: pending.id, output, viaAwait: true };
}

/** Find this session's open plan review, or register the plan as a new one. */
async function registerPlan(input, plan, transcriptPath, opts) {
  const sid = input.session_id;
  const turn = getSession(sid)?.turn ?? 0;
  const existing = listMetas().find((m) => m.kind === 'plan' && m.sessionId === sid && !FINAL.has(m.status));
  if (!existing) {
    return createReview({ kind: 'plan', sessionId: sid, cwd: input.cwd, content: plan, source: 'ExitPlanMode', turn });
  }
  await recoverReplies(existing, transcriptPath, opts);
  await appendRevision(existing.id, plan, { source: 'ExitPlanMode', turn });
  return existing;
}

/**
 * Run the hook. Resolves with { outcome, reviewId, output }:
 *   outcome: approved | feedback            (output = the JSON object to print on stdout; `viaAwait` marks an
 *                                            approval the user gave while Claude was waiting in `rd await`)
 *            native-approved | native-rejected   (the Claude Code dialog was answered first; no output)
 *            closed | aborted | orphaned | vanished | superseded | skipped   (no output)
 *
 * @param {object} input  the hook's stdin JSON
 * @param {object} [opts] pollMs (default 1000), signal (AbortSignal), env, isClaudeAlive(),
 *                        claude ({pid, via, startTime}), bell (boolean, default config notify.bell),
 *                        ringBell(pid), planTimeoutMs / recoverTimeoutMs / recoverIntervalMs (transcript retry)
 */
export async function planReview(input, opts = {}) {
  const sid = input?.session_id;
  const toolInput = input?.tool_input;
  if (!isSessionId(sid) || !toolInput || typeof toolInput !== 'object') return { outcome: 'skipped' };
  const pollMs = opts.pollMs ?? 1000;
  const { signal } = opts;
  const transcriptPath = input.transcript_path ?? getSession(sid)?.transcriptPath;

  const early = await consumeApprovedExit(sid, toolInput);
  if (early) return early;

  const found = await resolvePlan(toolInput, transcriptPath, opts);
  const plan = found.plan;
  if (!plan) {
    logLine('plan-review', `no plan text (tool_input keys: ${Object.keys(toolInput).join(',') || 'none'}; transcript: ${transcriptPath ?? 'n/a'}); leaving it to Claude Code's dialog`, 'error');
    return { outcome: 'skipped' };
  }

  // The claude process that owns this hook: CLAUDE_PID first, /proc walk second.
  const claude = opts.claude ?? (opts.isClaudeAlive ? { pid: 0, via: 'none', startTime: null } : findClaudeProcess({ env: opts.env }));
  const initialPpid = process.ppid;
  const isClaudeAlive =
    opts.isClaudeAlive ?? (() => process.ppid === initialPpid && (claude.via === 'ppid' || isSameProcessAlive(claude)));
  const watcher = found.offset != null ? new ExitPlanWatcher(transcriptPath, { offset: found.offset, targetId: found.targetId }) : null;

  const registered = await registerPlan(input, plan, transcriptPath, opts);
  const id = registered.id;

  // One transaction: this plan is now waiting for the user, unless feedback was already queued
  // (hook killed after the user submitted, then Claude re-submitted: deliver it right away).
  await withReview(id, (ctx) => {
    ctx.meta.status = ctx.outbox.some((e) => !e.receivedAt) ? 'feedback_pending' : 'awaiting_review';
    ctx.meta.hook = { pid: process.pid, since: nowIso() };
  });

  const clearHookMarker = () =>
    withReview(id, (ctx) => {
      if (ctx.meta.hook?.pid === process.pid) delete ctx.meta.hook;
    }).catch(() => {});

  // Arrival bell straight to claude's terminal (terminalSequence only fires when the hook returns).
  const bellOn = opts.bell ?? (await import('../config.js')).loadConfig().notify?.bell !== false;
  if (bellOn && claude.via !== 'ppid' && claude.via !== 'none') (opts.ringBell ?? ringBell)(claude.pid);

  // The native dialog accepts our updatedInput only if it is a real input; {} would approve, but without
  // the approved plan text in Claude's context (checked at runtime), so a missing plan is filled in.
  const updatedInput = hasText(toolInput.plan) ? toolInput : { ...toolInput, plan };

  let readErrors = 0;
  for (;;) {
    if (signal?.aborted) {
      await clearHookMarker();
      return { outcome: 'aborted', reviewId: id };
    }

    let meta;
    try {
      meta = readJson(paths.meta(id), null);
      readErrors = 0;
    } catch (err) {
      if (++readErrors > 10) throw err;
    }
    if (meta === null) return { outcome: 'vanished', reviewId: id };

    // A newer hook process for the same review (Claude Code abandoned us but we survived, e.g.
    // after an interrupt) owns the review now. Stand down so feedback is not consumed twice.
    if (meta?.hook && meta.hook.pid !== process.pid) return { outcome: 'superseded', reviewId: id };

    if (meta?.status === 'approved') {
      await clearHookMarker();
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput },
        },
        terminalSequence: BELL,
      };
      return { outcome: 'approved', reviewId: id, output };
    }

    if (meta?.status === 'closed') {
      await clearHookMarker();
      return { outcome: 'closed', reviewId: id };
    }

    if (meta?.status === 'feedback_pending') {
      // With the wake-up watcher running, Claude is told to end its turn after answering instead of starting `rd await`.
      const auto = watcherAlive(getSession(sid));
      // Re-check under the lock: the user may have changed the review since the poll.
      const message = await withReview(id, (ctx) => {
        if (ctx.meta.status !== 'feedback_pending') return null;
        const text = renderPlanDeny(ctx.meta, ctx.threads, { auto });
        ctx.meta.status = 'delivered';
        ctx.meta.delivered = {
          round: ctx.meta.round,
          threadIds: pendingThreads(ctx.threads).map((t) => t.id),
          at: nowIso(),
        };
        delete ctx.meta.hook;
        ctx.outbox = [];
        return text;
      });
      if (message !== null) {
        const output = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message },
          },
          terminalSequence: BELL,
        };
        return { outcome: 'feedback', reviewId: id, output };
      }
    }

    // The user answered Claude Code's own dialog: our decision would be ignored, so stand down.
    const native = watcher?.check();
    if (native) {
      if (native.kind === 'approved') {
        await approveReview(id, { via: 'native' });
        await clearHookMarker();
        return { outcome: 'native-approved', reviewId: id, native };
      }
      await clearHookMarker(); // rejected: the review and its threads stay as they are
      return { outcome: 'native-rejected', reviewId: id, native };
    }

    if (!isClaudeAlive()) {
      // Claude is gone (SSH drop, kill -9): do not linger as an orphan. The review stays awaiting_review.
      await clearHookMarker();
      return { outcome: 'orphaned', reviewId: id };
    }
    await sleep(pollMs, signal);
  }
}

export default async function handle(input, deps) {
  return (await planReview(input, deps)).output;
}
