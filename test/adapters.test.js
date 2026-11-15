import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { ADAPTERS, getAdapter, isInjectable, assertInjectable, detectInjector } from '../src/delivery/adapters/index.js';
import tmux, { socketFromEnv } from '../src/delivery/adapters/tmux.js';
import ccd from '../src/delivery/adapters/ccd.js';
import { whichSync } from '../src/delivery/adapters/util.js';

useTempHome();
const RID = 'doc-20261109-142301-a3f9';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: null });
const fail = (stderr = 'boom') => ({ status: 1, stdout: '', stderr, error: new Error(stderr) });

describe('injectable text whitelist', () => {
  it('accepts only /review-reply with a valid review id (or bare)', () => {
    for (const t of ['/review-reply', `/review-reply ${RID}`, '/review-reply plan-20261111-094819-87hw']) expect(isInjectable(t)).toBe(true);
    for (const t of [
      '',
      'hello',
      '/review-reply  ' + RID,
      `/review-reply ${RID}\n`,
      `/review-reply ${RID} extra`,
      '/review-reply doc-1',
      '/review-reply ../../etc',
      '/review-reply $(touch /tmp/x)',
      `/review-reply ${RID}; rm -rf /`,
      '/review-replyX',
      '/review-reply\nrm -rf /',
      null,
      undefined,
      42,
    ]) {
      expect(isInjectable(t), JSON.stringify(t)).toBe(false);
    }
    expect(() => assertInjectable('rm -rf /')).toThrow(/refusing to inject/);
  });
  it('registry: tmux and ccd, nothing else', () => {
    expect(Object.keys(ADAPTERS)).toEqual(['tmux', 'ccd']);
    expect(getAdapter('tmux')).toBe(tmux);
    expect(getAdapter('constructor')).toBeNull();
    expect(getAdapter('none')).toBeNull();
    for (const a of Object.values(ADAPTERS)) for (const m of ['detect', 'isAlive', 'inject']) expect(typeof a[m]).toBe('function');
  });
});

describe('tmux adapter (mocked tmux)', () => {
  it('detect: pane id from $TMUX_PANE, socket from $TMUX; garbage rejected', () => {
    expect(tmux.detect({})).toBeNull();
    expect(tmux.detect({ TMUX_PANE: '%12' })).toEqual({ kind: 'tmux', target: '%12' });
    expect(tmux.detect({ TMUX_PANE: '%12', TMUX: '/tmp/tmux-0/default,4242,0' })).toEqual({ kind: 'tmux', target: '%12', socket: '/tmp/tmux-0/default' });
    expect(tmux.detect({ TMUX_PANE: '%12', TMUX: 'relative,1,0' })).toEqual({ kind: 'tmux', target: '%12' });
    expect(tmux.detect({ TMUX_PANE: '%12; rm -rf /' })).toBeNull();
    expect(tmux.detect({ TMUX_PANE: '12' })).toBeNull();
    expect(socketFromEnv({ TMUX: '/a b/c,1,0' })).toBeNull();
    expect(detectInjector({ TMUX_PANE: '%2' }).kind).toBe('tmux');
    expect(detectInjector({})).toEqual({ kind: 'none' });
  });

  it('inject: send-keys -l <text>, a pause, then Enter, as argument arrays (-S socket when known)', async () => {
    const calls = [];
    const run = vi.fn(async (file, args) => (calls.push([file, args]), ok()));
    const order = [];
    const sleep = vi.fn(async (ms) => order.push(`sleep ${ms}`));
    await tmux.inject({ kind: 'tmux', target: '%12', socket: '/tmp/tmux-0/rdD' }, `/review-reply ${RID}`, { run, sleep, enterDelayMs: 300 });
    expect(calls).toEqual([
      ['tmux', ['-S', '/tmp/tmux-0/rdD', 'send-keys', '-t', '%12', '-l', '--', `/review-reply ${RID}`]],
      ['tmux', ['-S', '/tmp/tmux-0/rdD', 'send-keys', '-t', '%12', 'Enter']],
    ]);
    expect(sleep).toHaveBeenCalledWith(300);
    // bare target string, no socket
    calls.length = 0;
    await tmux.inject('%3', '/review-reply', { run, sleep });
    expect(calls[0][1]).toEqual(['send-keys', '-t', '%3', '-l', '--', '/review-reply']);
  });

  it('inject refuses non-whitelisted text and bad panes before running anything; surfaces tmux errors', async () => {
    const run = vi.fn(async () => ok());
    await expect(tmux.inject('%1', 'rm -rf /', { run })).rejects.toThrow(/refusing/);
    await expect(tmux.inject('%1', `/review-reply ${RID}; x`, { run })).rejects.toThrow(/refusing/);
    await expect(tmux.inject('1', `/review-reply ${RID}`, { run })).rejects.toThrow(/invalid tmux pane/);
    await expect(tmux.inject({ kind: 'tmux', target: '%1; kill-server' }, `/review-reply ${RID}`, { run })).rejects.toThrow(/invalid tmux pane/);
    expect(run).not.toHaveBeenCalled();
    await expect(tmux.inject('%1', '/review-reply', { run: async () => fail('no server'), sleep: async () => {} })).rejects.toThrow(/send-keys failed: no server/);
  });

  it('isAlive / describe parse display-message output; a different pane id or a dead pane is not alive', async () => {
    const run = (out) => vi.fn(async () => ok(out));
    expect(await tmux.isAlive('%4', { run: run('%4 0 1234\n') })).toBe(true);
    expect(await tmux.isAlive('%4', { run: run('%4 1 1234\n') })).toBe(false);
    expect(await tmux.isAlive('%4', { run: run('%9 0 1234\n') })).toBe(false);
    expect(await tmux.isAlive('%4', { run: async () => fail('can\'t find pane') })).toBe(false);
    expect(await tmux.isAlive('nonsense', { run: run('') })).toBe(false);
    expect(await tmux.describe('%4', { run: run('%4 0 1234\n') })).toEqual({ paneId: '%4', dead: false, panePid: 1234 });
  });

  it('verify: the session pid must be the pane process or its descendant', async () => {
    const run = async () => ok('%4 0 100\n');
    const procs = { 300: { pid: 300, ppid: 200 }, 200: { pid: 200, ppid: 100 }, 100: { pid: 100, ppid: 1 }, 999: { pid: 999, ppid: 1 } };
    const readProc = (pid) => procs[pid] ?? null;
    expect(await tmux.verify('%4', { pid: 300 }, { run, readProc })).toEqual({ ok: true });
    expect(await tmux.verify('%4', { pid: 100 }, { run, readProc })).toEqual({ ok: true });
    expect(await tmux.verify('%4', { pid: 999 }, { run, readProc })).toMatchObject({ ok: false, reason: 'pane-process-mismatch' });
    expect(await tmux.verify('%4', {}, { run, readProc })).toMatchObject({ ok: false, reason: 'no-session-pid' });
    expect(await tmux.verify('%4', { pid: 300 }, { run: async () => fail(), readProc })).toMatchObject({ ok: false, reason: 'pane-gone' });
  });
});

// A real tmux server of our own (private socket); never touches an existing server or pane.
const haveTmux = !!whichSync('tmux');
describe.skipIf(!haveTmux)('tmux adapter (real private tmux server)', () => {
  const sock = `rdD-test-${process.pid}`;
  const t = (...args) => execFileSync('tmux', ['-L', sock, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  afterAll(() => {
    try {
      t('kill-server');
    } catch {
      /* already gone */
    }
    fs.rmSync(`/tmp/tmux-${process.getuid?.() ?? 0}/${sock}`, { force: true }); // the socket file of our private server
  });

  it('types the command into a pane, presses Enter, and verifies the pane process', async () => {
    t('new-session', '-d', '-s', 'rd', '-x', '120', '-y', '30', 'cat');
    const [pane, panePid] = t('display-message', '-p', '-t', 'rd', '#{pane_id} #{pane_pid}').split(' ');
    const socket = t('display-message', '-p', '#{socket_path}');
    const injector = { kind: 'tmux', target: pane, socket };
    expect(await tmux.isAlive(injector)).toBe(true);
    expect(await tmux.verify(injector, { pid: Number(panePid) })).toEqual({ ok: true });
    expect(await tmux.verify(injector, { pid: process.pid })).toMatchObject({ ok: false });

    await tmux.inject(injector, `/review-reply ${RID}`, { enterDelayMs: 150 });
    let screen = '';
    for (let i = 0; i < 50 && !screen.includes(`/review-reply ${RID}`); i++) {
      await new Promise((r) => setTimeout(r, 50));
      screen = t('capture-pane', '-p', '-t', pane);
    }
    // `cat` echoes the typed line back after Enter: the command shows up twice (typed echo + cat's output)
    expect(screen.split('\n').filter((l) => l.includes(`/review-reply ${RID}`)).length).toBeGreaterThanOrEqual(2);

    t('kill-server');
    expect(await tmux.isAlive(injector)).toBe(false);
    await expect(tmux.inject(injector, '/review-reply', {})).rejects.toThrow(/failed/);
  });
});

describe('ccd adapter (mocked)', () => {
  it('detect: needs CCD_SESSION and a ccd that really has `send`', () => {
    expect(ccd.detect({})).toBeNull();
    expect(ccd.detect({ CCD_SESSION: 'bad name' })).toBeNull();
    expect(ccd.detect({ CCD_SESSION: 'proj-x', PATH: '/nonexistent' })).toBeNull();
  });
  it('inject: ccd send <name> --text <text> --enter with a validated name and text', async () => {
    const run = vi.fn(async () => ok());
    await ccd.inject({ kind: 'ccd', target: 'proj-x-3f9a1c' }, `/review-reply ${RID}`, { run });
    expect(run).toHaveBeenCalledWith('ccd', ['send', 'proj-x-3f9a1c', '--text', `/review-reply ${RID}`, '--enter'], { env: undefined });
    await expect(ccd.inject('proj-x', 'rm -rf /', { run })).rejects.toThrow(/refusing/);
    await expect(ccd.inject('bad name', '/review-reply', { run })).rejects.toThrow(/invalid ccd session/);
    await expect(ccd.inject('proj-x', '/review-reply', { run: async () => fail('nope') })).rejects.toThrow(/ccd send failed: nope/);
  });
  it('isAlive: the name must appear in `ccd ls` as a whole word', async () => {
    const ls = (out, status = 0) => async () => ({ ...ok(out), status });
    expect(await ccd.isAlive('proj-x', { run: ls('proj-x  running\nother  idle\n') })).toBe(true);
    expect(await ccd.isAlive('proj-x', { run: ls('proj-x-2  running\n') })).toBe(false);
    expect(await ccd.isAlive('proj-x', { run: ls('', 1) })).toBe(false);
    expect(await ccd.isAlive('bad name', { run: ls('bad name') })).toBe(false);
  });
});

describe('whichSync', () => {
  it('finds executables on PATH only', () => {
    expect(whichSync('node', process.env.PATH)).toBeTruthy();
    expect(whichSync('definitely-not-a-binary-xyz', process.env.PATH)).toBeNull();
    expect(fs.existsSync(whichSync('node'))).toBe(true);
  });
});
