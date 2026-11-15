// Delivery bookkeeping on the per-review outbox (outbox.json).
//
// An entry is { threadId, messageId, at } when the user sends a message and gains, as it travels:
//   receivedAt, deliveredVia  Claude was handed the feedback: 'await' | 'watch' (the wake-up watcher) | 'A' (next prompt) | 'B' (Stop hook) | 'hook' (plan deny)
//   injectedAt                an auto-injection (`/review-reply <id>`) was typed into the session's terminal for it
// Entries stay in the outbox until `rd done` (or an approve / close / plan deny) removes them; the ones
// with `receivedAt` are "Claude is answering this".
import { readJson } from './io.js';
import { paths } from './paths.js';
import { withReview } from './reviews.js';
import { REVIEW_ID_RE } from './ids.js';
import { nowIso } from './time.js';
import { isPidAlive } from './sessions.js';
import fs from 'node:fs';

const FINAL = new Set(['approved', 'closed']);

export const isFinalStatus = (status) => FINAL.has(status);
export const unreceived = (outbox) => outbox.filter((e) => !e.receivedAt);

/** Is a plan-review hook blocking on this review? It delivers feedback itself (the deny message), so the other channels leave it alone. */
export const planHookAlive = (meta) => meta.kind === 'plan' && !!meta.hook && isPidAlive(meta.hook.pid);

/**
 * Reviews (meta + raw outbox, read without locking) of a session that are not finished. Oldest first.
 * `pendingExit`: also the approved plan reviews whose approval nobody has acted on yet (`meta.approvedPendingExit`, set when
 * the user approved while no hook was blocking; the watcher tells Claude to call ExitPlanMode again). Their outbox is empty.
 */
export function readSessionReviews(sessionId, { pendingExit = false } = {}) {
  let names;
  try {
    names = fs.readdirSync(paths.reviewsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!REVIEW_ID_RE.test(name)) continue;
    try {
      const meta = readJson(paths.meta(name), null);
      if (!meta || meta.sessionId !== sessionId) continue;
      if (FINAL.has(meta.status)) {
        if (pendingExit && meta.kind === 'plan' && meta.status === 'approved' && meta.approvedPendingExit) out.push({ meta, outbox: [] });
        continue;
      }
      out.push({ meta, outbox: readJson(paths.outbox(name), []) });
    } catch {
      /* half-written or foreign directory */
    }
  }
  return out.sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? -1 : 1));
}

/**
 * Reviews of the session with feedback nobody has received, earliest first (by the oldest waiting entry).
 * Plan reviews whose hook is waiting are left out when `skip(meta)` says so (the hook delivers those).
 */
export function reviewsWithUnreceived(sessionId, { skip } = {}) {
  return readSessionReviews(sessionId)
    .filter((r) => !skip?.(r.meta))
    .map((r) => ({ ...r, waiting: unreceived(r.outbox) }))
    .filter((r) => r.waiting.length > 0)
    .sort((a, b) => (a.waiting[0].at < b.waiting[0].at ? -1 : 1));
}

/**
 * Hand all unreceived entries of a review to Claude: mark them received, set status `delivered`.
 * Runs in one transaction and returns a snapshot taken inside it, or null when nothing was waiting
 * (somebody else delivered first, or the review is finished). Delivery channels race through this
 * function, so each message is delivered exactly once.
 * @param {string} id
 * @param {{via: string, injected?: boolean, now?: string}} opts
 */
export function takeUnreceived(id, { via, injected = false, now = nowIso() }) {
  return withReview(id, (ctx) => {
    if (FINAL.has(ctx.meta.status)) return null;
    const entries = unreceived(ctx.outbox);
    if (entries.length === 0) return null;
    for (const e of entries) {
      e.receivedAt = now;
      e.deliveredVia = via;
      if (injected) e.injectedAt = now;
    }
    ctx.meta.status = 'delivered';
    delete ctx.meta.delivered; // rd-reply bookkeeping of an older plan deny; replies now follow the outbox
    return { meta: structuredClone(ctx.meta), threads: structuredClone(ctx.threads), entries: structuredClone(entries) };
  });
}

/**
 * Claim the right to type `/review-reply <id>` into the session's terminal: marks the waiting entries `injectedAt`
 * unless one of them was claimed less than `staleMs` ago (another deliver() call, possibly in another process,
 * is typing it or just did). Claiming BEFORE typing keeps a burst of sent messages from typing the command
 * several times. Returns true when the caller may type. `releaseInjection` undoes it after a failed attempt.
 */
export function claimInjection(id, { now = Date.now(), staleMs = 60_000 } = {}) {
  return withReview(id, (ctx) => {
    const waiting = unreceived(ctx.outbox);
    if (waiting.length === 0) return false;
    if (waiting.some((e) => e.injectedAt && now - Date.parse(e.injectedAt) < staleMs)) return false;
    const at = new Date(now).toISOString();
    for (const e of waiting) e.injectedAt = at;
    return true;
  });
}

export function releaseInjection(id) {
  return withReview(id, (ctx) => {
    for (const e of ctx.outbox) if (!e.receivedAt) delete e.injectedAt;
  });
}

/** Record that `/review-reply <id>` was typed into the terminal for the review's waiting entries. */
export function markInjected(id, now = nowIso()) {
  return withReview(id, (ctx) => {
    let n = 0;
    for (const e of ctx.outbox) {
      if (!e.receivedAt) {
        e.injectedAt = now;
        n++;
      }
    }
    return n;
  });
}
