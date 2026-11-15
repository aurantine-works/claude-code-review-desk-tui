import fs from 'node:fs';
import path from 'node:path';
import { Readable, PassThrough, Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { summarize, sessionIdFromStdin, runStatusline, readMetasLight } from '../src/cli/statusline.js';
import { createReview } from '../src/store/reviews.js';
import { completeRound, addThread, replyToThread } from '../src/store/threads.js';
import { approveReview } from '../src/store/lifecycle.js';
import { makeAnchor } from '../src/anchor/index.js';
import { paths } from '../src/store/paths.js';

const home = useTempHome();
const m = (kind, status, sessionId = 's1') => ({ kind, status, sessionId });

describe('summarize', () => {
  it('formats plan / doc / answered counts', () => {
    expect(summarize([m('plan', 'awaiting_review'), m('doc', 'awaiting_review'), m('doc', 'in_review'), m('doc', 'answered')])).toBe('rd: 1 plan · 2 doc to review · 1 answered');
  });
  it('omits empty segments and returns "" when nothing is waiting', () => {
    expect(summarize([m('plan', 'awaiting_review')])).toBe('rd: 1 plan to review');
    expect(summarize([m('doc', 'answered')])).toBe('rd: 1 answered');
    expect(summarize([m('plan', 'approved'), m('doc', 'closed'), m('doc', 'delivered')])).toBe('');
    expect(summarize([])).toBe('');
  });
  it('scopes to a session when one is given', () => {
    const metas = [m('plan', 'awaiting_review', 'a'), m('doc', 'awaiting_review', 'b')];
    expect(summarize(metas, 'a')).toBe('rd: 1 plan to review');
    expect(summarize(metas, 'zzz')).toBe('');
    expect(summarize(metas)).toBe('rd: 1 plan · 1 doc to review');
  });
});

describe('sessionIdFromStdin', () => {
  it('parses JSON and survives truncated input', () => {
    expect(sessionIdFromStdin('{"session_id":"abc","model":{}}')).toBe('abc');
    expect(sessionIdFromStdin('{"session_id": "abc", "transcript_pa')).toBe('abc');
    expect(sessionIdFromStdin('')).toBeNull();
    expect(sessionIdFromStdin('garbage')).toBeNull();
  });
});

describe('runStatusline (reads the store, no locks)', () => {
  const run = async (stdin) => {
    let out = '';
    const stdout = new Writable({ write: (c, _e, cb) => ((out += c), cb()) });
    await runStatusline({ stdin, stdout, readTimeoutMs: 30 });
    return out;
  };

  it('prints the summary line for real review files', async () => {
    const content = '# P\nx\ny';
    const a = await createReview({ kind: 'plan', sessionId: 's1', cwd: '/x', content, source: 'ExitPlanMode' });
    const b = await createReview({ kind: 'doc', docPath: '/x/a.md', sessionId: 's1', cwd: '/x', content, source: 'Write' });
    await addThread(b.id, { anchor: makeAnchor(content, { startLine: 2, endLine: 2 }, 1), text: 'q', send: true });
    await replyToThread(b.id, 't1', 'a');
    await completeRound(b.id); // -> answered
    expect(await run(Readable.from([JSON.stringify({ session_id: 's1' })]))).toBe('rd: 1 plan to review · 1 answered\n');
    expect(await run(Readable.from([JSON.stringify({ session_id: 'other' })]))).toBe('');
    await approveReview(a.id);
    expect(await run(Readable.from(['']))).toBe('rd: 1 answered\n');
  });

  it('does not hang when stdin never closes', async () => {
    const stdin = new PassThrough(); // open, silent
    const t0 = Date.now();
    expect(await run(stdin)).toBe('');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('prints nothing with no store at all, and skips broken review directories', async () => {
    expect(await run(Readable.from(['']))).toBe('');
    fs.mkdirSync(path.join(paths.reviewsDir(), 'junk'), { recursive: true });
    fs.mkdirSync(path.join(paths.reviewsDir(), 'bad'), { recursive: true });
    fs.writeFileSync(path.join(paths.reviewsDir(), 'bad', 'meta.json'), '{oops');
    expect(readMetasLight()).toEqual([]);
    expect(await run(Readable.from(['']))).toBe('');
    expect(home()).toBeTruthy();
  });
});

describe('M2 additions: feedback waiting and instant Q&A', () => {
  it('counts feedback_pending as awaiting delivery and shows instant Q&A while a rd await is alive', () => {
    expect(summarize([m('doc', 'feedback_pending')])).toBe('rd: 1 awaiting delivery');
    expect(summarize([m('doc', 'awaiting_review'), m('doc', 'feedback_pending'), m('doc', 'feedback_pending')], undefined, { awaiting: true })).toBe('rd: 1 doc to review · 2 awaiting delivery · instant Q&A');
    expect(summarize([], 's1', { awaiting: true })).toBe('rd: instant Q&A');
    expect(summarize([m('doc', 'feedback_pending', 'other')], 's1')).toBe('');
  });

  it('reads the awaiting record of the session from sessions.json (live pid only)', async () => {
    const { sessionAwaiting } = await import('../src/cli/statusline.js');
    const { updateSession } = await import('../src/store/sessions.js');
    expect(sessionAwaiting('s1')).toBe(false);
    await updateSession('s1', { awaiting: { reviewId: null, since: 'now', pid: process.pid } });
    expect(sessionAwaiting('s1')).toBe(true);
    expect(sessionAwaiting('s2')).toBe(false);
    expect(sessionAwaiting(null)).toBe(false);
    await updateSession('s1', { awaiting: { reviewId: null, since: 'now', pid: 2 ** 22 + 99 } });
    expect(sessionAwaiting('s1')).toBe(false);
    await updateSession('s1', { awaiting: { reviewId: null, since: 'now', pid: process.pid } });
    const content = '# P\nx\ny';
    const b = await createReview({ kind: 'doc', docPath: '/x/a.md', sessionId: 's1', cwd: '/x', content, source: 'Write' });
    await addThread(b.id, { anchor: makeAnchor(content, { startLine: 2, endLine: 2 }, 1), text: 'q', send: true });
    let out = '';
    await runStatusline({ stdin: Readable.from([JSON.stringify({ session_id: 's1' })]), stdout: new Writable({ write: (c, _e, cb) => ((out += c), cb()) }), readTimeoutMs: 30 });
    expect(out).toBe('rd: 1 awaiting delivery · instant Q&A\n');
  });
});

describe('wake-up watcher', () => {
  it('shows auto-delivery only while the session has an unfinished review and no rd await is shown', () => {
    expect(summarize([m('doc', 'awaiting_review')], 's1', { watching: true })).toBe('rd: 1 doc to review · auto-delivery');
    expect(summarize([m('doc', 'delivered')], 's1', { watching: true })).toBe('rd: auto-delivery'); // Claude is answering, comments still arrive
    expect(summarize([], 's1', { watching: true })).toBe(''); // every session has a watcher: no review, no mark
    expect(summarize([m('doc', 'closed'), m('plan', 'approved')], 's1', { watching: true })).toBe('');
    expect(summarize([m('doc', 'awaiting_review', 'other')], 's1', { watching: true })).toBe('');
    expect(summarize([m('doc', 'feedback_pending')], 's1', { awaiting: true, watching: true })).toBe('rd: 1 awaiting delivery · instant Q&A');
    expect(summarize([m('doc', 'awaiting_review')], 's1')).toBe('rd: 1 doc to review');
  });

  it('reads the watcher record of the session (live pid only) and prints it', async () => {
    const { sessionWatching } = await import('../src/cli/statusline.js');
    const { updateSession } = await import('../src/store/sessions.js');
    await updateSession('s1', { watcher: { since: 'now', pid: process.pid } });
    expect(sessionWatching('s1')).toBe(true);
    expect(sessionWatching('s2')).toBe(false);
    expect(sessionWatching(null)).toBe(false);
    const content = '# P\nx\ny';
    await createReview({ kind: 'doc', docPath: '/x/a.md', sessionId: 's1', cwd: '/x', content, source: 'Write' });
    let out = '';
    await runStatusline({ stdin: Readable.from([JSON.stringify({ session_id: 's1' })]), stdout: new Writable({ write: (c, _e, cb) => ((out += c), cb()) }), readTimeoutMs: 30 });
    expect(out).toBe('rd: 1 doc to review · auto-delivery\n');
    await updateSession('s1', { watcher: { since: 'now', pid: 2 ** 22 + 99 } });
    expect(sessionWatching('s1')).toBe(false);
  });
});
