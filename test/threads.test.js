import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { useTempHome } from './helpers/env.js';
import { createReview, getMeta, readRevision } from '../src/store/reviews.js';
import { appendRevision } from '../src/store/revisions.js';
import { addThread, addUserMessage, sendDrafts, replyToThread, completeRound, listThreads, deleteDraft, setThreadStatus, pendingThreads } from '../src/store/threads.js';
import { makeAnchor } from '../src/anchor/index.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';

useTempHome();
const content = ['# Title', '', 'Risk is low.', 'Takes two weeks.'].join('\n');
const mk = () => createReview({ kind: 'doc', docPath: '/x/a.md', sessionId: 's1', cwd: '/x', content, source: 'Write', turn: 1 });
const anchor = (l) => makeAnchor(content, { startLine: l, endLine: l }, 1);

describe('review lifecycle', () => {
  it('creates files and derives the title from the first H1', async () => {
    const m = await mk();
    expect(m.title).toBe('Title');
    expect(readRevision(m.id, 1)).toBe(content);
    expect(getMeta(m.id)).toMatchObject({ status: 'awaiting_review', round: 0, currentRevision: 1 });
  });

  it('drafts are not pending until sent; sending queues the outbox and starts round 1', async () => {
    const { id } = await mk();
    const t = await addThread(id, { anchor: anchor(3), text: 'why?' });
    expect(t.messages[0].state).toBe('draft');
    expect(pendingThreads(listThreads(id))).toHaveLength(0);
    expect(await sendDrafts(id)).toBe(1);
    const meta = getMeta(id);
    expect(meta).toMatchObject({ status: 'feedback_pending', round: 1 });
    expect(readJson(paths.outbox(id))).toHaveLength(1);
    expect(pendingThreads(listThreads(id))).toHaveLength(1);
  });

  it('reply requires a pending sent message, then done clears the outbox', async () => {
    const { id } = await mk();
    const t = await addThread(id, { anchor: anchor(3), text: 'why?' });
    await expect(replyToThread(id, t.id, 'x')).rejects.toThrow(/no pending/);
    await sendDrafts(id);
    await expect(replyToThread(id, 't99', 'x')).rejects.toThrow(/not found/);
    await replyToThread(id, t.id, 'because');
    expect(listThreads(id)[0].status).toBe('answered');
    await expect(replyToThread(id, t.id, 'again')).rejects.toThrow(/no pending/);
    const r = await completeRound(id);
    expect(r.unanswered).toEqual([]);
    expect(getMeta(id).status).toBe('answered');
    expect(readJson(paths.outbox(id))).toEqual([]);
  });

  it('done reports threads that were never answered; their entries stay queued for the next delivery', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q1', send: true });
    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    await replyToThread(id, 't1', 'a1');
    const r = await completeRound(id);
    expect(r.unanswered).toEqual(['t2']);
    // t1 is answered and leaves the outbox; t2 was never answered, so it is still waiting to be delivered
    expect(readJson(paths.outbox(id)).map((e) => e.threadId)).toEqual(['t2']);
    expect(getMeta(id).status).toBe('feedback_pending');
  });

  it('follow-ups start round 2 and reopen the thread', async () => {
    const { id } = await mk();
    const t = await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await replyToThread(id, t.id, 'a');
    await completeRound(id);
    await addUserMessage(id, t.id, { text: 'follow up', send: true });
    expect(getMeta(id).round).toBe(2);
    const th = listThreads(id)[0];
    expect(th.status).toBe('open');
    expect(th.messages.map((m) => [m.author, m.round])).toEqual([['user', 1], ['claude', 1], ['user', 2]]);
  });

  it('only drafts can be deleted; empty threads vanish', async () => {
    const { id } = await mk();
    const t = await addThread(id, { anchor: anchor(3), text: 'q' });
    await deleteDraft(id, t.id, 'm1');
    expect(listThreads(id)).toEqual([]);
    const t2 = await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await expect(deleteDraft(id, t2.id, t2.messages[0].id)).rejects.toThrow(/drafts/);
  });

  it('resolving removes a thread from the pending set', async () => {
    const { id } = await mk();
    const t = await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await setThreadStatus(id, t.id, 'resolved');
    expect(pendingThreads(listThreads(id))).toHaveLength(0);
  });
});

describe('revisions', () => {
  it('adds a revision, re-anchors threads and resets status', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await replyToThread(id, 't1', 'a');
    await completeRound(id);
    const r = await appendRevision(id, ['# Title', 'new para', '', 'Risk is low.', 'Takes two weeks.'].join('\n'), { source: 'Edit', turn: 2 });
    expect(r).toMatchObject({ n: 2, changed: true, merged: false });
    expect(listThreads(id)[0].anchor).toMatchObject({ revision: 2, startLine: 4 });
    expect(getMeta(id)).toMatchObject({ currentRevision: 2, status: 'awaiting_review' });
  });
  it('is a no-op for identical content and merges writes within a turn', async () => {
    const { id } = await mk();
    expect(await appendRevision(id, content, { source: 'Write', turn: 1 })).toMatchObject({ changed: false });
    const r = await appendRevision(id, content + '\nmore', { source: 'Edit', turn: 1 });
    expect(r).toMatchObject({ n: 1, merged: true });
    expect(getMeta(id).revisions).toHaveLength(1);
    expect(readRevision(id, 1)).toBe(content + '\nmore');
  });
});

describe('concurrency', () => {
  it('does not lose writes from parallel processes', async () => {
    const { id } = await mk();
    const run = (n) =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [path.resolve('test/helpers/add-thread.mjs'), id, String(n)], { stdio: 'inherit', env: process.env });
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child ${n} exited ${c}`))));
      });
    await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
    const threads = listThreads(id);
    expect(threads).toHaveLength(8);
    expect(new Set(threads.map((t) => t.id)).size).toBe(8);
    expect(readJson(paths.outbox(id))).toHaveLength(8);
  });
});
