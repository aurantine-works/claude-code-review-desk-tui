import { describe, it, expect } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { runAwait } from '../src/delivery/await.js';
import { resolveSession, sessionByPid } from '../src/delivery/session.js';
import { createReview, getMeta, withReview } from '../src/store/reviews.js';
import { addThread, addUserMessage, replyToThread, listThreads } from '../src/store/threads.js';
import { approveReview, closeReview, endInstant } from '../src/store/lifecycle.js';
import { getSession, updateSession } from '../src/store/sessions.js';
import { takeUnreceived } from '../src/store/outbox.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';
import { AWAIT_MARKER } from '../src/feedback/instructions.js';
import { DEFAULT_CONFIG } from '../src/config.js';

useTempHome();
const SID = 'await-session';
const content = ['# Report', '', 'Risk is low.', 'Takes two weeks.'].join('\n');
const anchor = (line) => makeAnchor(content, { startLine: line, endLine: line }, 1);
const doc = (over = {}) => createReview({ kind: 'doc', docPath: '/w/docs/a.md', sessionId: SID, cwd: '/w', content, source: 'Write', ...over });
const plan = () => createReview({ kind: 'plan', sessionId: SID, cwd: '/w', content, source: 'ExitPlanMode' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEAD_PID = 2 ** 22 + 777;

const fast = (over = {}) => ({ env: {}, claude: { pid: process.pid, via: 'env', startTime: null }, isClaudeAlive: () => true, config: DEFAULT_CONFIG, ...over });
const opts = (over = {}) => ({ session: SID, pollMs: 15, ...over });
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
const awaitingRecord = () => getSession(SID)?.awaiting;

describe('rd await: feedback', () => {
  it('registers awaiting, waits, prints the feedback in rd show style, marks it received and clears awaiting before returning', async () => {
    const { id } = await doc();
    const run = runAwait(opts(), fast());
    const rec = await waitFor(awaitingRecord);
    expect(rec).toMatchObject({ reviewId: null, pid: process.pid });
    expect(rec.since).toBeTruthy();
    await sleep(50);
    expect(awaitingRecord()).toBeTruthy(); // still waiting

    await addThread(id, { anchor: anchor(3), text: 'why is the risk low?', send: true });
    const r = await run;
    expect(r.result).toBe('feedback');
    expect(r.reviewIds).toEqual([id]);
    const lines = r.output.split('\n');
    expect(lines[0]).toBe(AWAIT_MARKER);
    expect(lines[1]).toBe('feedback');
    expect(r.output).toContain(`# Review feedback · ${id} · round 1`);
    expect(r.output).toContain('## Thread t1 · lines 3-3');
    expect(r.output).toContain('**User:** why is the risk low?');
    expect(r.output).toContain(`rd reply ${id} <threadId>`);
    expect(r.output).toContain('start `rd await` as a BACKGROUND Bash task');
    expect(awaitingRecord()).toBeUndefined();
    expect(readJson(paths.outbox(id))[0]).toMatchObject({ deliveredVia: 'await' });
    expect(getMeta(id).status).toBe('delivered');
  });

  it('delivers feedback that is already waiting at start, from all reviews of the session, but not other sessions\'', async () => {
    const a = await doc();
    const b = await doc({ docPath: '/w/docs/b.md' });
    const other = await doc({ docPath: '/w/docs/c.md', sessionId: 'someone-else' });
    for (const r of [a, b, other]) await addThread(r.id, { anchor: anchor(3), text: `q ${r.id}`, send: true });
    const r = await runAwait(opts(), fast());
    expect(r.reviewIds.sort()).toEqual([a.id, b.id].sort());
    expect(r.output).toContain(a.id);
    expect(r.output).not.toContain(other.id);
    expect(readJson(paths.outbox(other.id))[0].receivedAt).toBeUndefined();
  });

  it('--review waits for that review only and tells Claude how to restart it', async () => {
    const a = await doc();
    const b = await doc({ docPath: '/w/docs/b.md' });
    await addThread(a.id, { anchor: anchor(3), text: 'alpha-question', send: true });
    const run = runAwait(opts({ review: b.id }), fast());
    expect((await waitFor(awaitingRecord)).reviewId).toBe(b.id);
    await sleep(60);
    expect(awaitingRecord()).toBeTruthy(); // a's feedback does not wake a wait for b
    await addThread(b.id, { anchor: anchor(3), text: 'beta-question', send: true });
    const r = await run;
    expect(r.output).toContain(`start \`rd await --review ${b.id}\``);
    expect(r.output).toContain('beta-question');
    expect(r.output).not.toContain('alpha-question');
    expect(readJson(paths.outbox(a.id))[0].receivedAt).toBeUndefined();
  });

  it('threads the user queued while Claude was answering come with the next await (and rd reply cannot answer them early)', async () => {
    const { id } = await doc();
    await addThread(id, { anchor: anchor(3), text: 'first', send: true });
    const r1 = await runAwait(opts(), fast());
    expect(r1.result).toBe('feedback');
    await addUserMessage(id, 't1', { text: 'second', send: true }); // typed while Claude is answering
    await replyToThread(id, 't1', 'answer to the first');
    // Claude finishes: done, then a new await picks the queued message up
    const { completeRound } = await import('../src/store/threads.js');
    await completeRound(id);
    const r2 = await runAwait(opts(), fast());
    expect(r2.result).toBe('feedback');
    expect(r2.output).toContain('**User (round 1):** first');
    expect(r2.output).toContain('**Claude (round 1):** answer to the first');
    expect(r2.output).toContain('**User:** second');
    expect(listThreads(id)[0].messages.map((m) => m.author)).toEqual(['user', 'claude', 'user']);
  });
});

describe('rd await: singleton and cleanup', () => {
  it('a second await for the session prints already-waiting; a dead record is replaced', async () => {
    const { id } = await doc();
    const first = runAwait(opts(), fast());
    await waitFor(awaitingRecord);
    // the "second process" must look like another pid, so fake the record owner
    await updateSession(SID, { awaiting: { reviewId: null, since: 'now', pid: process.ppid } });
    const second = await runAwait(opts(), fast());
    expect(second.result).toBe('already-waiting');
    expect(second.output.split('\n').slice(0, 2)).toEqual([AWAIT_MARKER, 'already-waiting']);
    expect(awaitingRecord().pid).toBe(process.ppid); // untouched
    await updateSession(SID, { awaiting: { reviewId: null, since: 'now', pid: process.pid } });
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await first;

    // stale record (process gone): a new await takes over
    await updateSession(SID, { awaiting: { reviewId: null, since: 'old', pid: DEAD_PID } });
    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    expect((await runAwait(opts(), fast())).result).toBe('feedback');
  });

  it('a signal aborts the wait without output and clears the record; the record of someone else is never cleared', async () => {
    await doc();
    const controller = new AbortController();
    const run = runAwait(opts(), fast({ signal: controller.signal }));
    await waitFor(awaitingRecord);
    controller.abort();
    const r = await run;
    expect(r).toMatchObject({ result: 'aborted', output: null });
    expect(awaitingRecord()).toBeUndefined();
  });

  it('exits quietly when its claude process is gone, and with `end` when the session ended', async () => {
    await doc();
    let alive = true;
    const run = runAwait(opts(), fast({ isClaudeAlive: () => alive }));
    await waitFor(awaitingRecord);
    alive = false;
    expect(await run).toMatchObject({ result: 'orphaned', output: null });
    expect(awaitingRecord()).toBeUndefined();

    const run2 = runAwait(opts(), fast());
    await waitFor(awaitingRecord);
    await updateSession(SID, { state: 'ended' });
    const r = await run2;
    expect(r.result).toBe('end');
    expect(r.output).toContain('the Claude Code session ended');
  });

  it('cannot start without a session', async () => {
    await expect(runAwait({ pollMs: 10 }, fast({ env: {} }))).rejects.toThrow(/cannot tell which Claude Code session/);
    await expect(runAwait({ session: SID, review: '../x' }, fast())).rejects.toThrow(/invalid review id/);
    await expect(runAwait({ session: SID, review: 'doc-20261109-142301-a3f9' }, fast())).rejects.toThrow(/not found/);
  });
});

describe('rd await: the end of the conversation', () => {
  it('prints end when the review is closed or approved (doc), and the wait ends', async () => {
    const { id } = await doc();
    const run = runAwait(opts({ review: id }), fast());
    await waitFor(awaitingRecord);
    await closeReview(id);
    const r = await run;
    expect(r.result).toBe('end');
    expect(r.output.split('\n').slice(0, 2)).toEqual([AWAIT_MARKER, 'end']);
    expect(r.output).toContain('the review was closed');
    expect(r.output).toContain('Do NOT start another `rd await`');

    const d2 = await doc({ docPath: '/w/docs/z.md' });
    const run2 = runAwait(opts({ review: d2.id }), fast());
    await waitFor(awaitingRecord);
    await approveReview(d2.id);
    expect((await run2).result).toBe('end');
  });

  it('E (endInstant) ends the wait; a queued message is still delivered first', async () => {
    const { id } = await doc();
    const run = runAwait(opts(), fast());
    await waitFor(awaitingRecord);
    await endInstant(id);
    const r = await run;
    expect(r.result).toBe('end');
    expect(r.output).toContain('the user ended instant Q&A');

    // a message queued just before E is delivered, and the end is reported by the next await
    const d2 = await doc({ docPath: '/w/docs/z.md' });
    await addThread(d2.id, { anchor: anchor(3), text: 'last question', send: true });
    await endInstant(d2.id);
    expect((await runAwait(opts({ review: d2.id }), fast())).result).toBe('feedback');
    expect((await runAwait(opts({ review: d2.id }), fast())).result).toBe('end');
  });

  it('E in one review ends the session-wide wait although the session has other open reviews (session level)', async () => {
    const a = await doc({ docPath: '/w/docs/a.md' });
    const b = await doc({ docPath: '/w/docs/b.md' });
    const run = runAwait(opts(), fast());
    await waitFor(awaitingRecord);
    await sleep(40);
    expect(awaitingRecord()).toBeTruthy(); // two open reviews: still waiting
    const res = await endInstant(a.id);
    expect(res).toMatchObject({ awaitingAlive: true });
    expect([...res.ended].sort()).toEqual([a.id, b.id].sort());
    const r = await run;
    expect(r.result).toBe('end');
    expect(r.output).toContain('the user ended instant Q&A');
    expect(r.reviewIds.sort()).toEqual([a.id, b.id].sort());

    // a message sent afterwards restarts instant mode for that review only: the next session-wide wait takes it
    await addThread(b.id, { anchor: anchor(3), text: 'once more', send: true });
    const r2 = await runAwait(opts(), fast());
    expect(r2.result).toBe('feedback');
    expect(r2.reviewIds).toEqual([b.id]);
    expect(getMeta(a.id).instant.endedAt).toBeTruthy();
  });

  it('E also ends a wait bound to the sibling review (rd await --review <other>)', async () => {
    const a = await doc({ docPath: '/w/docs/a.md' });
    const b = await doc({ docPath: '/w/docs/b.md' });
    const run = runAwait(opts({ review: b.id }), fast());
    await waitFor(awaitingRecord);
    expect((await endInstant(a.id)).awaitingAlive).toBe(true);
    const r = await run;
    expect(r.result).toBe('end');
    expect(r.output).toContain('the user ended instant Q&A');
  });

  it('a plan approved while Claude waits: end-plan (review mode and session mode), approvedPendingExit set', async () => {
    const p = await plan();
    const run = runAwait(opts({ review: p.id }), fast());
    await waitFor(awaitingRecord);
    await approveReview(p.id);
    const r = await run;
    expect(r.result).toBe('end-plan');
    expect(r.output.split('\n').slice(0, 2)).toEqual([AWAIT_MARKER, 'end-plan']);
    expect(r.output).toContain('Call ExitPlanMode now with the plan you submitted, unchanged');
    expect(getMeta(p.id).approvedPendingExit).toBe(true);

    const p2 = await plan();
    const run2 = runAwait(opts(), fast());
    await waitFor(awaitingRecord);
    await approveReview(p2.id);
    expect((await run2).result).toBe('end-plan');
  });

  it('session mode: nothing to wait for -> end at once; one review closing does not end the wait for the others', async () => {
    const none = await runAwait(opts(), fast());
    expect(none.result).toBe('end');
    expect(none.output).toContain('no open review is waiting for feedback');

    const a = await doc();
    const b = await doc({ docPath: '/w/docs/b.md' });
    const run = runAwait(opts(), fast());
    await waitFor(awaitingRecord);
    await closeReview(a.id);
    await sleep(80);
    expect(awaitingRecord()).toBeTruthy();
    await addThread(b.id, { anchor: anchor(3), text: 'still here', send: true });
    expect((await run).result).toBe('feedback');
  });

  it('review.idleEndMinutes ends a quiet wait', async () => {
    await doc();
    let t = 1_000_000;
    const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, idleEndMinutes: 5 } };
    const run = runAwait(opts(), fast({ config, now: () => t }));
    await waitFor(awaitingRecord);
    t += 5 * 60_000 + 1;
    const r = await run;
    expect(r.result).toBe('end');
    expect(r.output).toContain('no feedback for 5 minutes');
  });
});

describe('rd await and plan reviews', () => {
  it('leaves a plan whose hook is waiting to the hook, and takes it over once the hook is gone', async () => {
    const p = await plan();
    await withReview(p.id, (ctx) => {
      ctx.meta.hook = { pid: process.pid, since: 'now' };
    });
    await addThread(p.id, { anchor: anchor(3), text: 'plan question', send: true });
    const run = runAwait(opts({ review: p.id }), fast());
    await waitFor(awaitingRecord);
    await sleep(80);
    expect(readJson(paths.outbox(p.id))[0].receivedAt).toBeUndefined();
    await withReview(p.id, (ctx) => {
      delete ctx.meta.hook; // the hook delivered/died
    });
    const r = await run;
    expect(r.result).toBe('feedback');
    expect(r.output).toContain('call ExitPlanMode again with the full revised plan');
    expect(r.output).toContain(`rd await --review ${p.id}`);
  });

  it('after an await delivery the answers go to the right round (no stale plan-deny bookkeeping)', async () => {
    const p = await plan();
    await addThread(p.id, { anchor: anchor(3), text: 'first', send: true });
    await withReview(p.id, (ctx) => {
      ctx.meta.delivered = { round: 1, threadIds: ['t1'], at: 'x' }; // an old deny round
      ctx.outbox = [];
    });
    await replyToThread(p.id, 't1', 'a1', { round: 1 });
    await addUserMessage(p.id, 't1', { text: 'second', send: true });
    const r = await runAwait(opts({ review: p.id }), fast());
    expect(r.result).toBe('feedback');
    expect(getMeta(p.id).delivered).toBeUndefined();
    const { reply } = await import('../src/cli/commands.js');
    const spy = (await import('vitest')).vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await reply(p.id, 't1', 'a2');
    } finally {
      spy.mockRestore();
    }
    expect(listThreads(p.id)[0].messages.map((m) => m.text)).toEqual(['first', 'a1', 'second', 'a2']);
  });
});

describe('session resolution', () => {
  it('CLAUDE_CODE_SESSION_ID first, then the claude pid in the registry, else null', async () => {
    expect(resolveSession({ env: { CLAUDE_CODE_SESSION_ID: 'abc-123' }, sessions: {} })).toEqual({ sessionId: 'abc-123', via: 'env' });
    expect(resolveSession({ env: { CLAUDE_CODE_SESSION_ID: '../x' }, sessions: {}, findProcess: () => null })).toBeNull();
    const sessions = {
      old: { sessionId: 'old', pid: 77, state: 'ended', updatedAt: '2026-01-01T00:00:00Z' },
      a: { sessionId: 'a', pid: 77, state: 'idle', updatedAt: '2026-01-02T00:00:00Z' },
      b: { sessionId: 'b', pid: 77, state: 'idle', updatedAt: '2026-01-03T00:00:00Z' },
    };
    expect(sessionByPid(77, sessions)).toBe('b');
    expect(sessionByPid(78, sessions)).toBeNull();
    expect(resolveSession({ env: {}, sessions, findProcess: () => ({ pid: 77, via: 'env' }) })).toEqual({ sessionId: 'b', via: 'pid' });
    expect(resolveSession({ env: {}, sessions, findProcess: () => ({ pid: 77, via: 'ppid' }) })).toBeNull(); // our parent is not claude
  });
});
