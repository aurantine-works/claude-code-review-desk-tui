// Multi-round review of one document, the way a user and Claude actually take turns (M3 acceptance, backend half):
// send -> deliver -> `rd show` -> `rd reply` -> `rd done` -> follow-up -> round 2 ... resolve / reopen / approve.
// The Claude side runs through the real CLI command functions (show / reply / done); delivery is takeUnreceived(), which
// every channel (await, A, B, hook) goes through.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { show, reply, done } from '../src/cli/commands.js';
import { createReview, getMeta } from '../src/store/reviews.js';
import { addThread, addUserMessage, listThreads, setThreadStatus, sendDrafts } from '../src/store/threads.js';
import { approveReview, markInReview } from '../src/store/lifecycle.js';
import { appendRevision } from '../src/store/revisions.js';
import { takeUnreceived } from '../src/store/outbox.js';
import { setActiveReview, getActiveReview } from '../src/store/docsIndex.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';
import { renderPrompt } from '../src/feedback/index.js';

useTempHome();
const SID = 'rounds-session';
const v1 = ['# Weekly report', '', 'Migration risk is low.', 'Takes two weeks.', 'Tests included.'].join('\n');
const anchor = (text, line, revision = 1) => makeAnchor(text, { startLine: line, endLine: line }, revision);
const outbox = (id) => readJson(paths.outbox(id), []);
const thread = (id, tid) => listThreads(id).find((t) => t.id === tid);

let spy;
afterEach(() => spy?.mockRestore());
/** Run a CLI command function and return what it printed on stdout / stderr. */
async function cli(fn, ...args) {
  const out = [];
  const err = [];
  spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
  try {
    await fn(...args);
  } finally {
    spy.mockRestore();
    spyErr.mockRestore();
  }
  return { stdout: out.join(''), stderr: err.join('') };
}
const rdShow = async (id) => (await cli(show, id, { format: 'prompt' })).stdout;
const rdReply = (id, tid, text) => cli(reply, id, tid, text);
const rdDone = (id) => cli(done, id);

async function newDoc() {
  const m = await createReview({ kind: 'doc', docPath: '/w/reports/week.md', sessionId: SID, cwd: '/w', content: v1, source: 'Write', turn: 1 });
  await setActiveReview('/w/reports/week.md', m.id);
  return m.id;
}

describe('a document reviewed over three rounds', () => {
  it('questions, change request, follow-ups, resolve, reopen and approve: every round leaves the right state behind', async () => {
    const id = await newDoc();
    expect(getMeta(id)).toMatchObject({ status: 'awaiting_review', round: 0 });
    await markInReview(id);
    expect(getMeta(id).status).toBe('in_review');

    // ---- round 1: two threads sent one by one (instant mode) -------------------------------------------------------
    await addThread(id, { anchor: anchor(v1, 3), text: 'What is the basis for "low"?', send: true });
    await addThread(id, { anchor: anchor(v1, 4), text: 'Please say whether this includes testing.', send: true });
    expect(getMeta(id)).toMatchObject({ status: 'feedback_pending', round: 1 }); // the second message joined round 1
    expect(outbox(id).map((e) => e.threadId)).toEqual(['t1', 't2']);
    expect(outbox(id).every((e) => !e.receivedAt)).toBe(true);

    const taken1 = await takeUnreceived(id, { via: 'await' });
    expect(taken1.entries).toHaveLength(2);
    expect(getMeta(id).status).toBe('delivered');
    const prompt1 = await rdShow(id);
    expect(prompt1).toContain(`# Review feedback · ${id} · round 1`);
    expect(prompt1).toContain('## Thread t1 · lines 3-3');
    expect(prompt1).toContain('## Thread t2 · lines 4-4');
    expect(prompt1).not.toContain('previous discussion');
    expect(prompt1).toContain('**User:** What is the basis for "low"?');

    expect((await rdReply(id, 't1', 'Only two slices are touched.')).stdout).toContain('replied t1');
    expect(getMeta(id).status).toBe('delivered'); // t2 is still open
    // a thread cannot be answered twice
    await expect(rdReply(id, 't1', 'again')).rejects.toThrow(/no pending user message/);
    await rdReply(id, 't2', 'Yes, tests are included in the two weeks.');
    expect(getMeta(id).status).toBe('answered'); // nothing left to answer: the review reads as answered
    const d1 = await rdDone(id);
    expect(d1.stdout).toContain('2 answered');
    expect(d1.stderr).toBe('');
    expect(outbox(id)).toEqual([]);
    expect(getMeta(id)).toMatchObject({ status: 'answered', round: 1 });
    expect(thread(id, 't1')).toMatchObject({ status: 'answered' });
    expect(thread(id, 't1').messages.map((m) => [m.author, m.round])).toEqual([['user', 1], ['claude', 1]]);
    expect(await rdShow(id)).toContain('(no open threads)'); // nothing pending any more

    // ---- round 2: follow-up on t1, t2 resolved, a new thread t3 -----------------------------------------------------
    await addUserMessage(id, 't1', { text: 'Which two slices exactly?', send: true });
    await setThreadStatus(id, 't2', 'resolved');
    await addThread(id, { anchor: anchor(v1, 5), text: 'Which tests?', send: true });
    expect(getMeta(id)).toMatchObject({ status: 'feedback_pending', round: 2 });
    expect(thread(id, 't1').status).toBe('open');
    expect(outbox(id).map((e) => e.threadId)).toEqual(['t1', 't3']);

    await takeUnreceived(id, { via: 'A' });
    const prompt2 = await rdShow(id);
    expect(prompt2).toContain(`round 2`);
    expect(prompt2).toContain('## Thread t1 · lines 3-3 (previous discussion)');
    expect(prompt2).toContain('**User (round 1):** What is the basis for "low"?');
    expect(prompt2).toContain('**Claude (round 1):** Only two slices are touched.');
    expect(prompt2).toContain('**User:** Which two slices exactly?');
    expect(prompt2).toContain('## Thread t3 · lines 5-5\n'); // new thread: no history
    expect(prompt2).not.toContain('Thread t2'); // resolved threads are not sent

    // Claude answers t1 by changing the document: revision 2, anchors follow
    const v2 = v1.replace('Migration risk is low.', 'Migration risk is low (store and cache slices only).');
    await appendRevision(id, v2, { source: 'Edit', turn: 5, sessionId: SID });
    expect(getMeta(id)).toMatchObject({ currentRevision: 2, status: 'awaiting_review' }); // a new revision to look at (rd done settles it below)
    expect(thread(id, 't1').anchor).toMatchObject({ revision: 2, startLine: 3 });
    await rdReply(id, 't1', 'Store and cache; I added that to the sentence.');
    await rdReply(id, 't3', 'The integration tests of the migration.');
    await rdDone(id);
    expect(getMeta(id)).toMatchObject({ status: 'answered', round: 2 });
    expect(outbox(id)).toEqual([]);
    expect(thread(id, 't1').messages.map((m) => [m.author, m.round])).toEqual([['user', 1], ['claude', 1], ['user', 2], ['claude', 2]]);
    expect(thread(id, 't2').status).toBe('resolved');

    // ---- round 3: t2 reopened with a new question; while Claude answers, the user queues one more -------------------
    await addUserMessage(id, 't2', { text: 'Actually, how long do the tests take?', send: true });
    expect(thread(id, 't2').status).toBe('open'); // writing in a resolved thread reopens it
    expect(getMeta(id).round).toBe(3);
    await takeUnreceived(id, { via: 'await' });
    const prompt3 = await rdShow(id);
    expect(prompt3).toContain('## Thread t2 · lines 4-4 (previous discussion)');
    expect(prompt3).toContain('**User (round 1):** Please say whether this includes testing.');
    expect(prompt3).toContain('**Claude (round 1):** Yes, tests are included in the two weeks.');
    expect(prompt3).toContain('**User:** Actually, how long do the tests take?');
    expect(prompt3).not.toContain('Thread t1');
    expect(prompt3).not.toContain('Thread t3');

    await addUserMessage(id, 't1', { text: 'And the third slice?', send: true }); // sent while Claude answers round 3
    expect(getMeta(id).round).toBe(4);
    expect(outbox(id).filter((e) => !e.receivedAt).map((e) => e.threadId)).toEqual(['t1']);
    await expect(rdReply(id, 't1', 'too early')).rejects.toThrow(/no pending user message/); // Claude has not seen it
    await rdReply(id, 't2', 'About three days.');
    const d3 = await rdDone(id);
    expect(d3.stdout).toContain('newer comments are waiting');
    expect(getMeta(id)).toMatchObject({ status: 'feedback_pending', round: 4 }); // the queued message keeps the review pending
    expect(outbox(id).map((e) => [e.threadId, !!e.receivedAt])).toEqual([['t1', false]]);
    expect(thread(id, 't2').status).toBe('answered');
    expect(thread(id, 't1').status).toBe('open');

    // the next delivery takes the queued message (round 4), with the history of t1
    await takeUnreceived(id, { via: 'await' });
    const prompt4 = await rdShow(id);
    expect(prompt4).toContain('round 4');
    expect(prompt4).toContain('## Thread t1 · lines 3-3 (previous discussion)');
    expect(prompt4).toContain('**Claude (round 2):** Store and cache; I added that to the sentence.');
    expect(prompt4).toContain('**User:** And the third slice?');
    await rdReply(id, 't1', 'There is no third slice.');
    await rdDone(id);
    expect(getMeta(id).status).toBe('answered');
    expect(listThreads(id).map((t) => [t.id, t.status])).toEqual([['t1', 'answered'], ['t2', 'answered'], ['t3', 'answered']]);

    // ---- end: resolve what is settled and approve --------------------------------------------------------------------
    await setThreadStatus(id, 't1', 'resolved');
    await setThreadStatus(id, 't3', 'resolved');
    expect(getActiveReview('/w/reports/week.md')).toBe(id);
    await approveReview(id);
    expect(getMeta(id).status).toBe('closed'); // a document review is closed by approval
    expect(getActiveReview('/w/reports/week.md')).toBeNull();
    expect(outbox(id)).toEqual([]);
    expect(getMeta(id).revisions.map((r) => r.n)).toEqual([1, 2]);
  });

  it('batch mode: all drafts of a round go out together as one round', async () => {
    const id = await newDoc();
    await addThread(id, { anchor: anchor(v1, 3), text: 'a?' });
    await addThread(id, { anchor: anchor(v1, 4), text: 'b?' });
    expect(getMeta(id).round).toBe(0);
    expect(await sendDrafts(id)).toBe(2);
    expect(getMeta(id)).toMatchObject({ round: 1, status: 'feedback_pending' });
    await takeUnreceived(id, { via: 'A' });
    await rdReply(id, 't1', 'A');
    await rdReply(id, 't2', 'B');
    await rdDone(id);
    expect(await sendDrafts(id)).toBe(0); // nothing left to send
    await addUserMessage(id, 't1', { text: 'follow-up draft' });
    await addUserMessage(id, 't2', { text: 'another draft' });
    await sendDrafts(id);
    expect(getMeta(id).round).toBe(2);
    expect(outbox(id)).toHaveLength(2);
  });

  it('resolving a thread whose message was not delivered yet withdraws it: nothing empty is delivered later', async () => {
    const id = await newDoc();
    await addThread(id, { anchor: anchor(v1, 3), text: 'q1', send: true });
    await addThread(id, { anchor: anchor(v1, 4), text: 'q2', send: true });
    await setThreadStatus(id, 't1', 'resolved'); // the user changed their mind before Claude received anything
    expect(outbox(id).map((e) => e.threadId)).toEqual(['t2']);
    expect(getMeta(id).status).toBe('feedback_pending');
    await setThreadStatus(id, 't2', 'resolved');
    expect(outbox(id)).toEqual([]);
    expect(getMeta(id).status).toBe('in_review'); // nothing waits for Claude any more
    const t = await takeUnreceived(id, { via: 'await' });
    expect(t).toBeNull(); // no empty "feedback" wake-up
  });

  it('the prompt Claude gets is the same whichever way it is produced', async () => {
    const id = await newDoc();
    await addThread(id, { anchor: anchor(v1, 3), text: 'q', send: true });
    await takeUnreceived(id, { via: 'A' });
    expect(await rdShow(id)).toBe(renderPrompt(getMeta(id), listThreads(id)));
  });
});
