import { describe, it, expect } from 'vitest';
import { useTempHome } from '../helpers/env.js';
import { createReview, getMeta } from '../../src/store/reviews.js';
import { listThreads } from '../../src/store/threads.js';
import { readJson } from '../../src/store/io.js';
import { paths } from '../../src/store/paths.js';
import * as ops from '../../src/tui/lib/reviewOps.js';

useTempHome();

const content = ['# Title', 'alpha beta gamma', 'delta epsilon', 'zeta'].join('\n');
const mk = (kind = 'doc') => createReview({ kind, docPath: kind === 'doc' ? '/tmp/x.md' : null, sessionId: 's1', cwd: '/tmp', content, source: 'Write', turn: 1 });

describe('reviewOps', () => {
  it('instant comment: a sent thread with a whole-line anchor, queued in the outbox', async () => {
    const meta = await mk();
    const res = await ops.createComment({ id: meta.id, meta, content, sel: { startLine: 2, endLine: 3 }, text: 'Why?', send: true });
    expect(res.ok).toBe(true);
    expect(res.sent).toBe(true);
    const [t] = listThreads(meta.id);
    expect(t.anchor).toMatchObject({ startLine: 2, endLine: 3, startCol: null, quote: 'alpha beta gamma\ndelta epsilon' });
    expect(t.messages[0]).toMatchObject({ state: 'sent', text: 'Why?' });
    expect(readJson(paths.outbox(meta.id), [])).toHaveLength(1);
    expect(getMeta(meta.id).status).toBe('feedback_pending');
    expect(res.focusId).toBe(t.id);
    expect(res.line).toBe(1);
  });

  it('batch comment: draft only; submitDrafts sends them all', async () => {
    const meta = await mk();
    await ops.createComment({ id: meta.id, meta, content, sel: { startLine: 2, endLine: 2, startCol: 6, endCol: 10 }, text: 'a', send: false });
    await ops.createComment({ id: meta.id, meta, content, sel: { startLine: 4, endLine: 4 }, text: 'b', send: false });
    expect(listThreads(meta.id).every((t) => t.messages[0].state === 'draft')).toBe(true);
    expect(readJson(paths.outbox(meta.id), [])).toHaveLength(0);
    const res = await ops.submitDrafts(meta.id);
    expect(res.ok).toBe(true);
    expect(res.notice.text).toBe('submitted 2');
    expect(listThreads(meta.id).every((t) => t.messages[0].state === 'sent')).toBe(true);
    expect((await ops.submitDrafts(meta.id)).ok).toBe(false); // nothing left
  });

  it('a mouse selection stores character columns and just the selected text', async () => {
    const meta = await mk();
    await ops.createComment({ id: meta.id, meta, content, sel: { startLine: 2, endLine: 2, startCol: 6, endCol: 10 }, text: 'x', send: false });
    expect(listThreads(meta.id)[0].anchor).toMatchObject({ startCol: 6, endCol: 10, quote: 'beta' });
  });

  it('reply, resolve / reopen, delete draft', async () => {
    const meta = await mk();
    const c = await ops.createComment({ id: meta.id, meta, content, sel: { startLine: 2, endLine: 2 }, text: 'q', send: false });
    const r = await ops.createReply({ id: meta.id, threadId: c.focusId, text: 'more', send: false });
    expect(r.ok).toBe(true);
    let t = listThreads(meta.id)[0];
    expect(t.messages.map((m) => m.state)).toEqual(['draft', 'draft']);
    expect((await ops.removeDraft(meta.id, t)).ok).toBe(true);
    t = listThreads(meta.id)[0];
    expect(t.messages).toHaveLength(1);
    expect((await ops.toggleResolved(meta.id, t)).notice.text).toContain('resolved');
    t = listThreads(meta.id)[0];
    expect(t.status).toBe('resolved');
    expect((await ops.toggleResolved(meta.id, t)).notice.text).toContain('reopened');
    expect(listThreads(meta.id)[0].status).toBe('open');
    // removing the last draft deletes the thread
    expect((await ops.removeDraft(meta.id, listThreads(meta.id)[0])).ok).toBe(true);
    expect(listThreads(meta.id)).toHaveLength(0);
    expect((await ops.removeDraft(meta.id, { id: 't9', messages: [] })).ok).toBe(false);
  });

  it('errors become notices instead of exceptions', async () => {
    const meta = await mk();
    const bad = await ops.createComment({ id: meta.id, meta, content, sel: { startLine: 99, endLine: 99 }, text: 'x', send: true });
    expect(bad.ok).toBe(false);
    expect(bad.notice.kind).toBe('err');
    const empty = await ops.createComment({ id: meta.id, meta, content, sel: { startLine: 1, endLine: 1 }, text: '  ', send: true });
    expect(empty.ok).toBe(false);
  });

  it('approve: plan -> approved, doc -> closed; read-only afterwards', async () => {
    const plan = await mk('plan');
    const res = await ops.approve(plan.id, plan);
    expect(res).toMatchObject({ ok: true, finished: 'approved' });
    expect(getMeta(plan.id).status).toBe('approved');
    expect(ops.isReadOnly(getMeta(plan.id))).toBe(true);
    const doc = await mk('doc');
    await ops.approve(doc.id, doc);
    expect(getMeta(doc.id).status).toBe('closed');
  });

  it('approving a plan nobody blocks on says who picks the approval up: Claude in `rd await` hears at once, otherwise at its next ExitPlanMode', async () => {
    const waiting = await mk('plan');
    const a = await ops.approve(waiting.id, waiting, { awaitingAlive: true });
    expect(a).toMatchObject({ ok: true, pendingExit: true });
    expect(a.notice.text).toContain('notified at once');
    expect(a.notice.text).not.toContain('not waiting right now');
    expect(getMeta(waiting.id).approvedPendingExit).toBe(true);
    const gone = await mk('plan');
    const b = await ops.approve(gone.id, gone);
    expect(b.notice.text).toContain('not waiting right now');
  });
});
