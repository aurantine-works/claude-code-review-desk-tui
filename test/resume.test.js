// Delivery channel C: resumeInfo, headless resume (fake claude), SessionStart notice, headless-aware hooks and instructions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { installFakeClaude } from './helpers/fake-claude.js';
import { dispatchHook } from '../src/hooks/index.js';
import { resumeNotice } from '../src/hooks/session-start.js';
import { createReview, getMeta } from '../src/store/reviews.js';
import { addThread, listThreads } from '../src/store/threads.js';
import { approveReview } from '../src/store/lifecycle.js';
import { takeUnreceived } from '../src/store/outbox.js';
import { getSession, updateSession } from '../src/store/sessions.js';
import { readProc } from '../src/store/proc.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';
import { planDelivery } from '../src/delivery/index.js';
import { resumeInfo, startHeadless, headlessStatus, createResumeWatcher, shellQuote, HEADLESS_ALLOWED_TOOLS } from '../src/delivery/resume.js';
import { runAwait } from '../src/delivery/await.js';
import { renderInstructions, renderInjection, renderSlashCommand, renderResumeNotice, LEAD_HEADLESS } from '../src/feedback/instructions.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const home = useTempHome();
const SID = '11111111-2222-4333-8444-555555555555';
const RD_BIN = path.resolve('bin/rd.js');
const DEAD_PID = 2 ** 22 + 4242;
const content = ['# Report', '', 'Risk is low.', 'Takes two weeks.'].join('\n');
const anchor = (line) => makeAnchor(content, { startLine: line, endLine: line }, 1);
let work;
let fake;
const saved = {};

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-resume-'));
  fake = installFakeClaude(work);
  fs.mkdirSync(path.join(work, 'proj'));
  for (const k of ['FAKE_CLAUDE_OUT', 'FAKE_CLAUDE_EXIT', 'FAKE_CLAUDE_SLEEP_MS', 'FAKE_CLAUDE_HOOKS']) saved[k] = process.env[k];
  process.env.FAKE_CLAUDE_OUT = path.join(work, 'out.json');
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  fs.rmSync(work, { recursive: true, force: true });
});

const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, claudeBin: fake.bin, ...over } });
const ended = (over = {}) => updateSession(SID, { cwd: path.join(work, 'proj'), pid: DEAD_PID, state: 'ended', injector: { kind: 'none' }, ...over });
const doc = (over = {}) => createReview({ kind: 'doc', docPath: '/w/docs/a.md', sessionId: SID, cwd: '/somewhere/else', content, source: 'Write', turn: 1, ...over });
async function waiting(over) {
  const m = await doc(over);
  await addThread(m.id, { anchor: anchor(3), text: 'why is the risk low?', send: true });
  return m;
}
const out = () => JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_OUT, 'utf8'));

describe('resumeInfo', () => {
  it('interactive command, headless argv and log path; cwd comes from the session record, then the review', async () => {
    const m = await doc();
    expect(resumeInfo(m.id, { config: DEFAULT_CONFIG })).toMatchObject({
      reviewId: m.id,
      sessionId: SID,
      cwd: '/somewhere/else',
      interactive: `cd /somewhere/else && claude --resume ${SID}`,
      headlessArgv: ['claude', '--resume', SID, '-p', `/review-reply ${m.id}`, '--allowedTools', HEADLESS_ALLOWED_TOOLS],
      log: path.join(home(), 'logs', `headless-${m.id}.log`),
    });
    await ended({ cwd: '/work/proj' });
    expect(resumeInfo(m.id).cwd).toBe('/work/proj');
  });

  it('allowed tools: show / reply / done and file tools; never rd await or a bare Bash', () => {
    expect(HEADLESS_ALLOWED_TOOLS.split(',')).toEqual(['Bash(rd show:*)', 'Bash(rd reply:*)', 'Bash(rd done:*)', 'Read', 'Edit', 'MultiEdit', 'Write']);
  });

  it('shell-quotes the display command; claudeBin overrides the executable', async () => {
    expect(shellQuote('/a b/it\'s')).toBe(`'/a b/it'\\''s'`);
    expect(shellQuote('plain-1.2/x')).toBe('plain-1.2/x');
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    const m = await doc({ cwd: '/my dir; touch x' });
    const info = resumeInfo(m.id, { config: cfg({ claudeBin: '/opt/claude code/bin/claude' }) });
    expect(info.interactive).toBe(`cd '/my dir; touch x' && '/opt/claude code/bin/claude' --resume ${SID}`);
    expect(info.headlessArgv[0]).toBe('/opt/claude code/bin/claude');
    expect(resumeInfo(m.id, { config: cfg({ claudeBin: '  ' }) }).headlessArgv[0]).toBe('claude'); // blank config falls back
  });

  it('rejects invalid ids and reviews without a session; a session id that could read as an option is never passed on', async () => {
    expect(() => resumeInfo('../../etc')).toThrow(/invalid review id/);
    for (const evil of ['--dangerously-skip-permissions', '-p', '..', '.hidden']) {
      const m = await doc({ sessionId: evil, docPath: `/w/${evil}.md` });
      expect(() => resumeInfo(m.id)).toThrow(/invalid session id/);
      expect(await startHeadless(m.id)).toMatchObject({ ok: false });
    }
    const m = await doc({ sessionId: undefined });
    expect(() => resumeInfo(m.id)).toThrow(/no session/);
    const bad = await doc({ sessionId: 'a b' });
    expect(() => resumeInfo(bad.id)).toThrow(/invalid session id/);
  });
});

describe('startHeadless', () => {
  it('spawns claude --resume <sid> -p "/review-reply <id>" in the session directory, detached, stdin /dev/null, output into the log', async () => {
    await ended();
    const m = await waiting();
    process.env.FAKE_CLAUDE_EXIT = '0';
    const r = await startHeadless(m.id, { config: cfg(), env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'parent-session', CLAUDE_PID: '1234', TMUX_PANE: '%9', CLAUDE_CODE_ENTRYPOINT: 'cli' } });
    expect(r).toMatchObject({ ok: true, sessionId: SID, cwd: path.join(work, 'proj'), log: path.join(home(), 'logs', `headless-${m.id}.log`) });
    expect(Number.isInteger(r.pid)).toBe(true);
    // recorded before the process ends
    expect(getMeta(m.id).headless).toMatchObject({ pid: r.pid, log: r.log });
    expect(headlessStatus(m.id)).toMatchObject({ pid: r.pid });

    expect(await r.exited).toEqual({ exitCode: 0, signal: null });
    const run = out();
    expect(run.argv).toEqual(['--resume', SID, '-p', `/review-reply ${m.id}`, '--allowedTools', HEADLESS_ALLOWED_TOOLS]);
    expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(path.join(work, 'proj')));
    expect(run.stdin).toBe(''); // /dev/null
    // the environment of the caller's own claude does not leak into the resumed one; RD_HOME does
    expect(run.env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
    expect(run.env).not.toHaveProperty('CLAUDE_PID');
    expect(run.env).not.toHaveProperty('TMUX_PANE');
    expect(run.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(run.env.RD_HOME).toBe(home());

    const log = fs.readFileSync(r.log, 'utf8');
    expect(log).toContain(`rd headless resume · review ${m.id} · session ${SID}`);
    expect(log).toContain('fake-claude started');
    expect(log).toContain('fake-claude stderr line');
    expect(fs.statSync(r.log).mode & 0o777).toBe(0o600);

    const meta = getMeta(m.id);
    expect(meta.headless).toMatchObject({ pid: r.pid, startedAt: expect.any(String), exitCode: 0 });
    expect(meta.headless.exitedAt).toBeTruthy();
    // nothing fetched the feedback (the fake did not fire hooks): finished, but flagged failed because it is still waiting
    expect(headlessStatus(m.id)).toMatchObject({ state: 'failed', exitCode: 0, unreceived: 1, pending: 1 });
    expect(meta.status).toBe('feedback_pending'); // starting a resume does not change the review's state
  });

  it('appends to the log of an earlier run; a non-zero exit is a failure', async () => {
    await ended();
    const m = await waiting();
    process.env.FAKE_CLAUDE_EXIT = '3';
    const a = await startHeadless(m.id, { config: cfg() });
    expect(await a.exited).toMatchObject({ exitCode: 3 });
    expect(headlessStatus(m.id)).toMatchObject({ state: 'failed', exitCode: 3 });
    const b = await startHeadless(m.id, { config: cfg() }); // the first run ended: a second one is allowed
    await b.exited;
    expect(fs.readFileSync(a.log, 'utf8').split('=== ').length - 1).toBe(2);
  });

  it('the whole loop through the real hooks: the feedback arrives by channel A with a non-interactive note, is answered and done', async () => {
    await ended();
    const m = await waiting();
    process.env.FAKE_CLAUDE_HOOKS = RD_BIN;
    const r = await startHeadless(m.id, { config: cfg() });
    expect(r.ok).toBe(true);
    expect((await r.exited).exitCode).toBe(0);
    const run = out();

    // prompt-submit (channel A) attached the feedback; the prompt was /review-reply, so the command carries the instructions
    expect(run.context).toContain(LEAD_HEADLESS);
    expect(run.context).toContain('**User:** why is the risk low?');
    expect(run.context).not.toContain('How to handle review');
    expect(run.hooks.sessionStart).toBe(''); // no "feedback is waiting" notice in a headless run
    expect(run.reply).toContain('replied t1');

    const outbox = readJson(paths.outbox(m.id), []);
    expect(outbox).toEqual([]); // rd done removed the received entry
    expect(getMeta(m.id).status).toBe('answered');
    expect(listThreads(m.id)[0].messages.map((x) => x.author)).toEqual(['user', 'claude']);
    expect(listThreads(m.id)[0].messages[1].text).toBe('headless answer for t1');
    // the headless run left the session ended (its SessionEnd), flag included
    expect(getSession(SID)).toMatchObject({ state: 'ended', headless: true });
    expect(headlessStatus(m.id)).toMatchObject({ state: 'finished', exitCode: 0, unreceived: 0, pending: 0 });
    expect(planDelivery(m.id, { config: DEFAULT_CONFIG }).channel).toBe('C'); // session-ended again
  });

  it('refuses: finished review, no session, session alive, nothing waiting, live headless, missing directory', async () => {
    await ended();
    const m = await waiting();
    const cfgOk = { config: cfg() };

    expect(await startHeadless(m.id, { config: cfg({ claudeBin: path.join(work, 'nope') }) })).toMatchObject({ ok: false, reason: 'spawn-failed' });
    expect(readJson(paths.meta(m.id)).headless).toBeUndefined(); // a failed start records nothing
    expect(fs.readFileSync(path.join(home(), 'logs', `headless-${m.id}.log`), 'utf8')).toContain('could not start');

    await updateSession(SID, { state: 'idle', pid: process.pid });
    expect(await startHeadless(m.id, cfgOk)).toMatchObject({ ok: false, reason: 'session-alive' });
    await updateSession(SID, { headless: true });
    expect(await startHeadless(m.id, cfgOk)).toMatchObject({ ok: false, reason: 'headless-running' });
    await updateSession(SID, { headless: undefined, state: 'ended', pid: DEAD_PID });

    // another review of the session has a live headless run
    const other = await waiting({ docPath: '/w/docs/b.md' });
    const startTime = readProc(process.pid).startTime;
    const { withReview } = await import('../src/store/reviews.js');
    await withReview(other.id, (ctx) => void (ctx.meta.headless = { pid: process.pid, startTime, startedAt: 'x', log: 'x' }));
    expect(await startHeadless(m.id, cfgOk)).toMatchObject({ ok: false, reason: 'headless-running' });
    // ... but one whose process is gone does not block
    await withReview(other.id, (ctx) => void (ctx.meta.headless.pid = DEAD_PID));
    await withReview(other.id, (ctx) => void (ctx.meta.headless.startTime = null));
    const ok = await startHeadless(m.id, cfgOk);
    expect(ok.ok).toBe(true);
    await ok.exited;

    await ended({ cwd: path.join(work, 'gone') });
    expect(await startHeadless(m.id, cfgOk)).toMatchObject({ ok: false, reason: 'cwd-missing' });
    await ended({ cwd: undefined });
    const noCwd = await doc({ cwd: undefined, docPath: '/w/docs/c.md' });
    await addThread(noCwd.id, { anchor: anchor(3), text: 'q', send: true });
    expect(await startHeadless(noCwd.id, cfgOk)).toMatchObject({ ok: false, reason: 'cwd-missing' });

    const empty = await doc({ docPath: '/w/docs/d.md' });
    expect(await startHeadless(empty.id, cfgOk)).toMatchObject({ ok: false, reason: 'nothing-waiting' });
    await takeUnreceived(m.id, { via: 'A' });
    expect(await startHeadless(m.id, cfgOk)).toMatchObject({ ok: false, reason: 'nothing-waiting' }); // received already

    const nosess = await createReview({ kind: 'doc', docPath: '/w/docs/e.md', cwd: '/w', content, source: 'Write' });
    expect(await startHeadless(nosess.id, cfgOk)).toMatchObject({ ok: false, reason: 'no-session' });
    await approveReview(other.id);
    expect(await startHeadless(other.id, cfgOk)).toMatchObject({ ok: false, reason: 'review-finished' });
    await expect(startHeadless('doc-1', cfgOk)).rejects.toThrow(/invalid review id/);
  });

  it('two starts at once launch one process', async () => {
    await ended();
    const m = await waiting();
    const m2 = await waiting({ docPath: '/w/docs/b.md' });
    process.env.FAKE_CLAUDE_SLEEP_MS = '400';
    const [a, b] = await Promise.all([startHeadless(m.id, { config: cfg() }), startHeadless(m2.id, { config: cfg() })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok).reason).toBe('headless-running');
    await [a, b].find((x) => x.ok).exited;
  });

  it('headlessStatus: running while the process lives, nothing without a run', async () => {
    await ended();
    const m = await waiting();
    expect(headlessStatus(m.id)).toBeNull();
    process.env.FAKE_CLAUDE_SLEEP_MS = '600';
    const r = await startHeadless(m.id, { config: cfg() });
    expect(headlessStatus(m.id)).toMatchObject({ state: 'running', pid: r.pid, exitedAt: null });
    await r.exited;
    expect(headlessStatus(m.id).state).not.toBe('running');
    // without an exit record (rd was gone when it ended) a dead pid still reads as ended
    const { withReview } = await import('../src/store/reviews.js');
    await withReview(m.id, (ctx) => void (ctx.meta.headless = { pid: DEAD_PID, startTime: null, startedAt: 'x', log: 'l' }));
    expect(headlessStatus(m.id)).toMatchObject({ state: 'failed', exitCode: null, exitedAt: null }); // feedback still unreceived
    await takeUnreceived(m.id, { via: 'A' });
    expect(headlessStatus(m.id)).toMatchObject({ state: 'finished' });
  });
});

describe('headlessStatus: a finished run is only the news until something else happens', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const later = (iso, ms = 5000) => new Date(Date.parse(iso) + ms).toISOString();

  /** A headless run that answered its thread (real hooks through the fake claude) and ended with exit 0. */
  async function answeredRun() {
    await ended();
    const m = await waiting();
    process.env.FAKE_CLAUDE_HOOKS = RD_BIN;
    const r = await startHeadless(m.id, { config: cfg() });
    expect((await r.exited).exitCode).toBe(0);
    expect(headlessStatus(m.id)).toMatchObject({ state: 'finished', exitCode: 0, unreceived: 0, pending: 0, superseded: false });
    await sleep(15); // the next comment must be stamped after exitedAt
    return m;
  }

  it('a comment sent after a successful run is not the run failing: it is a fresh channel C situation', async () => {
    const m = await answeredRun();
    await addThread(m.id, { anchor: anchor(4), text: 'and the second line?', send: true });
    const st = headlessStatus(m.id);
    expect(st).toMatchObject({ state: 'finished', exitCode: 0, unreceived: 1, superseded: true }); // not 'failed'
    // what the dialog needs: channel C again with something queued (the TUI hides the superseded status, so [h] is offered fresh)
    expect(planDelivery(m.id, { config: DEFAULT_CONFIG })).toMatchObject({ channel: 'C', reason: 'session-ended' });
    // a second run takes the new batch
    const again = await startHeadless(m.id, { config: cfg() });
    expect(again.ok).toBe(true);
    await again.exited;
  });

  it('feedback queued before the run ended and never taken still makes it failed', async () => {
    await ended();
    const m = await waiting();
    const r = await startHeadless(m.id, { config: cfg() }); // the fake does not fetch anything
    await r.exited;
    expect(headlessStatus(m.id)).toMatchObject({ state: 'failed', exitCode: 0, unreceived: 1, superseded: false });
  });

  it('the session resumed interactively afterwards supersedes the run, whatever happens in later rounds', async () => {
    const m = await answeredRun();
    const exitedAt = getMeta(m.id).headless.exitedAt;
    // SessionStart of an interactive resume: alive again, the headless flag cleared
    await updateSession(SID, { state: 'idle', pid: process.pid, headless: undefined, stateSince: later(exitedAt) });
    expect(headlessStatus(m.id)).toMatchObject({ state: 'finished', superseded: true });
    // later rounds in that session, and the session ending again: still superseded
    await updateSession(SID, { state: 'ended', stateSince: later(exitedAt, 60_000), endedAt: later(exitedAt, 60_000) });
    expect(headlessStatus(m.id).superseded).toBe(true);
  });

  it('feedback received after the end (another channel delivered it) supersedes the run', async () => {
    const m = await answeredRun();
    await addThread(m.id, { anchor: anchor(4), text: 'next question', send: true });
    await takeUnreceived(m.id, { via: 'A', now: later(getMeta(m.id).headless.exitedAt, 1000) });
    expect(headlessStatus(m.id).superseded).toBe(true);
  });

  it('a running process is never superseded', async () => {
    await ended();
    const m = await waiting();
    process.env.FAKE_CLAUDE_SLEEP_MS = '600';
    const r = await startHeadless(m.id, { config: cfg() });
    await updateSession(SID, { state: 'idle', stateSince: later(new Date().toISOString()) });
    expect(headlessStatus(m.id)).toMatchObject({ state: 'running', superseded: false });
    await r.exited;
  });

  it('the end was never recorded (rd was closed during the run): the headless SessionEnd dates it, else the run start does', async () => {
    const { withReview } = await import('../src/store/reviews.js');
    await ended();
    const m = await waiting();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const endedAt = new Date(Date.now() + 600_000).toISOString(); // the feedback was queued before it, whatever the clock says
    await withReview(m.id, (ctx) => void (ctx.meta.headless = { pid: DEAD_PID, startTime: null, startedAt, log: 'l' }));
    await takeUnreceived(m.id, { via: 'A', now: later(endedAt, -1000) }); // the run did fetch the feedback

    // the record still belongs to the headless run: end = its SessionEnd, nothing newer
    await updateSession(SID, { headless: true, state: 'ended', stateSince: endedAt, endedAt });
    expect(headlessStatus(m.id)).toMatchObject({ state: 'finished', exitedAt: null, superseded: false });
    // a comment after that moment is a new situation
    await withReview(m.id, (ctx) => void ctx.outbox.push({ threadId: 't9', messageId: 'm9', at: later(endedAt) }));
    expect(headlessStatus(m.id)).toMatchObject({ state: 'finished', unreceived: 1, superseded: true });
    await withReview(m.id, (ctx) => void (ctx.outbox.length = 1));

    // the flag was cleared by an interactive start after the run began: superseded; an old, ended record is not
    await updateSession(SID, { headless: undefined, state: 'idle', stateSince: later(startedAt, 3_600_000) });
    expect(headlessStatus(m.id).superseded).toBe(true);
    await updateSession(SID, { headless: undefined, state: 'ended', stateSince: '2025-12-31T00:00:00.000Z' });
    expect(headlessStatus(m.id).superseded).toBe(false);
  });
});

describe('planDelivery with a headless run', () => {
  it('a live headless session stays on channel C (headless-running); an interactive start clears the flag', async () => {
    const m = await waiting();
    await updateSession(SID, { cwd: '/w', pid: process.pid, state: 'busy', injector: { kind: 'none' }, headless: true });
    expect(planDelivery(m.id, { config: DEFAULT_CONFIG })).toMatchObject({ channel: 'C', reason: 'headless-running', sessionState: 'busy' });
    await dispatchHook('session-start', { session_id: SID, cwd: '/w', source: 'resume' }, { findPid: () => process.pid, env: {} });
    expect(getSession(SID).headless).toBeUndefined();
    expect(planDelivery(m.id, { config: DEFAULT_CONFIG }).channel).toBe('A');
  });

  it('session-start in a headless environment sets the flag and never registers an injector', async () => {
    const env = { CLAUDE_CODE_SESSION_ATTENDED: '0', TMUX_PANE: '%3' };
    await dispatchHook('session-start', { session_id: SID, cwd: '/w', source: 'resume' }, { findPid: () => process.pid, env });
    expect(getSession(SID)).toMatchObject({ headless: true, injector: { kind: 'none' }, state: 'idle' });
    // the entrypoint marker alone counts as well
    await dispatchHook('session-start', { session_id: SID, cwd: '/w', source: 'resume' }, { findPid: () => process.pid, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
    expect(getSession(SID).headless).toBe(true);
  });
});

describe('SessionStart notice (resumed sessions)', () => {
  const start = (input, env = {}) => dispatchHook('session-start', { session_id: SID, cwd: '/w', ...input }, { findPid: () => process.pid, env });

  it('announces waiting feedback on resume / startup, without starting anything', async () => {
    const a = await waiting();
    const b = await waiting({ docPath: '/w/docs/b.md' });
    await addThread(b.id, { anchor: anchor(4), text: 'and the schedule?', send: true });
    const o = await start({ source: 'resume' });
    expect(o.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const text = o.hookSpecificOutput.additionalContext;
    expect(text).toContain(`${a.id} (1 thread)`);
    expect(text).toContain(`${b.id} (2 threads)`);
    expect(text).toContain('2 reviews have review feedback waiting');
    expect(text).toContain('Do not start handling it on your own');
    expect(text).toContain("attached to the user's next message");
    expect(text).toContain('/review-reply');
    expect(text).not.toContain('rd show'); // only a heads-up: no instructions to act
    expect((await start({ source: 'startup' }))?.hookSpecificOutput?.additionalContext).toContain(a.id);
    // the notice does not take the feedback: the next prompt still carries it
    const ps = await dispatchHook('prompt-submit', { session_id: SID, prompt: 'hello' }, { findPid: () => process.pid, env: {} });
    expect(ps.hookSpecificOutput.additionalContext).toContain('**User:** why is the risk low?');
    expect(await start({ source: 'resume' })).toBeUndefined(); // received now: nothing to announce
  });

  it('nothing for other sources, other sessions, finished reviews, headless runs, or when nothing waits', async () => {
    const m = await waiting();
    await waiting({ sessionId: 'another-session', docPath: '/w/docs/x.md' });
    expect(await start({ source: 'clear' })).toBeUndefined();
    expect(await start({ source: 'compact' })).toBeUndefined();
    expect(await start({ source: 'resume' }, { CLAUDE_CODE_SESSION_ATTENDED: '0' })).toBeUndefined();
    expect((await start({ source: 'resume' })).hookSpecificOutput.additionalContext).not.toContain('another-session');
    await approveReview(m.id);
    expect(await start({ source: 'resume' })).toBeUndefined();
    expect(await resumeNotice('some-other-id')).toBeNull();
  });

  it('renderResumeNotice wording for one review', () => {
    expect(renderResumeNotice([{ id: 'doc-20261109-142301-a3f9', threads: 1 }])).toContain('1 review has review feedback waiting for this session: doc-20261109-142301-a3f9 (1 thread).');
  });
});

describe('headless-aware instructions and hooks', () => {
  const doc1 = { id: 'doc-20261109-142301-a3f9', kind: 'doc', docPath: '/w/a.md', round: 1, currentRevision: 1 };
  const plan1 = { ...doc1, id: 'plan-20261109-142301-a3f9', kind: 'plan', docPath: null };

  it('headless instructions end with rd done and forbid rd await; plans must not call ExitPlanMode', () => {
    const d = renderInstructions(doc1, { headless: true });
    expect(d).toContain(`rd done ${doc1.id}`);
    expect(d).toContain('non-interactive run');
    expect(d).toContain('Do NOT start `rd await`');
    expect(d).not.toContain('start `rd await` as a BACKGROUND');
    expect(d).toContain(`rd reply ${doc1.id} <threadId> <<'EOF'`);
    const p = renderInstructions(plan1, { headless: true });
    expect(p).toContain('Do not call ExitPlanMode in this run');
    expect(p).toContain(`rd done ${plan1.id}`);
    expect(p).not.toContain('rd await --review');
    expect(renderInstructions(doc1)).toContain('start `rd await` as a BACKGROUND'); // the interactive text is unchanged
  });

  it('the slash command only starts rd await unless the context says the run is non-interactive', () => {
    const c = renderSlashCommand();
    expect(c).toContain('unless the Review Desk context of this conversation says this is a non-interactive run');
    expect(c).toContain('do NOT start `rd await`');
    expect(c).toContain('start `rd await` as a BACKGROUND Bash task');
  });

  it('renderInjection headless: notice first (even without instructions), headless steps', () => {
    const items = [{ meta: doc1, threads: [] }];
    expect(renderInjection(items, { withInstructions: false, headless: true }).startsWith(LEAD_HEADLESS)).toBe(true);
    const full = renderInjection(items, { headless: true });
    expect(full).toContain('How to handle review');
    expect(full).toContain('Do NOT start `rd await`');
    expect(renderInjection(items)).not.toContain(LEAD_HEADLESS);
  });

  it('prompt-submit in a headless run: /review-reply gets the notice only, any other prompt gets the headless instructions', async () => {
    const m = await waiting();
    const env = { CLAUDE_CODE_SESSION_ATTENDED: '0' };
    const o = await dispatchHook('prompt-submit', { session_id: SID, prompt: `/review-reply ${m.id}` }, { findPid: () => 1234, env });
    const ctx = o.hookSpecificOutput.additionalContext;
    expect(ctx).toContain(LEAD_HEADLESS);
    expect(ctx).toContain('**User:** why is the risk low?');
    expect(ctx).not.toContain('How to handle');
    const m2 = await waiting({ docPath: '/w/docs/b.md' });
    const o2 = await dispatchHook('prompt-submit', { session_id: SID, prompt: 'answer the review' }, { findPid: () => 1234, env });
    expect(o2.hookSpecificOutput.additionalContext).toContain(`How to handle review ${m2.id}`);
    expect(o2.hookSpecificOutput.additionalContext).toContain('Do NOT start `rd await`');
  });

  it('stop hook in a headless run injects with the headless instructions', async () => {
    const m = await waiting();
    await updateSession(SID, { state: 'busy', pid: process.pid });
    const o = await dispatchHook('stop', { session_id: SID, stop_hook_active: false }, { findPid: () => 1234, env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } });
    const text = o.hookSpecificOutput.additionalContext;
    expect(text).toContain(m.id);
    expect(text).toContain(LEAD_HEADLESS);
  });

  it('rd await in a headless run ends at once and registers nothing', async () => {
    await waiting();
    const r = await runAwait({ session: SID }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } });
    expect(r.result).toBe('end');
    expect(r.output).toContain('non-interactive run');
    expect(getSession(SID)?.awaiting).toBeUndefined();
  });
});

describe('createResumeWatcher (App-level redelivery after a resume)', () => {
  function world(reviews) {
    let t = 1_000_000;
    const calls = [];
    const w = createResumeWatcher({
      listReviews: () => Object.entries(reviews).map(([id, r]) => ({ id, sessionId: r.sessionId, status: r.status ?? 'feedback_pending' })),
      waitingSince: (id) => (reviews[id].waiting === false ? null : (reviews[id].since ?? '2026-11-12T10:00:00.000Z')),
      planDelivery: (id) => ({ channel: reviews[id].channel, sessionState: reviews[id].state ?? 'idle' }),
      deliver: async (id, opts) => {
        calls.push([id, opts]);
        return { action: 'injected' };
      },
      now: () => t,
    });
    return { w, calls, reviews, advance: (ms) => (t += ms) };
  }

  it('redelivers once when a session that was on channel C comes back idle', async () => {
    const x = world({ 'doc-a': { sessionId: 's1', channel: 'C' } });
    expect(await x.w.tick()).toEqual([]);
    expect(x.calls).toEqual([]);
    x.reviews['doc-a'].channel = 'inject';
    const done = await x.w.tick();
    expect(done).toEqual([{ sessionId: 's1', reviewId: 'doc-a', result: { action: 'injected' } }]);
    expect(x.calls).toEqual([['doc-a', { whenIdle: true }]]);
    expect(await x.w.tick()).toEqual([]); // once per resume
    expect(x.calls.length).toBe(1);
  });

  it('a session that was already alive when watching began is not touched; a headless run stays on C', async () => {
    const x = world({ 'doc-a': { sessionId: 's1', channel: 'A' }, 'doc-b': { sessionId: 's2', channel: 'C' } });
    expect(await x.w.tick()).toEqual([]);
    x.reviews['doc-b'].channel = 'C'; // headless-running reads as C as well
    expect(await x.w.tick()).toEqual([]);
    expect(x.calls).toEqual([]);
  });

  it('waits while the resumed session is busy; forgets sessions whose feedback was delivered another way', async () => {
    const x = world({ 'doc-a': { sessionId: 's1', channel: 'C' }, 'doc-b': { sessionId: 's2', channel: 'C' } });
    await x.w.tick();
    x.reviews['doc-a'].channel = 'B';
    x.reviews['doc-a'].state = 'busy';
    x.reviews['doc-b'].waiting = false; // the prompt-submit hook took it
    expect(await x.w.tick()).toEqual([]);
    x.reviews['doc-b'].channel = 'inject';
    x.reviews['doc-b'].waiting = true;
    expect(await x.w.tick()).toEqual([]); // doc-b was forgotten while nothing waited: no redelivery for it
    x.reviews['doc-a'].channel = 'inject';
    x.reviews['doc-a'].state = 'idle';
    expect((await x.w.tick()).map((d) => d.reviewId)).toEqual(['doc-a']);
  });

  it('one delivery per session (the review waiting longest); finished reviews and deliver failures are harmless', async () => {
    const x = world({
      'doc-a': { sessionId: 's1', channel: 'C', since: '2026-11-12T10:05:00.000Z' },
      'doc-b': { sessionId: 's1', channel: 'C', since: '2026-11-12T10:01:00.000Z' },
      'doc-c': { sessionId: 's1', channel: 'C', status: 'closed' },
    });
    await x.w.tick();
    for (const r of Object.values(x.reviews)) r.channel = 'A';
    const done = await x.w.tick();
    expect(done.map((d) => d.reviewId)).toEqual(['doc-b']);
    expect(x.calls.length).toBe(1);

    const y = world({ 'doc-a': { sessionId: 's1', channel: 'C' } });
    y.w = createResumeWatcher({ listReviews: () => [{ id: 'doc-a', sessionId: 's1', status: 'feedback_pending' }], waitingSince: () => 'x', planDelivery: () => ({ channel: y.reviews['doc-a'].channel, sessionState: 'idle' }), deliver: async () => { throw new Error('boom'); } });
    await y.w.tick();
    y.reviews['doc-a'].channel = 'A';
    expect((await y.w.tick())[0].result).toMatchObject({ action: 'failed', error: 'boom' });
  });

  it('with the real store: ended session -> alive session triggers deliver(whenIdle)', async () => {
    const m = await waiting();
    await ended();
    const deliver = vi.fn(async () => ({ action: 'none' }));
    const w = createResumeWatcher({ deliver, planDelivery: (id, d) => planDelivery(id, { ...d, config: DEFAULT_CONFIG }) });
    expect(await w.tick()).toEqual([]);
    await updateSession(SID, { state: 'idle', pid: process.pid, stateSince: new Date(Date.now() - 10_000).toISOString() });
    expect((await w.tick()).map((d) => d.reviewId)).toEqual([m.id]);
    expect(deliver).toHaveBeenCalledWith(m.id, { whenIdle: true });
  });
});
