import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { createReview, getMeta, listMetas, withReview, readRevision } from '../src/store/reviews.js';
import { addThread, addUserMessage, listThreads, replyToThread, completeRound, pendingThreads, queuedIds } from '../src/store/threads.js';
import { appendRevision } from '../src/store/revisions.js';
import { approveReview, closeReview, endInstant } from '../src/store/lifecycle.js';
import { takeUnreceived, markInjected, readSessionReviews, reviewsWithUnreceived, unreceived } from '../src/store/outbox.js';
import { registerDocWrite } from '../src/store/docs.js';
import { getActiveReview } from '../src/store/docsIndex.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';
import { updateSession } from '../src/store/sessions.js';
import { readProc } from '../src/store/proc.js';

useTempHome();
const content = ['# Title', '', 'Risk is low.', 'Takes two weeks.'].join('\n');
const anchor = (line) => makeAnchor(content, { startLine: line, endLine: line }, 1);
const mk = (over = {}) => createReview({ kind: 'doc', docPath: '/x/a.md', sessionId: 's1', cwd: '/x', content, source: 'Write', turn: 1, ...over });
const outbox = (id) => readJson(paths.outbox(id), []);

describe('takeUnreceived', () => {
  it('marks every waiting entry received once, sets status delivered and returns a snapshot', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q1', send: true });
    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    const t = await takeUnreceived(id, { via: 'await', now: '2026-11-11T10:00:00.000Z' });
    expect(t.entries.map((e) => e.threadId)).toEqual(['t1', 't2']);
    expect(t.meta.status).toBe('delivered');
    expect(t.threads).toHaveLength(2);
    expect(outbox(id).every((e) => e.receivedAt === '2026-11-11T10:00:00.000Z' && e.deliveredVia === 'await')).toBe(true);
    expect(getMeta(id).status).toBe('delivered');
    expect(await takeUnreceived(id, { via: 'A' })).toBeNull(); // exactly once
  });

  it('two channels racing deliver each message exactly once', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    const results = await Promise.all([takeUnreceived(id, { via: 'A' }), takeUnreceived(id, { via: 'await' }), takeUnreceived(id, { via: 'B' })]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('leaves finished reviews alone and can record an injection', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    expect(await markInjected(id, '2026-11-11T10:00:00.000Z')).toBe(1);
    expect(outbox(id)[0].injectedAt).toBe('2026-11-11T10:00:00.000Z');
    expect(outbox(id)[0].receivedAt).toBeUndefined();
    await closeReview(id);
    expect(await takeUnreceived(id, { via: 'A' })).toBeNull();
  });
});

describe('queued messages and replies', () => {
  it('a message sent while Claude answers is queued: round + 1, and replies never land behind it', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'first', send: true });
    await takeUnreceived(id, { via: 'await' });
    await addUserMessage(id, 't1', { text: 'second', send: true });
    expect(getMeta(id)).toMatchObject({ round: 2, status: 'feedback_pending' });
    expect(queuedIds(outbox(id))).toEqual(new Set(['m2']));

    await replyToThread(id, 't1', 'answer one');
    expect(listThreads(id)[0].messages.map((m) => [m.author, m.text])).toEqual([['user', 'first'], ['claude', 'answer one'], ['user', 'second']]);
    expect(pendingThreads(listThreads(id))).toHaveLength(1); // 'second' is still unanswered
    // Claude has not seen 'second' yet, so it cannot answer it
    await expect(replyToThread(id, 't1', 'too early')).rejects.toThrow(/no pending/);
  });

  it('rd done drops received and answered entries, keeps what is still queued, and reports status accordingly', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'first', send: true });
    await takeUnreceived(id, { via: 'await' });
    await addThread(id, { anchor: anchor(4), text: 'newer', send: true }); // queued while Claude answers
    await replyToThread(id, 't1', 'a1');
    const r = await completeRound(id);
    expect(r.unanswered).toEqual([]);
    expect(outbox(id).map((e) => e.threadId)).toEqual(['t2']);
    expect(getMeta(id).status).toBe('feedback_pending');
    // the next delivery takes the queued one; done then empties the outbox
    await takeUnreceived(id, { via: 'await' });
    await replyToThread(id, 't2', 'a2');
    await completeRound(id);
    expect(outbox(id)).toEqual([]);
    expect(getMeta(id).status).toBe('answered');
  });

  it('rd done warns about received threads Claude never answered but does not warn about queued ones', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q1', send: true });
    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    await takeUnreceived(id, { via: 'A' });
    await addUserMessage(id, 't1', { text: 'more', send: true });
    const r = await completeRound(id);
    expect(r.unanswered).toEqual(['t1', 't2']);
    expect(outbox(id).map((e) => e.messageId)).toEqual(['m3']); // only the newer follow-up stays queued
  });

  it('the outbox without any received entry behaves like before: everything is readable and answerable', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    expect(queuedIds(outbox(id)).size).toBe(0);
    await replyToThread(id, 't1', 'a');
    expect(listThreads(id)[0].status).toBe('answered');
  });
});

describe('rd reply marks a fully answered review as answered', () => {
  it('delivered -> answered when no thread is pending any more (plan reviews never call rd done)', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q1', send: true });
    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    await takeUnreceived(id, { via: 'await' });
    await replyToThread(id, 't1', 'a1');
    expect(getMeta(id).status).toBe('delivered'); // t2 still waits
    await replyToThread(id, 't2', 'a2');
    expect(getMeta(id).status).toBe('answered');
  });

  it('feedback queued meanwhile keeps the review feedback_pending', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q1', send: true });
    await takeUnreceived(id, { via: 'await' });
    await addThread(id, { anchor: anchor(4), text: 'newer', send: true });
    await replyToThread(id, 't1', 'a1');
    expect(getMeta(id).status).toBe('feedback_pending');
  });
});

describe('session queries', () => {
  it('reviewsWithUnreceived: earliest waiting entry first, finished reviews and other sessions excluded, skip() honoured', async () => {
    const a = await mk({ sessionId: 's1' });
    const b = await mk({ sessionId: 's1', docPath: '/x/b.md' });
    const other = await mk({ sessionId: 's2', docPath: '/x/c.md' });
    const done = await mk({ sessionId: 's1', docPath: '/x/d.md' });
    await addThread(b.id, { anchor: anchor(3), text: 'b first', send: true });
    await new Promise((r) => setTimeout(r, 5));
    await addThread(a.id, { anchor: anchor(3), text: 'a second', send: true });
    await addThread(other.id, { anchor: anchor(3), text: 'x', send: true });
    await addThread(done.id, { anchor: anchor(3), text: 'x', send: true });
    await closeReview(done.id);
    expect(reviewsWithUnreceived('s1').map((r) => r.meta.id)).toEqual([b.id, a.id]);
    expect(reviewsWithUnreceived('s1', { skip: (m) => m.id === b.id }).map((r) => r.meta.id)).toEqual([a.id]);
    expect(readSessionReviews('s1').map((r) => r.meta.id).sort()).toEqual([a.id, b.id].sort());
    expect(unreceived(readSessionReviews('s2')[0].outbox)).toHaveLength(1);
  });
});

describe('lifecycle: approvedPendingExit and endInstant', () => {
  const plan = () => createReview({ kind: 'plan', sessionId: 's1', cwd: '/x', content, source: 'ExitPlanMode' });

  it('approving a plan nobody is waiting for flags approvedPendingExit; a live hook does not', async () => {
    const a = await plan();
    await approveReview(a.id);
    expect(getMeta(a.id)).toMatchObject({ status: 'approved', approvedPendingExit: true });

    const b = await plan();
    await withReview(b.id, (ctx) => {
      ctx.meta.hook = { pid: process.pid, since: 'now' };
    });
    await approveReview(b.id);
    expect(getMeta(b.id).status).toBe('approved');
    expect(getMeta(b.id).approvedPendingExit).toBeUndefined();

    const c = await plan();
    await approveReview(c.id, { via: 'native' });
    expect(getMeta(c.id).approvedPendingExit).toBeUndefined();

    const d = await mk();
    await approveReview(d.id);
    expect(getMeta(d.id)).toMatchObject({ status: 'closed' });
    expect(getMeta(d.id).approvedPendingExit).toBeUndefined();
  });

  it('endInstant records the end once; the next message starts instant mode again', async () => {
    const { id } = await mk();
    expect(await endInstant(id)).toEqual({ ended: [id], awaitingAlive: false });
    const first = getMeta(id).instant.endedAt;
    expect(first).toBeTruthy();
    expect(await endInstant(id)).toEqual({ ended: [], awaitingAlive: false }); // idempotent, nothing newly ended
    expect(getMeta(id).instant.endedAt).toBe(first);
    await addThread(id, { anchor: anchor(3), text: 'again', send: true });
    expect(getMeta(id).instant).toBeUndefined();
    await closeReview(id);
    expect(await endInstant(id)).toEqual({ ended: [], awaitingAlive: false }); // finished reviews are left alone
    expect(getMeta(id).instant).toBeUndefined();
  });

  it('endInstant ends every unfinished review of the session, no other session, no finished review (M2.5: session level)', async () => {
    const a = await mk({ docPath: '/x/a.md' });
    const b = await mk({ docPath: '/x/b.md' });
    const p = await plan();
    const done = await mk({ docPath: '/x/c.md' });
    await closeReview(done.id);
    const other = await mk({ docPath: '/x/o.md', sessionId: 's2' });

    const res = await endInstant(a.id);
    expect([...res.ended].sort()).toEqual([a.id, b.id, p.id].sort());
    expect(res.awaitingAlive).toBe(false);
    for (const id of [a.id, b.id, p.id]) expect(getMeta(id).instant.endedAt).toBeTruthy();
    expect(getMeta(other.id).instant).toBeUndefined();
    expect(getMeta(done.id).instant).toBeUndefined();

    // pressing E again anywhere in the session: nothing new
    expect(await endInstant(b.id)).toEqual({ ended: [], awaitingAlive: false });
    // a message in one review restarts instant mode for THAT review only
    await addThread(b.id, { anchor: anchor(3), text: 'more', send: true });
    expect(getMeta(b.id).instant).toBeUndefined();
    expect(getMeta(a.id).instant.endedAt).toBeTruthy();
    // E from a: b (restarted) is ended again, a already was
    expect(await endInstant(a.id)).toEqual({ ended: [b.id], awaitingAlive: false });
  });

  it('endInstant without a sessionId only touches its own review', async () => {
    const a = await mk({ sessionId: undefined, docPath: '/x/a.md' });
    const b = await mk({ sessionId: undefined, docPath: '/x/b.md' });
    expect(await endInstant(a.id)).toEqual({ ended: [a.id], awaitingAlive: false });
    expect(getMeta(b.id).instant).toBeUndefined();
  });

  it('endInstant reports a live rd await of the session (session-wide, or bound to one of its reviews), not a dead or foreign one', async () => {
    const a = await mk({ docPath: '/x/a.md' });
    const b = await mk({ docPath: '/x/b.md' });
    const live = (reviewId) => ({ reviewId, since: new Date().toISOString(), pid: process.pid, startTime: readProc(process.pid)?.startTime ?? null });
    await updateSession('s1', { awaiting: live(null) });
    expect((await endInstant(a.id)).awaitingAlive).toBe(true);

    await updateSession('s1', { awaiting: live(b.id) }); // bound to the sibling: covered as well
    expect((await endInstant(a.id)).awaitingAlive).toBe(true);

    await updateSession('s1', { awaiting: live('doc-20200101-000000-zzzz') }); // bound to a review this session does not own
    expect((await endInstant(a.id)).awaitingAlive).toBe(false);

    await updateSession('s1', { awaiting: { ...live(null), pid: 2 ** 22 + 555 } }); // process gone
    expect((await endInstant(a.id)).awaitingAlive).toBe(false);
  });
});

describe('appendRevision: status, ownership', () => {
  it('feedback still queued keeps the review feedback_pending', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await appendRevision(id, content + '\nmore', { source: 'Edit', turn: 2 });
    expect(getMeta(id).status).toBe('feedback_pending');
    await takeUnreceived(id, { via: 'A' });
    await appendRevision(id, content + '\nmore\nmore', { source: 'Edit', turn: 3 });
    expect(getMeta(id).status).toBe('awaiting_review');
  });

  it('a different writing session takes the review over and never merges into the old session turn', async () => {
    const { id } = await mk({ sessionId: 's1' }); // revision 1 recorded at turn 1
    const r = await appendRevision(id, content + '\nby s2', { source: 'Edit', turn: 1, sessionId: 's2' });
    expect(r).toMatchObject({ n: 2, merged: false });
    expect(getMeta(id).sessionId).toBe('s2');
    const same = await appendRevision(id, content + '\nby s2 again', { source: 'Edit', turn: 1, sessionId: 's2' });
    expect(same.merged).toBe(true); // now it is the owner's own turn counter
  });
});

describe('appendRevision: title', () => {
  const renamed = content.replace('# Title', '# Renamed heading');

  it('a document review follows the top heading of its latest revision (merged or new)', async () => {
    const { id } = await mk();
    expect(getMeta(id).title).toBe('Title');
    await appendRevision(id, renamed, { source: 'Edit', turn: 2 });
    expect(getMeta(id).title).toBe('Renamed heading');
    expect(listMetas().find((m) => m.id === id).title).toBe('Renamed heading'); // what `rd list` and the inbox read
    // the same turn merges into the revision: the title still follows
    await appendRevision(id, content.replace('# Title', '# Merged heading'), { source: 'Edit', turn: 2 });
    expect(getMeta(id)).toMatchObject({ currentRevision: 2, title: 'Merged heading' });
  });

  it('uses the creation rule: no heading -> file name (documents) or "plan"; an unchanged file keeps the title', async () => {
    const { id } = await mk();
    await appendRevision(id, 'no heading any more\n', { source: 'Edit', turn: 2 });
    expect(getMeta(id).title).toBe('a.md');
    expect((await appendRevision(id, 'no heading any more\n', { source: 'Edit', turn: 3 })).changed).toBe(false);
    expect(getMeta(id).title).toBe('a.md');
    const plan = await createReview({ kind: 'plan', sessionId: 's1', cwd: '/x', content: '# Plan A\n\nstep', source: 'ExitPlanMode', turn: 1 });
    await appendRevision(plan.id, '# Plan B\n\nstep', { source: 'ExitPlanMode', turn: 2 });
    expect(getMeta(plan.id).title).toBe('Plan B');
    await appendRevision(plan.id, 'just steps\n', { source: 'ExitPlanMode', turn: 3 });
    expect(getMeta(plan.id).title).toBe('plan');
  });

  it('an explicitly given title is kept', async () => {
    const { id } = await mk({ title: 'My own name' });
    expect(getMeta(id)).toMatchObject({ title: 'My own name', titleExplicit: true });
    await appendRevision(id, renamed, { source: 'Edit', turn: 2 });
    expect(getMeta(id).title).toBe('My own name');
  });

  it('a document rewritten through the hook path (registerDocWrite) is retitled too', async () => {
    const base = { docPath: '/proj/docs/t.md', sessionId: 's1', cwd: '/proj', tool: 'Write', turn: 1 };
    const first = await registerDocWrite({ ...base, content, autoRegister: true });
    await registerDocWrite({ ...base, turn: 2, content: renamed });
    expect(getMeta(first.id).title).toBe('Renamed heading');
  });
});

describe('registerDocWrite', () => {
  const base = { docPath: '/proj/docs/a.md', sessionId: 's1', cwd: '/proj', tool: 'Write', turn: 1, content };
  it('creates a doc review for a matching path, then appends revisions (same turn merges)', async () => {
    const r1 = await registerDocWrite({ ...base, autoRegister: true });
    expect(r1.action).toBe('created');
    const meta = getMeta(r1.id);
    expect(meta).toMatchObject({ kind: 'doc', docPath: '/proj/docs/a.md', sessionId: 's1', cwd: '/proj', status: 'awaiting_review' });
    expect(meta.revisions[0]).toMatchObject({ source: 'Write', turn: 1 });
    expect(getActiveReview('/proj/docs/a.md')).toBe(r1.id);

    const r2 = await registerDocWrite({ ...base, content: content + '\nedit', tool: 'Edit', autoRegister: false }); // glob no longer matters
    expect(r2).toMatchObject({ action: 'revision', id: r1.id, merged: true });
    const r3 = await registerDocWrite({ ...base, content: content + '\nedit\nagain', tool: 'Edit', turn: 2, autoRegister: false });
    expect(r3).toMatchObject({ action: 'revision', n: 2, merged: false });
    expect(readRevision(r1.id, 2)).toContain('again');
    expect(listMetas()).toHaveLength(1);
  });

  it('does nothing for an unmatched path, and replaces a stale index entry', async () => {
    expect((await registerDocWrite({ ...base, autoRegister: false })).action).toBe('ignored');
    const r1 = await registerDocWrite({ ...base, autoRegister: true });
    await closeReview(r1.id);
    expect(getActiveReview('/proj/docs/a.md')).toBeNull();
    // a stale entry pointing at a finished review is dropped
    fs.writeFileSync(paths.docsIndex(), JSON.stringify({ '/proj/docs/a.md': r1.id }));
    expect((await registerDocWrite({ ...base, autoRegister: false })).action).toBe('ignored');
    expect(getActiveReview('/proj/docs/a.md')).toBeNull();
    const r2 = await registerDocWrite({ ...base, autoRegister: true });
    expect(r2.id).not.toBe(r1.id);
  });

  it('concurrent writes to one new path create one review', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => registerDocWrite({ ...base, autoRegister: true })));
    expect(rs.filter((r) => r.action === 'created')).toHaveLength(1);
    expect(listMetas()).toHaveLength(1);
  });
});
