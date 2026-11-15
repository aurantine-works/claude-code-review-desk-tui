// End-to-end tests through the real executable (separate processes, temp RD_HOME / CLAUDE_CONFIG_DIR).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { listMetas, getMeta } from '../src/store/reviews.js';
import { approveReview } from '../src/store/lifecycle.js';
import { addThread, submitBatch } from '../src/store/threads.js';
import { makeAnchor } from '../src/anchor/index.js';
import { readSessions } from '../src/store/sessions.js';
import { createTranscript } from './helpers/transcript.js';
import { paths } from '../src/store/paths.js';

const home = useTempHome();
const BIN = path.resolve('bin/rd.js');
const children = new Set();
afterEach(() => {
  for (const c of children) c.kill('SIGKILL'); // never leave a blocked hook behind
  children.clear();
});

function start(args, { input, env = {}, endStdin = true } = {}) {
  // These tests run inside a Claude Code session: never let the plan-review hook ring the real terminal.
  const cfg = path.join(home(), 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ notify: { bell: false } }));
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, RD_HOME: home(), CLAUDE_PID: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  if (input !== undefined) child.stdin.write(typeof input === 'string' ? input : JSON.stringify(input));
  if (endStdin) child.stdin.end();
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}
const run = (args, opts) => start(args, opts).done;

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('rd hook (fast path)', () => {
  it('session-start / prompt-submit / stop / session-end update sessions.json, exit 0, print nothing', async () => {
    const sid = 'e2e-sess';
    for (const ev of ['session-start', 'prompt-submit', 'stop']) {
      const r = await run(['hook', ev], { input: { session_id: sid, cwd: '/work', transcript_path: '/t.jsonl', source: 'startup' } });
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
    expect(readSessions()[sid]).toMatchObject({ state: 'idle', turn: 1, cwd: '/work' });
    const r = await run(['hook', 'session-end'], { input: { session_id: sid, reason: 'other' } });
    expect(r.code).toBe(0);
    expect(readSessions()[sid].state).toBe('ended');
  });

  it('post-tool-use appends to writes.jsonl', async () => {
    await run(['hook', 'post-tool-use'], { input: { session_id: 's', cwd: '/w', tool_name: 'Write', tool_input: { file_path: '/w/a.md' } } });
    expect(fs.readFileSync(paths.writes(), 'utf8')).toContain('"/w/a.md"');
  });

  it('never fails and never prints on bad input, unknown events or an unusable RD_HOME', async () => {
    expect(await run(['hook', 'stop'], { input: 'not json' })).toMatchObject({ code: 0, stdout: '' });
    expect(await run(['hook', 'stop'], { input: '' })).toMatchObject({ code: 0, stdout: '' });
    expect(await run(['hook', 'nonsense'], { input: { session_id: 's' } })).toMatchObject({ code: 0, stdout: '' });
    expect(await run(['hook'], { input: {} })).toMatchObject({ code: 0, stdout: '' });
    const file = path.join(os.tmpdir(), `rd-notadir-${process.pid}`);
    fs.writeFileSync(file, 'x');
    try {
      const r = await run(['hook', 'session-start'], { input: { session_id: 's', cwd: '/w' }, env: { RD_HOME: path.join(file, 'sub') } });
      expect(r).toMatchObject({ code: 0, stdout: '' });
    } finally {
      fs.rmSync(file);
    }
  });
});

describe('rd hook plan-review (real process)', () => {
  const input = (plan = '# Plan\n\nDo the thing.\nThen the other.') => ({
    session_id: 'e2e-plan',
    cwd: '/work',
    transcript_path: path.join(home(), 'none.jsonl'),
    tool_name: 'ExitPlanMode',
    tool_input: { plan, planFilePath: '/tmp/p.md' },
  });

  it('blocks until the review is approved, then prints exactly one allow JSON', async () => {
    const inp = input();
    const { done } = start(['hook', 'plan-review'], { input: inp });
    const meta = await waitFor(() => listMetas().find((m) => m.kind === 'plan' && m.hook));
    await approveReview(meta.id);
    const r = await done;
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: inp.tool_input } },
      terminalSequence: '\u0007',
    });
  });

  it('prints a deny with the feedback when the user submits comments', async () => {
    const { done } = start(['hook', 'plan-review'], { input: input() });
    const meta = await waitFor(() => listMetas().find((m) => m.kind === 'plan' && m.hook));
    await addThread(meta.id, { anchor: makeAnchor('# Plan\n\nDo the thing.\nThen the other.', { startLine: 3, endLine: 3 }, 1), text: 'why this?' });
    await submitBatch(meta.id);
    const r = await done;
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(out.hookSpecificOutput.decision.message).toContain('why this?');
    expect(getMeta(meta.id).status).toBe('delivered');
  });

  it('tool_input {}: plan from the transcript; a native approval ends the process silently (no leak) and marks the review', async () => {
    const tf = path.join(home(), 'real-transcript.jsonl');
    const t = createTranscript('e2e-plan');
    t.user('plan it');
    const toolUseId = t.toolUse('ExitPlanMode', { plan: '# From transcript\n\nstep' });
    t.write(tf);
    const { done } = start(['hook', 'plan-review'], { input: { ...input(), transcript_path: tf, tool_input: {} } });
    const meta = await waitFor(() => listMetas().find((m) => m.kind === 'plan' && m.hook));
    expect(meta.title).toBe('From transcript');
    const l = createTranscript('e2e-plan');
    l.toolResult(toolUseId, 'User has approved your plan. You can now start coding.');
    l.append(tf);
    const r = await done;
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(getMeta(meta.id)).toMatchObject({ status: 'approved', approvedVia: 'native' });
    expect(getMeta(meta.id).hook).toBeUndefined();
  });

  it.each(['SIGTERM', 'SIGINT'])('%s: exits 0 silently and keeps the review awaiting_review', async (sig) => {
    const { child, done } = start(['hook', 'plan-review'], { input: input() });
    const meta = await waitFor(() => listMetas().find((m) => m.kind === 'plan' && m.hook));
    child.kill(sig);
    const r = await done;
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(getMeta(meta.id).status).toBe('awaiting_review');
    expect(getMeta(meta.id).hook).toBeUndefined();
  });
});

describe('rd statusline (fast path)', () => {
  it('prints the summary and exits even if stdin stays open', async () => {
    const { child, done } = start(['statusline'], { input: JSON.stringify({ session_id: 'nobody' }), endStdin: false });
    const t0 = Date.now();
    const r = await done;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    child.stdin.destroy();
  });
});

describe('rd install via the CLI', () => {
  it('--dry-run, then --yes with a dev prefix, only inside CLAUDE_CONFIG_DIR', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-cfg-'));
    try {
      const env = { CLAUDE_CONFIG_DIR: dir };
      const dry = await run(['install', '--dry-run'], { env });
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain(path.join(dir, 'settings.json'));
      expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
      const real = await run(['install', '--yes', '--hook-prefix', 'node /abs/bin/rd.js'], { env });
      expect(real.code).toBe(0);
      const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      expect(s.hooks.PermissionRequest[0].hooks[0].command).toBe('node /abs/bin/rd.js hook plan-review');
      const un = await run(['uninstall', '--yes'], { env });
      expect(un.code).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install without --yes and without a TTY fails with a readable message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-cfg-'));
    try {
      const r = await run(['install'], { env: { CLAUDE_CONFIG_DIR: dir } });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^rd: .*--yes/);
      expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rd (commander path)', () => {
  it('unknown command exits non-zero; list works on an empty store', async () => {
    expect((await run(['bogus'])).code).not.toBe(0);
    expect(await run(['list'])).toMatchObject({ code: 0, stdout: '(no reviews)\n' });
  });
});

describe('rd await / rd deliver / rd show --pending (real processes)', () => {
  const SESSION = 'e2e-await-session';
  const content = '# Doc\n\nRisk is low.\nTwo weeks.';
  const sessionRecord = () => readSessions()[SESSION];
  const mkDoc = async (over = {}) => {
    const { createReview } = await import('../src/store/reviews.js');
    return createReview({ kind: 'doc', docPath: '/w/docs/a.md', sessionId: SESSION, cwd: '/w', content, source: 'Write', ...over });
  };
  const env = (extra = {}) => ({ CLAUDE_CODE_SESSION_ID: SESSION, ...extra });

  it('waits as a background task, registers awaiting, prints the feedback with the marker and exits 0', async () => {
    const meta = await mkDoc();
    const { child, done } = start(['await', '--poll-ms', '50'], { env: env() });
    await waitFor(() => sessionRecord()?.awaiting);
    expect(sessionRecord().awaiting).toMatchObject({ pid: child.pid, reviewId: null });
    await addThread(meta.id, { anchor: makeAnchor(content, { startLine: 3, endLine: 3 }, 1), text: 'why low?', send: true });
    const r = await done;
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout.split('\n').slice(0, 2)).toEqual(['# rd-await v1', 'feedback']);
    expect(r.stdout).toContain('**User:** why low?');
    expect(sessionRecord().awaiting).toBeUndefined();
  });

  it('a second `rd await` prints already-waiting; SIGTERM clears the record; end after the review closes', async () => {
    const meta = await mkDoc();
    const first = start(['await', '--poll-ms', '50', '--review', meta.id], { env: env() });
    await waitFor(() => sessionRecord()?.awaiting);
    const second = await run(['await'], { env: env() });
    expect(second).toMatchObject({ code: 0 });
    expect(second.stdout.split('\n').slice(0, 2)).toEqual(['# rd-await v1', 'already-waiting']);
    first.child.kill('SIGTERM');
    const r = await first.done;
    expect(r.stdout).toBe(''); // a stopped task prints nothing
    expect(sessionRecord().awaiting).toBeUndefined();

    const third = start(['await', '--poll-ms', '50', '--review', meta.id], { env: env() });
    await waitFor(() => sessionRecord()?.awaiting);
    const { closeReview } = await import('../src/store/lifecycle.js');
    await closeReview(meta.id);
    const end = await third.done;
    expect(end.stdout.split('\n').slice(0, 2)).toEqual(['# rd-await v1', 'end']);
  });

  it('errors are one readable line: no session, bad review id', async () => {
    const noSession = await run(['await'], { env: { CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' } });
    expect(noSession.code).toBe(1);
    expect(noSession.stderr).toMatch(/^rd: cannot tell which Claude Code session/);
    const bad = await run(['await', '--review', '../x'], { env: env() });
    expect(bad).toMatchObject({ code: 1 });
    expect(bad.stderr).toMatch(/^rd: invalid review id/);
    expect((await run(['deliver', 'nope'])).stderr).toMatch(/^rd: invalid review id/);
  });

  it('show --pending prefers the session from CLAUDE_CODE_SESSION_ID over the project directory', async () => {
    const mine = await mkDoc({ cwd: '/elsewhere' });
    const sameDir = await mkDoc({ sessionId: 'another-session', docPath: '/w/docs/b.md', cwd: process.cwd() });
    for (const m of [mine, sameDir]) await addThread(m.id, { anchor: makeAnchor(content, { startLine: 3, endLine: 3 }, 1), text: `q ${m.id}`, send: true });
    const bySession = await run(['show', '--pending'], { env: env() });
    expect(bySession.stdout).toContain(mine.id);
    expect(bySession.stdout).not.toContain(sameDir.id);
    const byDir = await run(['show', '--pending'], { env: { CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' } });
    expect(byDir.stdout).toContain(sameDir.id); // no session known: the project directory decides
    expect(byDir.stdout).not.toContain(mine.id);
  });

  it('deliver reports the channel without touching anything when no adapter is registered', async () => {
    const { updateSession } = await import('../src/store/sessions.js');
    await updateSession(SESSION, { cwd: '/w', pid: process.pid, state: 'idle', stateSince: new Date(Date.now() - 60_000).toISOString(), injector: { kind: 'none' } });
    const meta = await mkDoc();
    await addThread(meta.id, { anchor: makeAnchor(content, { startLine: 3, endLine: 3 }, 1), text: 'q', send: true });
    const r = await run(['deliver', meta.id]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toBe(`deliver ${meta.id}: channel A (idle-no-injector) · none\n`);
  });
});
