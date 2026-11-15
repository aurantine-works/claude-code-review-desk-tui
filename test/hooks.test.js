import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { dispatchHook, runHook, HOOK_EVENTS } from '../src/hooks/index.js';
import { detectInjector } from '../src/hooks/injector.js';
import { readSessions, getSession } from '../src/store/sessions.js';
import { readJsonl } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { Readable, Writable } from 'node:stream';
import { ringBell } from '../src/hooks/bell.js';
import { classifyPrompt } from '../src/hooks/prompt-submit.js';
import { isClaudePlanFile } from '../src/hooks/post-tool-use.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';

const home = useTempHome();
const SID = '7b9a8bb5-d327-442b-860e-ba3294fecdd6';
const deps = { findPid: () => 4242, env: {} };

describe('session hooks', () => {
  it('session-start registers the session with pid, cwd, transcript and no injector', async () => {
    const out = await dispatchHook('session-start', { session_id: SID, cwd: '/work/p', transcript_path: '/t/x.jsonl', source: 'startup' }, deps);
    expect(out).toBeUndefined();
    expect(getSession(SID)).toMatchObject({
      sessionId: SID,
      cwd: '/work/p',
      transcriptPath: '/t/x.jsonl',
      pid: 4242,
      injector: { kind: 'none' },
      state: 'idle',
      turn: 0,
      source: 'startup',
    });
  });

  it('session-start keeps the turn counter and drops a stale awaiting when the pid changed', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, deps);
    await dispatchHook('prompt-submit', { session_id: SID }, deps);
    await dispatchHook('prompt-submit', { session_id: SID }, deps);
    const { updateSession } = await import('../src/store/sessions.js');
    await updateSession(SID, { awaiting: { reviewId: 'x', since: 'now', pid: 1 } });
    await dispatchHook('session-start', { session_id: SID, cwd: '/p', source: 'resume' }, { ...deps, findPid: () => 5555 });
    const s = getSession(SID);
    expect(s).toMatchObject({ turn: 2, pid: 5555, source: 'resume', state: 'idle' });
    expect(s.awaiting).toBeUndefined();
  });

  it('prompt-submit sets busy and increments turn; stop sets idle', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, deps);
    expect(await dispatchHook('prompt-submit', { session_id: SID, prompt: 'hi' }, deps)).toBeUndefined();
    expect(getSession(SID)).toMatchObject({ state: 'busy', turn: 1 });
    await dispatchHook('prompt-submit', { session_id: SID }, deps);
    expect(getSession(SID).turn).toBe(2);
    expect(await dispatchHook('stop', { session_id: SID, stop_hook_active: false }, deps)).toBeUndefined();
    expect(getSession(SID)).toMatchObject({ state: 'idle', turn: 2 });
  });

  it('hooks create the record when SessionStart was never seen (installed mid-session)', async () => {
    await dispatchHook('prompt-submit', { session_id: SID, cwd: '/late', transcript_path: '/t/l.jsonl' }, deps);
    expect(getSession(SID)).toMatchObject({ state: 'busy', turn: 1, cwd: '/late', transcriptPath: '/t/l.jsonl', pid: 4242 });
  });

  it('session-end marks the session ended with one write', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, deps);
    await dispatchHook('session-end', { session_id: SID, reason: 'prompt_input_exit' }, deps);
    expect(getSession(SID)).toMatchObject({ state: 'ended', endReason: 'prompt_input_exit' });
    expect(getSession(SID).endedAt).toBeTruthy();
  });

  it('session-end gives up quietly when the lock budget is exceeded', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, deps);
    const { withLock } = await import('../src/store/io.js');
    let release;
    const held = withLock(paths.sessions(), () => new Promise((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await dispatchHook('session-end', { session_id: SID }, { ...deps, budgetMs: 150 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(getSession(SID).state).toBe('idle'); // not written
    expect(fs.readFileSync(paths.log(), 'utf8')).toContain('lock budget exceeded');
    release();
    await held;
    // The abandoned write still completes once the lock frees; wait for it so nothing outlives the temp RD_HOME.
    for (let i = 0; i < 100 && getSession(SID).state !== 'ended'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(getSession(SID).state).toBe('ended');
  });

  it('rejects hostile session ids without touching sessions.json', async () => {
    for (const bad of ['__proto__', '../../x', '', null, 42]) {
      await dispatchHook('session-start', { session_id: bad }, deps);
    }
    expect(readSessions()).toEqual({});
    expect(({}).polluted).toBeUndefined();
  });
});

describe('post-tool-use', () => {
  it('records every write unconditionally, resolving relative paths against the session cwd', async () => {
    await dispatchHook('post-tool-use', { session_id: SID, cwd: '/work/p', tool_name: 'Write', tool_input: { file_path: 'notes/a.md', content: 'x' } }, deps);
    await dispatchHook('post-tool-use', { session_id: SID, cwd: '/work/p', tool_name: 'Edit', tool_input: { file_path: '/elsewhere/b.txt' } }, deps);
    const rows = readJsonl(paths.writes());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: '/work/p/notes/a.md', sessionId: SID, cwd: '/work/p', tool: 'Write' });
    expect(rows[1]).toMatchObject({ path: '/elsewhere/b.txt', tool: 'Edit' });
  });
  it('ignores events without a file path', async () => {
    await dispatchHook('post-tool-use', { session_id: SID, tool_input: {} }, deps);
    expect(readJsonl(paths.writes())).toEqual([]);
  });
});

describe('dispatcher', () => {
  it('never throws: unknown events and handler errors are logged', async () => {
    expect(await dispatchHook('bogus', {}, deps)).toBeUndefined();
    expect(await dispatchHook('constructor', {}, deps)).toBeUndefined();
    const log = fs.readFileSync(paths.log(), 'utf8');
    expect(log).toContain('unknown hook event: bogus');
  });
  it('lists the six events and the wake-up watcher', () => {
    expect(HOOK_EVENTS.sort()).toEqual(['plan-review', 'post-tool-use', 'prompt-submit', 'session-end', 'session-start', 'stop', 'watch']);
  });
  it('runHook: the watcher\'s HookExit goes to stderr and becomes the exit code (2); JSON results go to stdout and leave the code undefined', async () => {
    const out = [];
    const err = [];
    const stdout = new Writable({ write: (c, _e, cb) => (out.push(c.toString()), cb()) });
    const stderr = new Writable({ write: (c, _e, cb) => (err.push(c.toString()), cb()) });
    const sid = 'rh-watch';
    const content = '# R\n\nRisk is low.\n';
    const { createReview } = await import('../src/store/reviews.js');
    const { addThread } = await import('../src/store/threads.js');
    const { makeAnchor } = await import('../src/anchor/index.js');
    const r = await createReview({ kind: 'doc', docPath: '/w/docs/a.md', sessionId: sid, cwd: '/w', content, source: 'Write' });
    await addThread(r.id, { anchor: makeAnchor(content, { startLine: 3, endLine: 3 }, 1), text: 'wake', send: true });
    const watchDeps = { env: {}, claude: { pid: process.pid, via: 'env', startTime: null }, isClaudeAlive: () => true, pollMs: 10 };
    const code = await runHook('watch', { stdin: Readable.from([JSON.stringify({ session_id: sid })]), stdout, stderr, deps: watchDeps });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('**User:** wake');
    expect(err.join('').endsWith('\n')).toBe(true);
    // a JSON result: stdout, no exit code
    const out2 = [];
    const err2 = [];
    const code2 = await runHook('stop', { stdin: Readable.from([JSON.stringify({ session_id: 'quiet' })]), stdout: new Writable({ write: (c, _e, cb) => (out2.push(c.toString()), cb()) }), stderr: new Writable({ write: (c, _e, cb) => (err2.push(c.toString()), cb()) }), deps });
    expect(code2).toBeUndefined();
    expect(err2).toEqual([]);
  });
  it('runHook reads stdin JSON and stays silent on garbage input', async () => {
    const chunks = [];
    const stdout = new Writable({ write: (c, _e, cb) => (chunks.push(c.toString()), cb()) });
    await runHook('stop', { stdin: Readable.from(['not json']), stdout, deps });
    await runHook('stop', { stdin: Readable.from([JSON.stringify({ session_id: SID, cwd: '/p' })]), stdout, deps });
    expect(chunks).toEqual([]);
    expect(getSession(SID)).toMatchObject({ state: 'idle' });
    expect(fs.readFileSync(paths.log(), 'utf8')).toContain('unparsable stdin');
  });
});

describe('detectInjector', () => {
  it('returns none without any adapter environment', () => {
    expect(detectInjector({})).toEqual({ kind: 'none' });
  });
  it('detects a tmux pane and rejects malformed pane ids', () => {
    expect(detectInjector({ TMUX_PANE: '%12' })).toEqual({ kind: 'tmux', target: '%12' });
    expect(detectInjector({ TMUX_PANE: '%12; rm -rf /' })).toEqual({ kind: 'none' });
  });
  function fakeCcd(script) {
    const bin = path.join(home(), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ccd'), script, { mode: 0o755 });
    return bin;
  }
  it('uses ccd only when `ccd send --help` really documents send (and caches the verdict)', () => {
    const bin = fakeCcd('#!/bin/sh\necho "usage: ccd send <name> --text T --enter"\n');
    const run = vi.fn((cmd, args) => ({ status: 0, stdout: 'usage: ccd send <name>', stderr: '' }));
    const env = { CCD_SESSION: 'proj-x-3f9a1c', PATH: bin };
    expect(detectInjector(env, { run })).toEqual({ kind: 'ccd', target: 'proj-x-3f9a1c' });
    expect(detectInjector(env, { run })).toEqual({ kind: 'ccd', target: 'proj-x-3f9a1c' });
    expect(run).toHaveBeenCalledTimes(1); // second call served from probe-cache.json
    expect(run.mock.calls[0][1]).toEqual(['send', '--help']);
  });
  it('treats a generic usage page (status 0, no mention of send) as unsupported', () => {
    const bin = fakeCcd('#!/bin/sh\n');
    const run = () => ({ status: 0, stdout: 'usage:\n  ccd [name]\n  ccd ls | kill <name>', stderr: '' });
    expect(detectInjector({ CCD_SESSION: 's1', PATH: bin }, { run })).toEqual({ kind: 'none' });
  });
  it('does not cache a timeout and ignores ccd when it is not installed', () => {
    const bin = fakeCcd('#!/bin/sh\n');
    const run = () => ({ error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), status: null });
    expect(detectInjector({ CCD_SESSION: 's1', PATH: bin }, { run })).toEqual({ kind: 'none' });
    expect(fs.existsSync(path.join(home(), 'probe-cache.json'))).toBe(false);
    expect(detectInjector({ CCD_SESSION: 's1', PATH: '/nonexistent' }, { run })).toEqual({ kind: 'none' });
  });
  it('session-start stores the detected injector', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, { findPid: () => 1, env: { TMUX_PANE: '%3' } });
    expect(getSession(SID).injector).toEqual({ kind: 'tmux', target: '%3' });
  });
});

// --- spike-driven changes --------------------------------------------------------------------


describe('ringBell', () => {
  function fakeProc(pid, fd1Target) {
    const root = path.join(home(), 'fakeproc');
    fs.mkdirSync(path.join(root, String(pid), 'fd'), { recursive: true });
    fs.symlinkSync(fd1Target, path.join(root, String(pid), 'fd', '1')); // dangling is fine: only readlink is used
    return root;
  }
  const rec = () => {
    const calls = [];
    return { calls, open: (p) => (calls.push(['open', p]), 77), write: (fd, s) => calls.push(['write', fd, s]), close: (fd) => calls.push(['close', fd]) };
  };

  it('writes BEL through /proc/<pid>/fd/1 when it is a pty or tty', () => {
    for (const [i, target] of ['/dev/pts/0', '/dev/pts/12', '/dev/tty1', '/dev/ttyS0'].entries()) {
      const procRoot = fakeProc(500 + i, target);
      const r = rec();
      expect(ringBell(500 + i, { procRoot, ...r })).toBe(true);
      expect(r.calls).toEqual([['open', `${procRoot}/${500 + i}/fd/1`], ['write', 77, '\u0007'], ['close', 77]]);
    }
  });

  it('never writes to a pipe, socket, file, /dev/null or a path that merely looks like a tty', () => {
    for (const [i, target] of ['socket:[12345]', 'pipe:[777]', '/tmp/out.log', '/dev/null', '/dev/pts/../shadow', '/dev/ptsx/1', 'anon_inode:[eventpoll]'].entries()) {
      const procRoot = fakeProc(600 + i, target);
      const r = rec();
      expect(ringBell(600 + i, { procRoot, ...r })).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });

  it('never throws: missing pid, bad pid, open/write failures', () => {
    expect(ringBell(424242, { procRoot: path.join(home(), 'nope') })).toBe(false);
    for (const bad of [0, 1, -3, 1.5, NaN, undefined, '12']) expect(ringBell(bad)).toBe(false);
    const procRoot = fakeProc(700, '/dev/pts/3');
    const closed = [];
    expect(ringBell(700, { procRoot, open: () => 5, write: () => { throw new Error('EIO'); }, close: (fd) => closed.push(fd) })).toBe(false);
    expect(closed).toEqual([5]); // fd released even when the write failed
    expect(ringBell(700, { procRoot, open: () => { throw new Error('EACCES'); } })).toBe(false);
  });
});

describe('config: notify.bell', () => {
  it('defaults to on and can be switched off in config.json', () => {
    expect(DEFAULT_CONFIG.notify).toEqual({ bell: true });
    expect(loadConfig().notify.bell).toBe(true);
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(path.join(home(), 'config.json'), JSON.stringify({ notify: { bell: false } }));
    expect(loadConfig().notify.bell).toBe(false);
  });
});

describe('prompt-submit: prompt kinds', () => {
  it('classifies typed prompts, slash commands, task notifications and agent messages', () => {
    expect(classifyPrompt('fix the bug')).toBe('user');
    expect(classifyPrompt('/review-reply doc-20261109-142301-a3f9')).toBe('user');
    expect(classifyPrompt('')).toBe('user');
    expect(classifyPrompt(undefined)).toBe('user');
    expect(classifyPrompt('<task-notification>\n<task-id>bxp1ay9l6</task-id>\n<status>completed</status>\n</task-notification>')).toBe('task-notification');
    expect(classifyPrompt('  \n<task-notification>x')).toBe('task-notification');
    expect(classifyPrompt('<agent-message from="a479014fb00f3ed9b">[Subagent hand-back] done')).toBe('agent-message');
    expect(classifyPrompt('<teammate-message from="x">hi')).toBe('agent-message');
    expect(classifyPrompt('<cross-session-message from="y">hi')).toBe('agent-message');
    expect(classifyPrompt('please explain <agent-message> tags')).toBe('user'); // only a leading wrapper counts
  });

  it('records lastPromptKind, sets busy and counts every kind as a turn', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, deps);
    await dispatchHook('prompt-submit', { session_id: SID, prompt: 'hello' }, deps);
    expect(getSession(SID)).toMatchObject({ state: 'busy', turn: 1, lastPromptKind: 'user' });
    await dispatchHook('stop', { session_id: SID }, deps);
    await dispatchHook('prompt-submit', { session_id: SID, prompt: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>' }, deps);
    expect(getSession(SID)).toMatchObject({ state: 'busy', turn: 2, lastPromptKind: 'task-notification' });
    await dispatchHook('stop', { session_id: SID }, deps);
    await dispatchHook('prompt-submit', { session_id: SID, prompt: '<agent-message from="a1">[Subagent hand-back] x' }, deps);
    expect(getSession(SID)).toMatchObject({ turn: 3, lastPromptKind: 'agent-message' });
    await dispatchHook('prompt-submit', { session_id: SID }, deps); // no prompt field at all
    expect(getSession(SID)).toMatchObject({ turn: 4, lastPromptKind: 'user' });
  });
});

describe('post-tool-use: Claude Code plan files', () => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg/claude' };
  it('recognises files under <config dir>/plans/ (and ~/.claude/plans by default)', () => {
    expect(isClaudePlanFile('/cfg/claude/plans/misty-sonnet.md', env, '/home/u')).toBe(true);
    expect(isClaudePlanFile('/cfg/claude/plans/sub/x.md', env, '/home/u')).toBe(true);
    expect(isClaudePlanFile('/home/u/.claude/plans/misty.md', {}, '/home/u')).toBe(true);
    expect(isClaudePlanFile('/cfg/claude/plans-archive/x.md', env, '/home/u')).toBe(false);
    expect(isClaudePlanFile('/cfg/claude/plans', env, '/home/u')).toBe(false);
    expect(isClaudePlanFile('/home/u/.claude/plans/misty.md', env, '/home/u')).toBe(false); // other config dir is active
    expect(isClaudePlanFile('/work/proj/docs/plans/x.md', env, '/home/u')).toBe(false);
  });

  it('does not record plan-file writes but still records everything else (agentId kept)', async () => {
    const e = { CLAUDE_CONFIG_DIR: path.join(home(), 'cfg') };
    const d = { ...deps, env: e, home: '/nonexistent-home' };
    await dispatchHook('post-tool-use', { session_id: SID, cwd: '/w', tool_name: 'Write', tool_input: { file_path: path.join(home(), 'cfg', 'plans', 'a-b-c.md') } }, d);
    await dispatchHook('post-tool-use', { session_id: SID, cwd: '/w', tool_name: 'Write', tool_input: { file_path: '/w/docs/plan.md' }, agent_id: 'a479014fb00f3ed9b', agent_type: 'general-purpose' }, d);
    await dispatchHook('post-tool-use', { session_id: SID, cwd: '/w', tool_name: 'Edit', tool_input: { file_path: '/w/x.md' } }, d);
    const rows = readJsonl(paths.writes());
    expect(rows.map((r) => r.path)).toEqual(['/w/docs/plan.md', '/w/x.md']);
    expect(rows[0].agentId).toBe('a479014fb00f3ed9b');
    expect(rows[1].agentId).toBeUndefined();
  });
});

describe('session lifecycle across /clear', () => {
  it('/clear: the old session ends with endReason clear, the new id registers in the same claude pid', async () => {
    const OLD = 'old-session-id';
    const NEW = 'new-session-id';
    await dispatchHook('session-start', { session_id: OLD, cwd: '/p', source: 'startup' }, deps);
    await dispatchHook('prompt-submit', { session_id: OLD, prompt: 'hi' }, deps);
    await dispatchHook('session-end', { session_id: OLD, reason: 'clear' }, deps);
    await dispatchHook('session-start', { session_id: NEW, cwd: '/p', transcript_path: '/t/new.jsonl', source: 'clear' }, deps);
    expect(getSession(OLD)).toMatchObject({ state: 'ended', endReason: 'clear' });
    expect(getSession(NEW)).toMatchObject({ state: 'idle', pid: 4242, source: 'clear', turn: 0, transcriptPath: '/t/new.jsonl' });
    expect(getSession(NEW).endReason).toBeUndefined();
  });

  it('any SessionEnd reason is stored; resume keeps the same record and bumps the pid', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, deps);
    await dispatchHook('prompt-submit', { session_id: SID, prompt: 'x' }, deps);
    await dispatchHook('session-end', { session_id: SID, reason: 'prompt_input_exit' }, deps);
    expect(getSession(SID)).toMatchObject({ state: 'ended', endReason: 'prompt_input_exit' });
    await dispatchHook('session-start', { session_id: SID, cwd: '/p', source: 'resume' }, { ...deps, findPid: () => 9999 });
    expect(getSession(SID)).toMatchObject({ state: 'idle', pid: 9999, turn: 1, source: 'resume' });
    expect(getSession(SID).endReason).toBeUndefined();
    expect(getSession(SID).endedAt).toBeUndefined();
  });
});

describe('M2: session state timestamps and injectors', () => {
  it('every state change stamps stateSince (the idle-for-2s check of auto-injection reads it)', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, deps);
    const a = getSession(SID).stateSince;
    expect(a).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    await dispatchHook('prompt-submit', { session_id: SID, prompt: 'x' }, deps);
    const b = getSession(SID).stateSince;
    expect(b > a).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await dispatchHook('stop', { session_id: SID }, deps);
    const c = getSession(SID).stateSince;
    expect(c > b).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await dispatchHook('session-end', { session_id: SID, reason: 'other' }, deps);
    expect(getSession(SID).stateSince > c).toBe(true);
  });

  it('a headless (unattended) session never gets an injector, even with TMUX_PANE inherited', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/p' }, { findPid: () => 1, env: { TMUX_PANE: '%3', CLAUDE_CODE_SESSION_ATTENDED: '0' } });
    expect(getSession(SID).injector).toEqual({ kind: 'none' });
    await dispatchHook('session-start', { session_id: 'attended', cwd: '/p' }, { findPid: () => 1, env: { TMUX_PANE: '%3', TMUX: '/tmp/tmux-0/default,1,0', CLAUDE_CODE_SESSION_ATTENDED: '1' } });
    expect(getSession('attended').injector).toEqual({ kind: 'tmux', target: '%3', socket: '/tmp/tmux-0/default' });
  });
});

describe('config', () => {
  it('merges the user config over the defaults without lodash: objects deep, arrays and nulls replace, junk ignored', () => {
    const f = path.join(home(), 'config.json');
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ docs: { include: ['**/x.md'], autoOpen: true }, delivery: { autoInject: false }, editor: 'vim', review: { idleEndMinutes: 30 }, __proto__: { polluted: 1 } }));
    const c = loadConfig();
    expect(c.docs).toEqual({ include: ['**/x.md'], exclude: DEFAULT_CONFIG.docs.exclude, autoOpen: true });
    expect(c.delivery).toEqual({ autoInject: false, injectIdleSeconds: 2, injectWaitSeconds: 30, claudeBin: 'claude', autoResume: 'ask' });
    expect(c.review).toEqual({ sendMode: 'instant', idleEndMinutes: 30 });
    expect(c.editor).toBe('vim');
    expect(({}).polluted).toBeUndefined();
    c.docs.exclude.push('mutated'); // the result is a copy: defaults stay intact
    expect(DEFAULT_CONFIG.docs.exclude).not.toContain('mutated');
    fs.writeFileSync(f, '[1,2]');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    fs.writeFileSync(f, '{ broken');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('hook paths stay light: the post-tool-use / prompt-submit / stop modules do not pull in heavy packages', async () => {
    const heavy = ['ink', 'react', 'commander', 'lodash', 'moment'];
    const files = ['hooks/post-tool-use.js', 'hooks/prompt-submit.js', 'hooks/stop.js', 'hooks/session-start.js', 'hooks/session-end.js', 'config.js', 'store/docs.js', 'store/outbox.js', 'delivery/adapters/index.js', 'feedback/instructions.js'];
    const seen = new Set();
    const walk = (rel) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const src = fs.readFileSync(path.resolve('src', rel), 'utf8');
      for (const m of src.matchAll(/(?:import|from)\s*\(?\s*'([^']+)'/g)) {
        const spec = m[1];
        if (spec.startsWith('.')) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
        else expect(heavy, `${rel} imports ${spec}`).not.toContain(spec.split('/')[0]);
      }
    };
    files.forEach(walk);
    expect(seen.size).toBeGreaterThan(10);
  });
});
