// The wake-up watcher (`rd hook watch`): delivery/watch.js and its hook entry hooks/watch.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { runWatch } from '../src/delivery/watch.js';
import watchHook, { watchedByOther } from '../src/hooks/watch.js';
import { dispatchHook } from '../src/hooks/index.js';
import { HookExit } from '../src/hooks/result.js';
import { createReview, getMeta, withReview } from '../src/store/reviews.js';
import { addThread, replyToThread } from '../src/store/threads.js';
import { approveReview } from '../src/store/lifecycle.js';
import { getSession, updateSession } from '../src/store/sessions.js';
import { takeUnreceived } from '../src/store/outbox.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';
import { LEAD_WATCH } from '../src/feedback/instructions.js';

const home = useTempHome();
const SID = 'watch-session';
const content = ['# Report', '', 'Risk is low.', 'Takes two weeks.'].join('\n');
const anchor = (line) => makeAnchor(content, { startLine: line, endLine: line }, 1);
const doc = (over = {}) => createReview({ kind: 'doc', docPath: '/w/docs/a.md', sessionId: SID, cwd: '/w', content, source: 'Write', ...over });
const plan = () => createReview({ kind: 'plan', sessionId: SID, cwd: '/w', content, source: 'ExitPlanMode' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEAD_PID = 2 ** 22 + 777;
const outbox = (id) => readJson(paths.outbox(id), []);
const watcherRecord = () => getSession(SID)?.watcher;

const fast = (over = {}) => ({ env: {}, claude: { pid: process.pid, via: 'env', startTime: null }, isClaudeAlive: () => true, pollMs: 10, ...over });
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
/** Run a watcher that has nothing to deliver for `ms`, then stop it. */
async function watchFor(ms, over = {}) {
  const controller = new AbortController();
  const run = runWatch({ session_id: SID }, fast({ signal: controller.signal, ...over }));
  await sleep(ms);
  controller.abort();
  return run;
}

describe('watcher: registration and delivery', () => {
  it('registers the watcher record, waits, and on feedback clears the record, marks it received (via watch) and returns the text', async () => {
    const { id } = await doc();
    const run = runWatch({ session_id: SID }, fast());
    const rec = await waitFor(watcherRecord);
    expect(rec).toMatchObject({ pid: process.pid });
    expect(rec.since).toBeTruthy();
    await sleep(40);
    expect(watcherRecord()).toBeTruthy(); // nothing to deliver yet: still watching

    await addThread(id, { anchor: anchor(3), text: 'why is the risk low?', send: true });
    const r = await run;
    expect(r.result).toBe('delivered');
    expect(r.reviewIds).toEqual([id]);
    expect(watcherRecord()).toBeUndefined(); // cleared before the text is handed out
    expect(r.output).toContain(LEAD_WATCH);
    expect(r.output).toContain('this is not an error');
    expect(r.output).toContain(`# Review feedback · ${id} · round 1`);
    expect(r.output).toContain('**User:** why is the risk low?');
    expect(r.output).toContain(`rd reply ${id} <threadId> <<'EOF'`);
    expect(r.output).toContain(`rd done ${id}`);
    expect(r.output).toContain('do NOT start `rd await`');
    expect(r.output).not.toContain('run_in_background');
    expect(outbox(id)[0]).toMatchObject({ deliveredVia: 'watch' });
    expect(outbox(id)[0].receivedAt).toBeTruthy();
    expect(getMeta(id).status).toBe('delivered');
  });

  it('delivers what is already waiting at start, from every review of the session and no other session\'s', async () => {
    const a = await doc();
    const b = await doc({ docPath: '/w/docs/b.md' });
    const other = await doc({ docPath: '/w/docs/c.md', sessionId: 'someone-else' });
    for (const r of [a, b, other]) await addThread(r.id, { anchor: anchor(3), text: `q ${r.id}`, send: true });
    const r = await runWatch({ session_id: SID }, fast());
    expect(r.reviewIds.sort()).toEqual([a.id, b.id].sort());
    expect(r.output).not.toContain(other.id);
    expect(outbox(other.id)[0].receivedAt).toBeUndefined();
  });

  it('delivers whatever the recorded state says (a busy session gets it at the next tool boundary, a stale busy after Esc too)', async () => {
    const { id } = await doc();
    await updateSession(SID, { state: 'busy', stateSince: new Date().toISOString() });
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    expect((await runWatch({ session_id: SID }, fast())).result).toBe('delivered');
  });

  it('a message another channel took first is not delivered twice', async () => {
    const { id } = await doc();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    expect(await takeUnreceived(id, { via: 'A' })).toBeTruthy();
    const r = await watchFor(60);
    expect(r.result).toBe('aborted');
    expect(outbox(id)[0].deliveredVia).toBe('A');
  });

  it('feedback sent while Claude answers (queued behind a received entry) is delivered by the next watcher', async () => {
    const { id } = await doc();
    await addThread(id, { anchor: anchor(3), text: 'first', send: true });
    expect((await runWatch({ session_id: SID }, fast())).result).toBe('delivered');
    await replyToThread(id, 't1', 'answer');
    const { addUserMessage } = await import('../src/store/threads.js');
    await addUserMessage(id, 't1', { text: 'second', send: true });
    const r = await runWatch({ session_id: SID }, fast());
    expect(r.result).toBe('delivered');
    expect(r.output).toContain('**User:** second');
    expect(r.output).toContain('**Claude (round 1):** answer');
  });
});

describe('watcher: what it leaves to others', () => {
  it('skips a plan review whose blocking hook is alive (its deny message delivers) and takes it once the hook is gone', async () => {
    const { id } = await plan();
    await addThread(id, { anchor: anchor(3), text: 'plan question', send: true });
    await withReview(id, (ctx) => {
      ctx.meta.hook = { pid: process.pid, since: new Date().toISOString() };
    });
    const idle = await watchFor(80);
    expect(idle.result).toBe('aborted');
    expect(outbox(id)[0].receivedAt).toBeUndefined();
    await withReview(id, (ctx) => {
      delete ctx.meta.hook;
    });
    const r = await runWatch({ session_id: SID }, fast());
    expect(r.result).toBe('delivered');
    expect(r.output).toContain('plan question');
    expect(r.output).toContain('call ExitPlanMode again with the full revised plan');
    expect(r.output).not.toContain('BACKGROUND');
    expect(r.output).toContain('do NOT start `rd await`');
  });

  it('skips the reviews a live model-started `rd await` covers: all of them, or only its --review', async () => {
    const a = await doc();
    const b = await doc({ docPath: '/w/docs/b.md' });
    for (const r of [a, b]) await addThread(r.id, { anchor: anchor(3), text: `q ${r.id}`, send: true });
    await updateSession(SID, { awaiting: { reviewId: null, since: 'now', pid: process.ppid, startTime: null } });
    expect((await watchFor(80)).result).toBe('aborted');
    expect(outbox(a.id)[0].receivedAt).toBeUndefined();
    expect(outbox(b.id)[0].receivedAt).toBeUndefined();

    await updateSession(SID, { awaiting: { reviewId: a.id, since: 'now', pid: process.ppid, startTime: null } });
    const r = await runWatch({ session_id: SID }, fast());
    expect(r.reviewIds).toEqual([b.id]); // a is the await's business
    expect(outbox(a.id)[0].receivedAt).toBeUndefined();

    // a dead await record does not cover anything
    await updateSession(SID, { awaiting: { reviewId: null, since: 'old', pid: DEAD_PID } });
    expect((await runWatch({ session_id: SID }, fast())).reviewIds).toEqual([a.id]);
  });

  it('a different session\'s watcher record or review is none of its business', async () => {
    const other = await doc({ sessionId: 'someone-else' });
    await addThread(other.id, { anchor: anchor(3), text: 'q', send: true });
    expect((await watchFor(60)).result).toBe('aborted');
    expect(outbox(other.id)[0].receivedAt).toBeUndefined();
  });
});

describe('watcher: approved plan (approvedPendingExit)', () => {
  it('tells Claude to call ExitPlanMode once per approval, also across watcher restarts', async () => {
    const { id } = await plan();
    await approveReview(id); // no hook alive: approvedPendingExit
    expect(getMeta(id).approvedPendingExit).toBe(true);
    const r = await runWatch({ session_id: SID }, fast());
    expect(r.result).toBe('delivered');
    expect(r.reviewIds).toEqual([id]);
    expect(r.output).toContain('The user approved your plan in Review Desk');
    expect(r.output).toContain('Call ExitPlanMode now with the plan you submitted, unchanged');
    expect(r.output).toContain('this is not an error');
    expect(getMeta(id).exitNotifiedAt).toBeTruthy();
    expect(getMeta(id).approvedPendingExit).toBe(true); // the plan-review hook consumes it

    // a restarted watcher (the next Stop) does not announce it again
    expect((await watchFor(80)).result).toBe('aborted');
    expect((await watchFor(40)).result).toBe('aborted');
  });

  it('stays silent when the approval was consumed, came from the native dialog, or a live hook was waiting', async () => {
    const { id } = await plan();
    await withReview(id, (ctx) => {
      ctx.meta.hook = { pid: process.pid, since: new Date().toISOString() };
    });
    await approveReview(id); // the hook is alive: it returns allow itself
    expect(getMeta(id).approvedPendingExit).toBeUndefined();
    const native = await plan();
    await approveReview(native.id, { via: 'native' });
    expect((await watchFor(80)).result).toBe('aborted');
  });

  it('does not announce an approval a live `rd await` covers (it prints end-plan)', async () => {
    const { id } = await plan();
    await approveReview(id);
    await updateSession(SID, { awaiting: { reviewId: id, since: 'now', pid: process.ppid, startTime: null } });
    expect((await watchFor(80)).result).toBe('aborted');
    expect(getMeta(id).exitNotifiedAt).toBeUndefined();
  });
});

describe('watcher: singleton, exits and cleanup', () => {
  it('a second watcher for the session exits at once; a dead record is replaced', async () => {
    await updateSession(SID, { watcher: { since: 'now', pid: process.ppid, startTime: null } });
    expect(watchedByOther(getSession(SID))).toBe(true);
    const second = await runWatch({ session_id: SID }, fast());
    expect(second.result).toBe('already-watching');
    expect(watcherRecord().pid).toBe(process.ppid); // untouched
    // the hook entry does not even load the loop
    expect(await watchHook({ session_id: SID }, fast())).toBeUndefined();

    await updateSession(SID, { watcher: { since: 'old', pid: DEAD_PID, startTime: null } });
    expect(watchedByOther(getSession(SID))).toBe(false);
    const { id } = await doc();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    expect((await runWatch({ session_id: SID }, fast())).result).toBe('delivered');
  });

  it('a signal ends it silently and clears its own record only', async () => {
    const controller = new AbortController();
    const run = runWatch({ session_id: SID }, fast({ signal: controller.signal }));
    await waitFor(watcherRecord);
    controller.abort();
    expect(await run).toMatchObject({ result: 'aborted', output: null });
    expect(watcherRecord()).toBeUndefined();
  });

  it('exits silently when the session record says ended (/clear does not signal the old watcher)', async () => {
    const { id } = await doc();
    const run = runWatch({ session_id: SID }, fast());
    await waitFor(watcherRecord);
    await addThread(id, { anchor: anchor(3), text: 'q', send: false }); // a draft: not delivered
    const at = new Date().toISOString();
    await updateSession(SID, { state: 'ended', stateSince: at, endedAt: at, endReason: 'clear', watcher: undefined });
    const r = await run;
    expect(r).toMatchObject({ result: 'ended', output: null });
    expect(watcherRecord()).toBeUndefined();
  });

  it('a session that was ended BEFORE this watcher started (a resume racing SessionStart) is not "ended"', async () => {
    const before = '2026-11-01T00:00:00.000Z';
    await updateSession(SID, { state: 'ended', stateSince: before, endedAt: before });
    const controller = new AbortController();
    const run = runWatch({ session_id: SID }, fast({ signal: controller.signal }));
    await waitFor(watcherRecord);
    await sleep(60);
    expect(watcherRecord()).toBeTruthy(); // still there
    await updateSession(SID, { state: 'idle', stateSince: new Date().toISOString(), endedAt: undefined, endReason: undefined }); // SessionStart
    await sleep(40);
    expect(watcherRecord()).toBeTruthy();
    const end = new Date().toISOString();
    await updateSession(SID, { state: 'ended', stateSince: end, endedAt: end });
    expect((await run).result).toBe('ended');
    controller.abort();
  });

  it('exits when the claude process is gone', async () => {
    let alive = true;
    const run = runWatch({ session_id: SID }, fast({ isClaudeAlive: () => alive }));
    await waitFor(watcherRecord);
    alive = false;
    expect(await run).toMatchObject({ result: 'orphaned', output: null });
    expect(watcherRecord()).toBeUndefined();
  });

  it('registers again when its record was wiped (SessionStart clears records of a previous claude process)', async () => {
    const controller = new AbortController();
    const run = runWatch({ session_id: SID }, fast({ signal: controller.signal }));
    await waitFor(watcherRecord);
    await updateSession(SID, { watcher: undefined });
    expect((await waitFor(watcherRecord)).pid).toBe(process.pid);
    controller.abort();
    await run;
  });

  it('stands down (and leaves the record alone) when another live watcher took the registration', async () => {
    const run = runWatch({ session_id: SID }, fast());
    await waitFor(watcherRecord);
    await updateSession(SID, { watcher: { since: 'now', pid: process.ppid, startTime: null } });
    expect((await run).result).toBe('superseded');
    expect(watcherRecord().pid).toBe(process.ppid);
  });

  it('does nothing for a headless run, an invalid or missing session id', async () => {
    expect((await runWatch({ session_id: SID }, fast({ env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }))).result).toBe('skipped');
    expect((await runWatch({ session_id: SID }, fast({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }))).result).toBe('skipped');
    expect((await runWatch({ session_id: '--bad' }, fast())).result).toBe('skipped');
    expect((await runWatch({}, fast())).result).toBe('skipped');
    expect(await watchHook({ session_id: SID }, fast({ env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } }))).toBeUndefined();
    expect(getSession(SID)).toBeNull();
  });
});

describe('watcher: the hook entry and the dispatcher', () => {
  it('a delivery becomes HookExit(2, text); no delivery is undefined (exit 0)', async () => {
    const { id } = await doc();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    const out = await dispatchHook('watch', { session_id: SID }, fast());
    expect(out).toBeInstanceOf(HookExit);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain(LEAD_WATCH);
    const none = new AbortController();
    const p = dispatchHook('watch', { session_id: SID }, fast({ signal: none.signal }));
    await sleep(40);
    none.abort();
    expect(await p).toBeUndefined();
  });

  it('an error never produces exit 2: it is logged and the result stays empty', async () => {
    let calls = 0;
    const out = await dispatchHook(
      'watch',
      { session_id: SID },
      fast({
        isClaudeAlive: () => {
          calls++;
          throw new Error('boom');
        },
      }),
    );
    expect(out).toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(10); // retried before giving up
    expect(fs.readFileSync(paths.log(), 'utf8')).toMatch(/\[hook watch\] ERROR Error: boom/);
    expect(watcherRecord()).toBeUndefined();
  });
});

describe('rd hook watch as a process (bin/rd.js)', () => {
  const BIN = path.resolve('bin/rd.js');
  const children = new Set();
  afterEach(() => {
    for (const c of children) c.kill('SIGKILL');
    children.clear();
  });
  function start(input, env = {}) {
    const child = spawn(process.execPath, [BIN, 'hook', 'watch'], {
      env: { ...process.env, RD_HOME: home(), CLAUDE_PID: String(process.pid), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(JSON.stringify(input));
    const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, done };
  }

  it('exits with code 2 and the text on stderr (nothing on stdout) when feedback arrives; the record is gone', async () => {
    const { id } = await doc();
    const w = start({ session_id: SID, hook_event_name: 'Stop', cwd: '/w' });
    await waitFor(() => getSession(SID)?.watcher?.pid);
    await addThread(id, { anchor: anchor(3), text: 'wake up please', send: true });
    const r = await w.done;
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('wake up please');
    expect(r.stderr).toContain('this is not an error');
    expect(watcherRecord()).toBeUndefined();
  });

  it('SIGTERM (/exit) ends it with code 0, silently, and clears the record; a second one exits at once', async () => {
    const w = start({ session_id: SID });
    const pid = await waitFor(() => getSession(SID)?.watcher?.pid);
    expect(pid).toBe(w.child.pid);
    const t0 = Date.now();
    const second = await start({ session_id: SID }).done; // another Stop
    expect(second).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(watcherRecord().pid).toBe(pid);
    w.child.kill('SIGTERM');
    expect(await w.done).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(watcherRecord()).toBeUndefined();
  });

  it('bad stdin, a headless run and an unusable RD_HOME all end with code 0 and no output', async () => {
    const bad = spawn(process.execPath, [BIN, 'hook', 'watch'], { env: { ...process.env, RD_HOME: home() }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(bad);
    bad.stdin.end('not json');
    const code = await new Promise((resolve) => bad.on('close', resolve));
    expect(code).toBe(0);
    const headless = await start({ session_id: SID }, { CLAUDE_CODE_SESSION_ATTENDED: '0' }).done;
    expect(headless).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });
});
