import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { runChecks, doctorCommand, formatReport, recentLogErrors, VERIFIED_CLAUDE_VERSION } from '../src/cli/doctor.js';
import { runInstall } from '../src/cli/installCmd.js';
import { paths } from '../src/store/paths.js';
import { updateSession, readSessions } from '../src/store/sessions.js';
import { writeJsonAtomic } from '../src/store/io.js';
import { createReview } from '../src/store/reviews.js';
import { logLine } from '../src/store/log.js';

const BIN = fileURLToPath(new URL('../bin/rd.js', import.meta.url));
const home = useTempHome();

let claudeDir;
let cwd;
const settingsFile = (dir = claudeDir) => path.join(dir, 'settings.json');
const readSettings = (dir = claudeDir) => JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8'));
const install = (dir = claudeDir, o = {}) => runInstall({ yes: true, ...o }, { dir, out: () => {} });

// Deterministic environment: rd found on PATH (this package), the verified claude version, no tmux / ccd, a fixed clock.
const deps = (over = {}) => ({
  env: { PATH: '' },
  cwd,
  which: (name) => (name === 'rd' ? BIN : null),
  claudeVersion: async () => ({ version: `${VERIFIED_CLAUDE_VERSION} (Claude Code)` }),
  ...over,
});
const run = (opts = {}, d = {}) => runChecks({ configDir: claudeDir, ...opts }, deps(d));
const find = (r, id) => r.checks.find((c) => c.id === id);
const statusOf = (r, id) => find(r, id)?.status;

beforeEach(() => {
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-doctor-claude-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-doctor-cwd-'));
});
afterEach(() => {
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('rd doctor: Claude Code installation', () => {
  it('before install: ✗ not installed, with the command that fixes it', async () => {
    const r = await run();
    expect(r.ok).toBe(false);
    expect(statusOf(r, 'installed')).toBe('fail');
    expect(find(r, 'installed').fix).toMatch(/rd install/);
    expect(r.checks.some((c) => c.id === 'hooks')).toBe(false); // no per-item noise on top of the one line
  });

  it('after install: hooks, timeout, permissions, statusLine and /review-reply are all ✓', async () => {
    await install();
    const r = await run();
    for (const id of ['hooks', 'plan-timeout', 'permissions', 'statusline', 'slash-command']) expect(statusOf(r, id), id).toBe('ok');
    expect(r.summary.fail).toBe(0);
    expect(find(r, 'hooks').title).toBe('hooks: all 6 events registered');
  });

  it('the wake-up watcher entries are checked: ✓ when installed', async () => {
    await install();
    const c = find(await run(), 'watch-hooks');
    expect(c.status).toBe('ok');
    expect(c.title).toBe('automatic wake-up: SessionStart + Stop (asyncRewake, timeout 604800 s)');
  });

  it('an older installation without the watcher is ! (not ✗) and says what it costs and how to fix it', async () => {
    await install();
    const s = readSettings();
    for (const event of ['SessionStart', 'Stop']) s.hooks[event] = s.hooks[event].filter((g) => !JSON.stringify(g).includes('hook watch'));
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    const r = await run();
    const c = find(r, 'watch-hooks');
    expect(c.status).toBe('warn');
    expect(c.title).toMatch(/automatic wake-up is not installed/);
    expect(c.detail.join('\n')).toContain('/review-reply');
    expect(c.fix).toBe(`rd install --config-dir ${claudeDir}`);
    expect(r.summary.fail).toBe(0);
    expect(statusOf(r, 'hooks')).toBe('ok'); // the six core events are all there
    expect(find(r, 'hooks').title).toBe('hooks: all 6 events registered');
    // only one of the two
    await install();
    const s2 = readSettings();
    s2.hooks.Stop = s2.hooks.Stop.filter((g) => !JSON.stringify(g).includes('hook watch'));
    fs.writeFileSync(settingsFile(), JSON.stringify(s2));
    const one = find(await run(), 'watch-hooks');
    expect(one.status).toBe('warn');
    expect(one.detail.join('\n')).toContain('missing: Stop');
  });

  it('a watcher entry without asyncRewake is ✗ (Claude Code would wait for it at the end of every turn); a short timeout is !', async () => {
    await install();
    const s = readSettings();
    const entry = (event) => s.hooks[event].flatMap((g) => g.hooks).find((h) => h.command === 'rd hook watch');
    delete entry('Stop').asyncRewake;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    let c = find(await run(), 'watch-hooks');
    expect(c.status).toBe('fail');
    expect(c.detail.join('\n')).toMatch(/Stop: .*no "asyncRewake": true/);
    expect(c.fix).toMatch(/rd install/);
    entry('Stop').asyncRewake = true;
    delete entry('SessionStart').timeout;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    c = find(await run(), 'watch-hooks');
    expect(c.status).toBe('warn');
    expect(c.detail.join('\n')).toMatch(/SessionStart: timeout is not set/);
    entry('SessionStart').timeout = 600;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(find(await run(), 'watch-hooks').detail.join('\n')).toContain('timeout is 600 s');
    // a repair by rd install makes it ✓ again
    await install();
    expect(statusOf(await run(), 'watch-hooks')).toBe('ok');
  });

  it('after uninstall it is back to ✗', async () => {
    await install();
    const { runUninstall } = await import('../src/cli/installCmd.js');
    await runUninstall({ yes: true }, { dir: claudeDir, out: () => {} });
    expect(statusOf(await run(), 'installed')).toBe('fail');
  });

  it('a missing event is ✗ and named', async () => {
    await install();
    const s = readSettings();
    delete s.hooks.Stop;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    const r = await run();
    expect(statusOf(r, 'hooks')).toBe('fail');
    expect(find(r, 'hooks').title).toBe('hooks: 5 of 6 events registered');
    expect(find(r, 'hooks').detail.join('\n')).toContain('missing: Stop');
  });

  it('a duplicated hook and a wrong matcher are reported', async () => {
    await install();
    const s = readSettings();
    s.hooks.SessionEnd.push(structuredClone(s.hooks.SessionEnd[0]));
    s.hooks.PostToolUse[0].matcher = 'Write';
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    const c = find(await run(), 'hooks');
    expect(c.status).toBe('warn');
    expect(c.detail.join('\n')).toMatch(/SessionEnd: registered 2 times/);
    expect(c.detail.join('\n')).toMatch(/PostToolUse: matcher is "Write"/);
  });

  it('a plan-review timeout below an hour is ✗ (the hook would be stopped while you read)', async () => {
    await install();
    const s = readSettings();
    s.hooks.PermissionRequest[0].hooks[0].timeout = 600;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(statusOf(await run(), 'plan-timeout')).toBe('fail');
    delete s.hooks.PermissionRequest[0].hooks[0].timeout;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(find(await run(), 'plan-timeout').title).toMatch(/not set/);
    s.hooks.PermissionRequest[0].hooks[0].timeout = 7200;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(statusOf(await run(), 'plan-timeout')).toBe('warn');
  });

  it('missing allow rules are ! and listed; a deny rule for rd is !', async () => {
    await install();
    const s = readSettings();
    s.permissions.allow = s.permissions.allow.filter((r) => r !== 'Bash(rd reply:*)');
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    const c = find(await run(), 'permissions');
    expect(c.status).toBe('warn');
    expect(c.detail).toEqual(['Bash(rd reply:*)']);
    s.permissions.deny = ['Bash(rd:*)'];
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(find(await run(), 'permissions').title).toMatch(/deny blocks/);
  });

  it('statusLine: rd\'s is ✓, somebody else\'s is ! (and a script that calls rd statusline is ✓), settings.local.json can override', async () => {
    await install();
    const s = readSettings();
    s.statusLine = { type: 'command', command: '~/bin/my-status.sh' };
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(statusOf(await run(), 'statusline')).toBe('warn');
    s.statusLine = { type: 'command', command: 'echo $(rd statusline) | tee -a /tmp/x' };
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(statusOf(await run(), 'statusline')).toBe('ok');
    delete s.statusLine;
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(statusOf(await run(), 'statusline')).toBe('warn');
    await install();
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'other' } }));
    expect(find(await run(), 'statusline').title).toMatch(/settings.local.json/);
  });

  it('/review-reply: missing ✗, outdated !, somebody else\'s file !', async () => {
    await install();
    const file = path.join(claudeDir, 'commands', 'review-reply.md');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text + '\nold line\n');
    expect(statusOf(await run(), 'slash-command')).toBe('warn');
    fs.writeFileSync(file, '# my own command\n');
    expect(find(await run(), 'slash-command').title).toMatch(/not written by rd/);
    fs.rmSync(file);
    expect(statusOf(await run(), 'slash-command')).toBe('fail');
  });

  it('an invalid settings.json is ✗ (Claude Code would ignore it)', async () => {
    fs.writeFileSync(settingsFile(), '{oops');
    const r = await run();
    expect(statusOf(r, 'settings-json')).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('hook prefix: a development prefix is explained, a prefix whose file is gone is ✗, mixed prefixes are !', async () => {
    await install(claudeDir, { hookPrefix: `node ${BIN}` });
    let r = await run();
    expect(find(r, 'hook-prefix').status).toBe('info');
    expect(statusOf(r, 'hooks')).toBe('ok');
    await install(claudeDir, { hookPrefix: 'node /nonexistent/dir/rd.js' });
    r = await run();
    expect(find(r, 'hook-prefix').status).toBe('fail');
    expect(find(r, 'hook-prefix').detail).toEqual(['/nonexistent/dir/rd.js']);
    const s = readSettings();
    s.hooks.Stop[0].hooks[0].command = 'rd hook stop';
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
    expect(find(await run(), 'hook-prefix').title).toMatch(/different ways/);
  });

  it('project level: ./.claude/settings.json is checked too; both levels installed is ! (hooks would run twice)', async () => {
    const proj = path.join(cwd, '.claude');
    fs.mkdirSync(proj);
    // user level empty, project installed
    await install(proj);
    let r = await run();
    expect(r.checks.filter((c) => c.group.startsWith('Claude Code project')).map((c) => c.status)).not.toContain('fail');
    expect(statusOf(r, 'installed')).toBe('info'); // user level: "installed at project level"
    expect(r.ok).toBe(true);
    // both
    await install();
    r = await run();
    expect(statusOf(r, 'duplicate-scopes')).toBe('warn');
    // project settings without rd
    fs.writeFileSync(settingsFile(proj), '{"model":"opus"}');
    r = await run();
    expect(r.checks.find((c) => c.group.startsWith('Claude Code project') && c.id === 'installed').status).toBe('info');
  });

  it('CLAUDE_CONFIG_DIR is honoured when no --config-dir is given', async () => {
    await install();
    const r = await runChecks({}, deps({ env: { PATH: '', CLAUDE_CONFIG_DIR: claudeDir } }));
    expect(statusOf(r, 'hooks')).toBe('ok');
  });
});

describe('rd doctor: environment', () => {
  it('rd on PATH: this package ✓, another rd !, none ✗ (bare hooks) or ! (dev prefix)', async () => {
    expect(statusOf(await run(), 'rd-path')).toBe('ok');
    const other = path.join(cwd, 'rd');
    fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
    expect(statusOf(await run({}, { which: (n) => (n === 'rd' ? other : null) }), 'rd-path')).toBe('warn');
    expect(statusOf(await run({}, { which: () => null }), 'rd-path')).toBe('fail');
    await install(claudeDir, { hookPrefix: `node ${BIN}` });
    expect(statusOf(await run({}, { which: () => null }), 'rd-path')).toBe('warn');
  });

  it('claude version: the verified one ✓, another !, not runnable !', async () => {
    expect(statusOf(await run(), 'claude')).toBe('ok');
    const other = await run({}, { claudeVersion: async () => ({ version: '2.9.0 (Claude Code)' }) });
    expect(statusOf(other, 'claude')).toBe('warn');
    expect(find(other, 'claude').title).toContain(`verified with ${VERIFIED_CLAUDE_VERSION}`);
    const none = await run({}, { claudeVersion: async () => ({ error: 'not found' }) });
    expect(statusOf(none, 'claude')).toBe('warn');
    expect(find(none, 'claude').title).toMatch(/version check skipped/);
  });

  it('compares claude --version with 2.1.325, the version the watcher was verified with', async () => {
    expect(VERIFIED_CLAUDE_VERSION).toBe('2.1.325');
  });

  it('node >= 22 is ✓', async () => {
    expect(statusOf(await run(), 'node')).toBe('ok');
  });
});

describe('rd doctor: RD_HOME', () => {
  it('a missing RD_HOME is information, an existing one is checked for mode 700 and write access', async () => {
    fs.rmSync(home(), { recursive: true });
    expect(statusOf(await run(), 'home')).toBe('info');
    fs.mkdirSync(home(), { mode: 0o755 });
    fs.chmodSync(home(), 0o755);
    let r = await run();
    expect(statusOf(r, 'home-mode')).toBe('warn');
    expect(find(r, 'home-mode').fix).toBe(`chmod 700 ${home()}`);
    fs.chmodSync(home(), 0o700);
    r = await run();
    expect(statusOf(r, 'home-mode')).toBe('ok');
    expect(statusOf(r, 'home-writable')).toBe('ok');
  });

  it('corrupt JSON files are ✗, unreadable review directories !', async () => {
    fs.writeFileSync(paths.sessions(), '{nope');
    let r = await run();
    expect(statusOf(r, 'home-json')).toBe('fail');
    expect(find(r, 'home-json').detail[0]).toMatch(/^sessions\.json/);
    fs.rmSync(paths.sessions());
    fs.mkdirSync(path.join(paths.reviewsDir(), 'doc-20260101-000000-abcd'), { recursive: true });
    r = await run();
    expect(statusOf(r, 'reviews')).toBe('warn');
  });

  it('a config value rd cannot use (delivery.autoResume) is ! and named; a valid one is not reported', async () => {
    fs.writeFileSync(paths.config(), JSON.stringify({ delivery: { autoResume: 'headless' } }));
    expect(find(await run(), 'config-values')).toBeUndefined();
    fs.writeFileSync(paths.config(), JSON.stringify({ delivery: { autoResume: 'sometimes' } }));
    const c = find(await run(), 'config-values');
    expect(c.status).toBe('warn');
    expect(c.detail[0]).toContain('delivery.autoResume');
    expect(c.detail[0]).toContain('"sometimes"');
  });

  it('stale lock directories are !, fresh ones are not', async () => {
    const stale = `${paths.sessions()}.lock`;
    const fresh = `${paths.docsIndex()}.lock`;
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, old, old);
    const c = find(await run(), 'locks');
    expect(c.status).toBe('warn');
    expect(c.detail).toHaveLength(1);
    expect(c.detail[0]).toContain('sessions.json.lock');
    fs.rmdirSync(stale);
    expect(statusOf(await run(), 'locks')).toBe('ok');
  });

  it('a lock inside a review directory is found too', async () => {
    const m = await createReview({ kind: 'doc', docPath: '/tmp/x.md', sessionId: 's', cwd: '/tmp', content: '# x', source: 'Write' });
    const lock = `${paths.meta(m.id)}.lock`;
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(find(await run(), 'locks').detail[0]).toContain(m.id);
  });
});

describe('rd doctor: sessions', () => {
  const deadPid = () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    return Number(r.stdout.toString());
  };

  it('a live session is fine; a zombie (pid gone, state not ended) is ! and --fix marks it ended', async () => {
    await updateSession('live-one', { cwd: '/w/live', pid: process.pid, state: 'idle' });
    await updateSession('zombie-1', { cwd: '/w/zombie', pid: deadPid(), state: 'busy', awaiting: { reviewId: 'doc-20260101-000000-abcd', since: new Date().toISOString(), pid: deadPid() } });
    let r = await run();
    expect(statusOf(r, 'zombie-sessions')).toBe('warn');
    expect(find(r, 'zombie-sessions').detail.join('\n')).toContain('zombie-1');
    expect(find(r, 'zombie-sessions').detail.join('\n')).not.toContain('live-one');
    expect(statusOf(r, 'awaiting')).toBe('warn');
    const before = fs.readFileSync(paths.sessions(), 'utf8');
    r = await run(); // without --fix nothing was written
    expect(fs.readFileSync(paths.sessions(), 'utf8')).toBe(before);

    r = await run({ fix: true });
    expect(find(r, 'zombie-sessions')).toMatchObject({ status: 'ok', fixed: true });
    const s = readSessions();
    expect(s['zombie-1']).toMatchObject({ state: 'ended', endReason: 'rd doctor --fix' });
    expect(s['zombie-1'].awaiting).toBeUndefined();
    expect(s['live-one']).toMatchObject({ state: 'idle' });
    r = await run();
    expect(statusOf(r, 'zombie-sessions')).toBe('ok');
    expect(statusOf(r, 'awaiting')).toBe('ok');
  });

  it('a dead `rd await` record on a live session is ! and --fix clears just that', async () => {
    await updateSession('live-two', { cwd: '/w', pid: process.pid, state: 'idle', awaiting: { reviewId: 'doc-20260101-000000-abcd', since: new Date().toISOString(), pid: deadPid() } });
    let r = await run();
    expect(statusOf(r, 'awaiting')).toBe('warn');
    expect(statusOf(r, 'zombie-sessions')).toBe('ok');
    r = await run({ fix: true });
    expect(find(r, 'awaiting')).toMatchObject({ status: 'ok', fixed: true });
    expect(readSessions()['live-two'].awaiting).toBeUndefined();
    expect(readSessions()['live-two'].state).toBe('idle');
  });

  it('a live `rd await` (this process) is not stale', async () => {
    await updateSession('live-three', { cwd: '/w', pid: process.pid, state: 'idle', awaiting: { reviewId: 'doc-20260101-000000-abcd', since: new Date().toISOString(), pid: process.pid } });
    expect(statusOf(await run(), 'awaiting')).toBe('ok');
  });

  it('a dead wake-up watcher record is ! and --fix clears just that; zombie handling clears it too; a live one is fine', async () => {
    await updateSession('w-live', { cwd: '/w', pid: process.pid, state: 'idle', watcher: { since: new Date().toISOString(), pid: process.pid } });
    expect(statusOf(await run(), 'watcher')).toBe('ok');
    await updateSession('w-dead', { cwd: '/w', pid: process.pid, state: 'idle', watcher: { since: new Date().toISOString(), pid: deadPid() } });
    let r = await run();
    expect(statusOf(r, 'watcher')).toBe('warn');
    expect(find(r, 'watcher').detail.join('\n')).toContain('w-dead');
    expect(find(r, 'watcher').detail.join('\n')).not.toContain('w-live');
    const before = fs.readFileSync(paths.sessions(), 'utf8');
    await run();
    expect(fs.readFileSync(paths.sessions(), 'utf8')).toBe(before); // without --fix nothing is written
    r = await run({ fix: true });
    expect(find(r, 'watcher')).toMatchObject({ status: 'ok', fixed: true });
    expect(readSessions()['w-dead'].watcher).toBeUndefined();
    expect(readSessions()['w-dead'].state).toBe('idle');
    expect(readSessions()['w-live'].watcher.pid).toBe(process.pid);

    await updateSession('w-zombie', { cwd: '/w', pid: deadPid(), state: 'busy', watcher: { since: new Date().toISOString(), pid: deadPid() } });
    await run({ fix: true });
    expect(readSessions()['w-zombie']).toMatchObject({ state: 'ended' });
    expect(readSessions()['w-zombie'].watcher).toBeUndefined();
  });

  it('a failed background resume is reported', async () => {
    const m = await createReview({ kind: 'doc', docPath: '/tmp/h.md', sessionId: 'h-sess', cwd: '/tmp', content: '# h', source: 'Write' });
    const file = paths.meta(m.id);
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.headless = { pid: deadPid(), startedAt: new Date(Date.now() - 5000).toISOString(), exitedAt: new Date().toISOString(), exitCode: 1, log: '/x/headless.log' };
    writeJsonAtomic(file, meta);
    const c = find(await run(), 'headless');
    expect(c.status).toBe('warn');
    expect(c.detail[0]).toContain('exit code 1');
  });

  it('adapter panes of live sessions that are gone are !', async () => {
    await updateSession('in-tmux', { cwd: '/w', pid: process.pid, state: 'idle', injector: { kind: 'tmux', target: '%9' } });
    const c = find(await run(), 'injector-panes');
    expect(c.status).toBe('warn');
    expect(c.detail[0]).toContain('%9');
  });
});

describe('rd doctor: hook log', () => {
  it('counts errors of the last 24 h only and names the last one', async () => {
    const day = 24 * 3600 * 1000;
    const line = (ago, scope, text) => `${new Date(Date.now() - ago).toISOString()} [${scope}] ${text}\n`;
    fs.mkdirSync(paths.logs(), { recursive: true });
    fs.writeFileSync(
      paths.log(),
      line(2 * day, 'hook stop', 'ERROR Error: too old') +
        line(3600_000, 'hook stop', 'ERROR Error: first\n    at x (file.js:1:1)') +
        line(3000_000, 'hook stop', 'injected review feedback (10 chars)') +
        line(1800_000, 'hook prompt-submit', 'TypeError: legacy entry without the marker\n    at y') +
        line(600_000, 'hook post-tool-use', 'ERROR cannot read /x: ENOENT'),
    );
    const c = find(await run(), 'log-errors');
    expect(c.status).toBe('warn');
    expect(c.title).toMatch(/^3 errors/);
    expect(c.detail[0]).toContain('[hook post-tool-use] cannot read /x');
  });

  it('logLine marks Error objects and explicit errors, nothing else', () => {
    logLine('t', new Error('boom'));
    logLine('t', 'plain information');
    logLine('t', 'went wrong', 'error');
    const log = fs.readFileSync(paths.log(), 'utf8');
    expect(log).toMatch(/\[t\] ERROR Error: boom/);
    expect(log).toMatch(/\[t\] plain information/);
    expect(log).toMatch(/\[t\] ERROR went wrong/);
    expect(recentLogErrors(paths.log(), 0).map((e) => e.text.split('\n')[0])).toEqual(['Error: boom', 'went wrong']);
  });

  it('no log file is fine', async () => {
    expect(statusOf(await run(), 'log-errors')).toBe('ok');
  });
});

describe('rd doctor: output', () => {
  it('--json is structured, and the exit code follows the ✗ count', async () => {
    let text = '';
    const { result, exitCode } = await doctorCommand({ json: true, configDir: claudeDir }, { ...deps(), out: (s) => (text += s) });
    const j = JSON.parse(text);
    expect(exitCode).toBe(1);
    expect(j.ok).toBe(false);
    expect(j.verifiedClaudeVersion).toBe(VERIFIED_CLAUDE_VERSION);
    expect(j.summary).toEqual(result.summary);
    expect(j.checks.every((c) => ['ok', 'warn', 'fail', 'info'].includes(c.status) && c.id && c.group && c.title)).toBe(true);
    await install();
    text = '';
    expect((await doctorCommand({ json: true, configDir: claudeDir }, { ...deps(), out: (s) => (text += s) })).exitCode).toBe(0);
    expect(JSON.parse(text).ok).toBe(true);
  });

  it('the text report uses ✓ ! ✗ and prints the fix line', async () => {
    const r = await run();
    const text = formatReport(r).replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toMatch(/✗ rd is not installed in Claude Code/);
    expect(text).toMatch(/✓ Node v/);
    expect(text).toMatch(/fix: rd install --dry-run/);
    expect(text).toMatch(/1 failed {2}\(exit code 1\)/);
  });

  it('is read-only: without --fix no file under RD_HOME or the config dir changes', async () => {
    await install();
    await updateSession('z', { cwd: '/w', pid: 2 ** 22 + 12345, state: 'idle' }); // pid beyond pid_max: not running
    fs.mkdirSync(paths.logs(), { recursive: true });
    fs.writeFileSync(paths.log(), `${new Date().toISOString()} [x] ERROR Error: y\n`);
    const snap = (root) => {
      const out = {};
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out[p] = `${fs.statSync(p).mtimeMs}:${fs.readFileSync(p, 'utf8')}`;
        }
      };
      walk(root);
      return out;
    };
    const before = [snap(home()), snap(claudeDir)];
    await run();
    expect([snap(home()), snap(claudeDir)]).toEqual(before);
  });

  it('runs end to end through bin/rd.js with a temp RD_HOME and CLAUDE_CONFIG_DIR (exit code 1 before install, 0 after)', async () => {
    const env = { ...process.env, RD_HOME: home(), CLAUDE_CONFIG_DIR: claudeDir };
    let r = spawnSync(process.execPath, [BIN, 'doctor', '--json'], { env, cwd, encoding: 'utf8' });
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.checks.find((c) => c.id === 'installed').status).toBe('fail');
    r = spawnSync(process.execPath, [BIN, 'install', '--yes', '--hook-prefix', `node ${BIN}`], { env, cwd, encoding: 'utf8' });
    expect(r.status).toBe(0);
    r = spawnSync(process.execPath, [BIN, 'doctor', '--json'], { env, cwd, encoding: 'utf8' });
    const after = JSON.parse(r.stdout);
    expect(after.checks.find((c) => c.id === 'hooks').status).toBe('ok');
    expect(after.checks.find((c) => c.id === 'hook-prefix').status).toBe('info');
  });
});
