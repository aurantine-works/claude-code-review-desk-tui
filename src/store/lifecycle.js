// Review lifecycle transitions used by the TUI (and `rd close`).
import { withReview, getMeta } from './reviews.js';
import { assertReviewId } from './ids.js';
import { readSessionReviews } from './outbox.js';
import { awaitingAlive } from './proc.js';
import { clearActiveReview } from './docsIndex.js';
import { isPidAlive, getSession } from './sessions.js';
import { nowIso } from './time.js';

const FINAL = new Set(['approved', 'closed']);

/** Drop the docs-index entry of a doc review (after the review transaction has committed). */
async function releaseDoc(meta) {
  if (meta.kind === 'doc' && meta.docPath) await clearActiveReview(meta.docPath, meta.id);
}

/**
 * The user approves the review.
 *  - plan: status=approved (the blocked plan-review hook then returns allow). When no hook is waiting
 *          (instant Q&A: Claude ended its turn behind a background `rd await`) `meta.approvedPendingExit`
 *          is set: `rd await` tells Claude to call ExitPlanMode again and the plan-review hook then
 *          allows that call straight away instead of opening a new review.
 *  - doc:  status=closed and the docs-index entry is cleared
 * Unsent outbox entries are discarded. Idempotent for finished reviews.
 * `opts.via` is recorded as `meta.approvedVia` ('native' = approved in Claude Code's own dialog).
 */
export async function approveReview(id, opts = {}) {
  const meta = await withReview(id, (ctx) => {
    if (FINAL.has(ctx.meta.status)) return ctx.meta;
    ctx.meta.status = ctx.meta.kind === 'plan' ? 'approved' : 'closed';
    if (opts.via) ctx.meta.approvedVia = opts.via;
    if (ctx.meta.kind === 'plan' && opts.via !== 'native' && !(ctx.meta.hook && isPidAlive(ctx.meta.hook.pid))) {
      ctx.meta.approvedPendingExit = true;
    }
    ctx.outbox = [];
    return ctx.meta;
  });
  await releaseDoc(meta);
  return meta;
}

/**
 * `E` in the TUI: end instant Q&A for the whole session this review belongs to. `rd await` is one process per
 * session, so ending only one review would leave the wait running whenever the session has another open review.
 * Every unfinished review of the session (just this one when it has no sessionId) gets `meta.instant.endedAt`; a
 * waiting `rd await` then prints `end` within its poll interval (an `rd await --review <id>` of one of them too).
 * The reviews themselves stay open (feedback can still be sent, it just no longer loops). Sending a new message
 * clears the end of THAT review only (addThread / replies). Idempotent; finished reviews are left alone.
 *
 * @param {string} id the review `E` was pressed in
 * @returns {Promise<{ended: string[], awaitingAlive: boolean}>}
 *   ended: ids whose Q&A was ended by this call (already ended / finished ones are not listed, so a repeated
 *   call returns []); awaitingAlive: a live `rd await` of the session is covered by those reviews and will
 *   exit on its own (the TUI says "exits within a second" only then).
 */
export async function endInstant(id) {
  const meta = getMeta(assertReviewId(id));
  if (FINAL.has(meta.status)) return { ended: [], awaitingAlive: false };

  const siblings = meta.sessionId ? readSessionReviews(meta.sessionId).map((r) => r.meta.id) : [];
  const covered = [id, ...siblings.filter((sid) => sid !== id)];
  const at = nowIso();
  const ended = [];
  for (const rid of covered) {
    try {
      const changed = await withReview(rid, (ctx) => {
        if (FINAL.has(ctx.meta.status) || ctx.meta.instant?.endedAt) return false;
        ctx.meta.instant = { endedAt: at };
        return true;
      });
      if (changed) ended.push(rid);
    } catch (err) {
      if (rid === id) throw err; // a sibling that vanished meanwhile does not matter
    }
  }

  const session = meta.sessionId ? getSession(meta.sessionId) : null;
  const a = session?.awaiting;
  const alive = !!a && awaitingAlive(session) && (a.reviewId == null || covered.includes(a.reviewId));
  return { ended, awaitingAlive: alive };
}

/**
 * The user closes the review without approving (plan: the blocked hook exits
 * silently so Claude Code falls back to its own approval dialog).
 */
export async function closeReview(id) {
  const meta = await withReview(id, (ctx) => {
    if (ctx.meta.status === 'closed') return ctx.meta;
    if (ctx.meta.status === 'approved') return ctx.meta;
    ctx.meta.status = 'closed';
    ctx.outbox = [];
    return ctx.meta;
  });
  await releaseDoc(meta);
  return meta;
}

/**
 * Opening a review in the TUI. Only an untouched review (awaiting_review) or
 * one with fresh answers moves to in_review; every other status is left alone.
 * Returns true if the status changed.
 */
export const markInReview = (id) =>
  withReview(id, (ctx) => {
    if (ctx.meta.status !== 'awaiting_review' && ctx.meta.status !== 'answered') return false;
    ctx.meta.status = 'in_review';
    return true;
  });
