// Thread / message operations. All mutations run inside withReview().
import { readJson } from './io.js';
import { paths } from './paths.js';
import { withReview } from './reviews.js';
import { assertThreadId } from './ids.js';
import { nowIso } from './time.js';

/** Index of the last message written by claude or the system (anything but the user), or -1. */
const lastResponder = (t) => {
  for (let i = t.messages.length - 1; i >= 0; i--) if (t.messages[i].author !== 'user') return i;
  return -1;
};

/**
 * A thread is pending when a sent user message has no claude/system reply after
 * it. (A system note such as "Claude did not answer this thread" closes the
 * pending state so the thread is not re-sent to Claude by accident.)
 */
export function isPending(t) {
  if (t.status === 'resolved') return false;
  const from = lastResponder(t) + 1;
  return t.messages.slice(from).some((m) => m.author === 'user' && m.state === 'sent');
}

/**
 * Ids of messages the user queued AFTER the last delivery: outbox entries nobody has received yet, while
 * at least one other entry was already received (delivered to Claude, which is now answering). An outbox
 * without any received entry (feedback read through plain `rd show`, or the M1 batch flow) has no such
 * messages: everything in it is readable and answerable.
 */
export function queuedIds(outbox) {
  if (!outbox.some((e) => e.receivedAt)) return new Set();
  return new Set(outbox.filter((e) => !e.receivedAt).map((e) => e.messageId));
}

/**
 * Where a reply goes: right after the last sent user message that Claude can answer, so messages the user
 * sent later stay pending. `round` (plan transcript recovery / a delivered plan round) limits it to messages
 * from that round or earlier; `queued` (see queuedIds) excludes messages Claude has not been given yet.
 * Without either, the reply is appended behind the last user message (the `rd reply` path).
 * Returns -1 when nothing is waiting.
 */
function replyPosition(t, round, queued) {
  if (t.status === 'resolved') return -1;
  let last = -1;
  t.messages.forEach((m, i) => {
    if (m.author !== 'user' || m.state !== 'sent') return;
    if (round != null && (m.round ?? 0) > round) return;
    if (queued?.has(m.id)) return;
    last = i;
  });
  if (last === -1) return -1;
  const next = t.messages[last + 1];
  return next && next.author !== 'user' ? -1 : last + 1;
}

/** True if the thread has a sent user message from `round` or earlier that nobody answered. */
export const isPendingAtRound = (t, round) => replyPosition(t, round) !== -1;

export const pendingThreads = (threads) => threads.filter(isPending);

export function listThreads(id) {
  return readJson(paths.threads(id), []);
}

const nextNum = (items, prefix) =>
  items.reduce((max, x) => Math.max(max, Number(String(x.id).slice(prefix.length)) || 0), 0) + 1;

const allMessages = (threads) => threads.flatMap((t) => t.messages);

function findThread(ctx, threadId) {
  assertThreadId(threadId);
  const t = ctx.threads.find((x) => x.id === threadId);
  if (!t) throw new Error(`thread not found: ${threadId}`);
  return t;
}

/**
 * Move a draft to sent and queue it. A new round (= one batch of feedback delivered together) starts when
 * nothing is waiting for delivery: entries that were already received do not count, so a message sent while
 * Claude answers the previous batch belongs to the next round. Sending also re-enters instant mode.
 */
function enqueue(ctx, thread, message) {
  if (!ctx.outbox.some((e) => !e.receivedAt)) ctx.meta.round += 1;
  const at = nowIso();
  message.state = 'sent';
  message.round = ctx.meta.round;
  message.sentAt = at;
  ctx.outbox.push({ threadId: thread.id, messageId: message.id, at });
  thread.status = 'open';
  ctx.meta.status = 'feedback_pending';
  delete ctx.meta.instant; // the user ended instant mode with `E`; a new message starts the conversation again
}

function newMessage(ctx, { author, text, revision, state, kind }) {
  return {
    id: `m${nextNum(allMessages(ctx.threads), 'm')}`,
    author,
    text,
    at: nowIso(),
    revision: revision ?? ctx.meta.currentRevision,
    ...(state ? { state } : {}),
    ...(kind ? { kind } : {}),
  };
}

function checkAnchor(a) {
  if (!a || !(a.startLine >= 1) || !(a.endLine >= a.startLine)) throw new Error('invalid anchor');
}

/** Create a thread with its first user message (draft unless send=true). */
export const addThread = (id, { anchor, text, send = false }) =>
  withReview(id, (ctx) => {
    checkAnchor(anchor);
    if (!text || !text.trim()) throw new Error('empty comment');
    const msg = newMessage(ctx, { author: 'user', text, state: 'draft', revision: anchor.revision });
    const thread = { id: `t${nextNum(ctx.threads, 't')}`, status: 'open', anchor, messages: [msg] };
    ctx.threads.push(thread);
    if (send) enqueue(ctx, thread, msg);
    return thread;
  });

/** Add a user follow-up (draft unless send=true). */
export const addUserMessage = (id, threadId, { text, send = false }) =>
  withReview(id, (ctx) => {
    const t = findThread(ctx, threadId);
    if (!text || !text.trim()) throw new Error('empty message');
    const msg = newMessage(ctx, { author: 'user', text, state: 'draft' });
    t.messages.push(msg);
    if (t.status === 'resolved') t.status = 'open';
    if (send) enqueue(ctx, t, msg);
    return msg;
  });

/** Send every draft of the review (batch submit). Returns the number sent. */
export const sendDrafts = (id) =>
  withReview(id, (ctx) => {
    let n = 0;
    for (const t of ctx.threads) {
      for (const m of t.messages) {
        if (m.author === 'user' && m.state === 'draft') {
          enqueue(ctx, t, m);
          n++;
        }
      }
    }
    return n;
  });

/**
 * Claude's answer. Requires a pending sent user message on the thread.
 * `opts.round` answers a specific (older) round, see replyPosition().
 */
export const replyToThread = (id, threadId, text, opts = {}) =>
  withReview(id, (ctx) => {
    const t = findThread(ctx, threadId);
    if (!text || !text.trim()) throw new Error('empty reply');
    const at = replyPosition(t, opts.round, queuedIds(ctx.outbox));
    if (at === -1) throw new Error(`thread ${threadId} has no pending user message in this round`);
    const msg = newMessage(ctx, { author: 'claude', text: text.trim() });
    // The answer belongs to the round of the message it answers (a newer message may already have started the next round).
    msg.round = opts.round ?? t.messages[at - 1]?.round ?? ctx.meta.round;
    t.messages.splice(at, 0, msg);
    // A later round may still be waiting for its own answer.
    t.status = isPending(t) ? 'open' : 'answered';
    // Everything handed to Claude is answered: the review reads as answered without `rd done` (plan reviews never call it).
    if (ctx.meta.status === 'delivered' && pendingThreads(ctx.threads).length === 0) ctx.meta.status = 'answered';
    return msg;
  });

/**
 * System note (e.g. "Claude did not answer this thread individually"). It
 * counts as a response, so the thread stops being pending.
 */
export const addSystemMessage = (id, threadId, text, opts = {}) =>
  withReview(id, (ctx) => {
    const t = findThread(ctx, threadId);
    const at = opts.round == null ? t.messages.length : replyPosition(t, opts.round);
    const msg = newMessage(ctx, { author: 'system', text, kind: opts.kind });
    msg.round = opts.round ?? ctx.meta.round;
    t.messages.splice(at === -1 ? t.messages.length : at, 0, msg);
    return msg;
  });

export const setThreadStatus = (id, threadId, status) =>
  withReview(id, (ctx) => {
    if (!['open', 'answered', 'resolved'].includes(status)) throw new Error(`invalid status: ${status}`);
    const t = findThread(ctx, threadId);
    t.status = status;
    if (status === 'resolved') withdrawQueued(ctx, t);
    return t;
  });

/**
 * The user resolved a thread: a message of it that Claude has not received yet is withdrawn from the outbox. Otherwise the
 * next delivery (or the waiting `rd await`) would wake Claude with feedback that no longer contains the thread. When nothing
 * else is queued the review is no longer `feedback_pending`: `delivered` while Claude still answers a received batch,
 * otherwise `in_review` (the user is in the middle of the review). Received entries are left to `rd done`.
 */
function withdrawQueued(ctx, thread) {
  const kept = ctx.outbox.filter((e) => e.receivedAt || e.threadId !== thread.id);
  if (kept.length === ctx.outbox.length) return;
  ctx.outbox = kept;
  if (ctx.meta.status === 'feedback_pending' && !kept.some((e) => !e.receivedAt)) {
    ctx.meta.status = kept.length > 0 ? 'delivered' : 'in_review';
  }
}

/** Delete a not-yet-sent draft; removes the thread when it becomes empty. */
export const deleteDraft = (id, threadId, messageId) =>
  withReview(id, (ctx) => {
    const t = findThread(ctx, threadId);
    const i = t.messages.findIndex((m) => m.id === messageId);
    if (i === -1) throw new Error(`message not found: ${messageId}`);
    if (t.messages[i].state !== 'draft') throw new Error('only drafts can be deleted');
    t.messages.splice(i, 1);
    if (t.messages.length === 0) ctx.threads.splice(ctx.threads.indexOf(t), 1);
    return true;
  });

/**
 * `rd done`: finish the round Claude just answered.
 *  - received entries (Claude has them) and entries whose message got an answer leave the outbox;
 *  - entries nobody received yet and that still wait for an answer stay: they were queued while Claude
 *    was answering (or never delivered) and go out with the next delivery;
 *  - status: `feedback_pending` while something is still queued, `answered` otherwise.
 * Threads that were handed to Claude but not answered are returned so the caller can warn;
 * the round is completed regardless.
 */
export const completeRound = (id) =>
  withReview(id, (ctx) => {
    const queued = queuedIds(ctx.outbox);
    const unanswered = ctx.threads.filter((t) => isPending(t) && replyPosition(t, undefined, queued) !== -1).map((t) => t.id);
    const waiting = new Set(pendingMessageIds(ctx.threads));
    ctx.outbox = ctx.outbox.filter((e) => !e.receivedAt && waiting.has(e.messageId));
    ctx.meta.status = ctx.outbox.length > 0 ? 'feedback_pending' : 'answered';
    return { unanswered, answered: ctx.threads.filter((t) => t.status === 'answered').length };
  });

/** Ids of sent user messages that no claude/system message follows (inside their thread). */
function pendingMessageIds(threads) {
  const ids = [];
  for (const t of threads) {
    if (t.status === 'resolved') continue;
    for (let i = lastResponder(t) + 1; i < t.messages.length; i++) {
      const m = t.messages[i];
      if (m.author === 'user' && m.state === 'sent') ids.push(m.id);
    }
  }
  return ids;
}

/** Batch mode "submit" (the TUI's `s` key). */
export const submitBatch = sendDrafts;
