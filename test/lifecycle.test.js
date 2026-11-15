import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { createReview, getMeta } from '../src/store/reviews.js';
import { approveReview, closeReview, markInReview } from '../src/store/lifecycle.js';
import { setActiveReview, getActiveReview } from '../src/store/docsIndex.js';
import {
  addThread, addUserMessage, sendDrafts, submitBatch, replyToThread, addSystemMessage, listThreads, pendingThreads, isPendingAtRound,
} from '../src/store/threads.js';
import { makeAnchor } from '../src/anchor/index.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';

useTempHome();
const content = ['# T', 'one', 'two', 'three'].join('\n');
const anchor = (l) => makeAnchor(content, { startLine: l, endLine: l }, 1);
const plan = () => createReview({ kind: 'plan', sessionId: 's', cwd: '/x', content, source: 'ExitPlanMode' });
const doc = () => createReview({ kind: 'doc', docPath: '/x/a.md', sessionId: 's', cwd: '/x', content, source: 'Write' });

describe('review lifecycle', () => {
  it('approveReview: plan -> approved, outbox dropped', async () => {
    const { id } = await plan();
    await addThread(id, { anchor: anchor(2), text: 'q', send: true });
    expect((await approveReview(id)).status).toBe('approved');
    expect(getMeta(id).status).toBe('approved');
    expect(readJson(paths.outbox(id))).toEqual([]);
    await approveReview(id); // idempotent
    expect(getMeta(id).status).toBe('approved');
  });

  it('approveReview: doc -> closed and the docs-index entry is cleared (only if it still points here)', async () => {
    const { id } = await doc();
    await setActiveReview('/x/a.md', id);
    await approveReview(id);
    expect(getMeta(id).status).toBe('closed');
    expect(getActiveReview('/x/a.md')).toBeNull();

    const other = await doc();
    await setActiveReview('/x/a.md', other.id); // a newer review owns the path now
    await closeReview(id);
    expect(getActiveReview('/x/a.md')).toBe(other.id);
  });

  it('closeReview closes a doc review, clears the index, and never downgrades an approved plan', async () => {
    const d = await doc();
    await setActiveReview('/x/a.md', d.id);
    await closeReview(d.id);
    expect(getMeta(d.id).status).toBe('closed');
    expect(getActiveReview('/x/a.md')).toBeNull();
    const p = await plan();
    await approveReview(p.id);
    await closeReview(p.id);
    expect(getMeta(p.id).status).toBe('approved');
  });

  it('markInReview only moves awaiting_review / answered', async () => {
    const { id } = await plan();
    expect(await markInReview(id)).toBe(true);
    expect(getMeta(id).status).toBe('in_review');
    expect(await markInReview(id)).toBe(false);
    await addThread(id, { anchor: anchor(2), text: 'q', send: true }); // -> feedback_pending
    expect(await markInReview(id)).toBe(false);
    expect(getMeta(id).status).toBe('feedback_pending');
  });

  it('submitBatch is sendDrafts', async () => {
    expect(submitBatch).toBe(sendDrafts);
  });

  it('rejects hostile ids', async () => {
    await expect(approveReview('../x')).rejects.toThrow(/invalid review id/);
  });
});

describe('round-aware replies', () => {
  it('a system note closes the pending state', async () => {
    const { id } = await plan();
    await addThread(id, { anchor: anchor(2), text: 'q', send: true });
    await addSystemMessage(id, 't1', 'Claude did not answer this one separately');
    expect(pendingThreads(listThreads(id))).toHaveLength(0);
  });

  it('`rd reply` on a delivered plan answers the delivered round even if the user already queued a follow-up', async () => {
    const { id } = await plan();
    await addThread(id, { anchor: anchor(2), text: 'first', send: true }); // round 1
    const { withReview } = await import('../src/store/reviews.js');
    await withReview(id, (ctx) => {
      ctx.outbox = []; // the hook delivered round 1 with its deny
      ctx.meta.status = 'delivered';
      ctx.meta.delivered = { round: 1, threadIds: ['t1'], at: 'x' };
    });
    await addUserMessage(id, 't1', { text: 'second', send: true }); // round 2, typed while Claude answers
    const { reply } = await import('../src/cli/commands.js');
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await reply(id, 't1', 'answer to the first');
    } finally {
      spy.mockRestore();
    }
    const t = listThreads(id)[0];
    expect(t.messages.map((m) => [m.author, m.text, m.round])).toEqual([['user', 'first', 1], ['claude', 'answer to the first', 1], ['user', 'second', 2]]);
    expect(pendingThreads([t])).toHaveLength(1); // the follow-up is still unanswered
  });

  it('reply with a round lands before later user messages and keeps the thread open', async () => {
    const { id } = await plan();
    await addThread(id, { anchor: anchor(2), text: 'first', send: true }); // round 1
    await sendDrafts(id);
    // pretend feedback was delivered: outbox cleared by the hook
    const { withReview } = await import('../src/store/reviews.js');
    await withReview(id, (ctx) => {
      ctx.outbox = [];
    });
    await addUserMessage(id, 't1', { text: 'second', send: true }); // round 2
    expect(isPendingAtRound(listThreads(id)[0], 1)).toBe(true);
    await replyToThread(id, 't1', 'answer one', { round: 1 });
    const t = listThreads(id)[0];
    expect(t.messages.map((m) => [m.author, m.text])).toEqual([['user', 'first'], ['claude', 'answer one'], ['user', 'second']]);
    expect(t.status).toBe('open');
    expect(isPendingAtRound(t, 1)).toBe(false);
    expect(pendingThreads([t])).toHaveLength(1); // round 2 still waits
    await expect(replyToThread(id, 't1', 'again', { round: 1 })).rejects.toThrow(/no pending/);
    await replyToThread(id, 't1', 'answer two'); // plain `rd reply`
    expect(listThreads(id)[0].status).toBe('answered');
  });
});
