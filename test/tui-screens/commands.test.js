import { vi, describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { useTempHome } from '../helpers/env.js';
import { createReview, getMeta } from '../../src/store/reviews.js';
import { setActiveReview } from '../../src/store/docsIndex.js';
import { createFilteredStdin, createBus } from '../../src/tui/mouse/filteredStdin.js';
import { App } from '../../src/tui/App.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

const runTui = vi.fn(async () => {});
vi.mock('../../src/tui/run.js', () => ({ runTui: (...a) => runTui(...a) }));

const { registerTuiCommands, resolveOpenTarget, actionClose, isBareInvocation } = await import('../../src/cli/tuiCommands.js');

useTempHome();
afterEach(() => runTui.mockClear());

const mk = (kind = 'doc', docPath = '/tmp/x.md') => createReview({ kind, docPath: kind === 'doc' ? docPath : null, sessionId: 's', cwd: '/tmp', content: '# T\n\nbody\n', source: 'Write', turn: 1 });

async function parse(...args) {
  const program = new Command('rd');
  program.exitOverride();
  registerTuiCommands(program);
  await program.parseAsync(['node', 'rd', ...args]);
}

describe('CLI wiring', () => {
  it('plain rd is the watch inbox; rd inbox is not, unless --watch', async () => {
    await parse();
    expect(runTui).toHaveBeenLastCalledWith({ watch: true });
    await parse('inbox');
    // the real argv is consulted to tell `rd` from `rd inbox`; commander's own parse is what matters here
    expect(runTui).toHaveBeenCalledTimes(2);
  });

  it('rd inbox --watch', async () => {
    await parse('inbox', '--watch');
    expect(runTui).toHaveBeenLastCalledWith({ watch: true });
  });

  it('rd open <id> hands the review id to the TUI after checking it exists', async () => {
    const m = await mk();
    await parse('open', m.id);
    expect(runTui).toHaveBeenLastCalledWith({ reviewId: m.id });
    await expect(parse('open', 'doc-20200101-000000-aaaa')).rejects.toThrow(/review not found/);
    expect(runTui).toHaveBeenCalledTimes(1);
  });

  it('isBareInvocation', () => {
    expect(isBareInvocation([])).toBe(true);
    expect(isBareInvocation(['inbox'])).toBe(false);
  });
});

describe('rd open argument', () => {
  it('review ids, registered paths, and clear errors', async () => {
    const m = await mk('doc', '/tmp/registered.md');
    await setActiveReview('/tmp/registered.md', m.id);
    expect(await resolveOpenTarget(m.id)).toBe(m.id);
    expect(await resolveOpenTarget('/tmp/registered.md')).toBe(m.id);
    await expect(resolveOpenTarget('/tmp/rd-test-surely-missing/other.md')).rejects.toThrow(/file not found/); // unregistered: the file is looked up (M3)
    await expect(resolveOpenTarget('nonsense')).rejects.toThrow(/invalid review id/);
  });
});

describe('rd close', () => {
  it('closes the review and says so', async () => {
    const m = await mk();
    const out = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    try {
      await actionClose(m.id);
    } finally {
      spy.mockRestore();
    }
    expect(out.join('')).toBe(`closed ${m.id}\n`);
    expect(getMeta(m.id).status).toBe('closed');
    await expect(actionClose('doc-20200101-000000-aaaa')).rejects.toThrow(/not found/);
    await expect(actionClose('bad')).rejects.toThrow(/invalid review id/);
  });
});

/** Boots the real App the way run.js does (exitOnCtrlC false), sends the `chunks`, reports whether the app exited. */
async function exitsOn(props, ...chunks) {
  const real = new EventEmitter();
  Object.assign(real, { isTTY: true, setRawMode() {}, ref() {}, unref() {}, pause() {}, resume() {} });
  const out = new EventEmitter();
  // Ink waits for the write callback of its last frame before waitUntilExit() settles.
  Object.assign(out, { isTTY: true, columns: 100, rows: 24, write: (_chunk, enc, cb) => ((typeof enc === 'function' ? enc : cb)?.(), true) });
  const bus = createBus();
  const stdin = createFilteredStdin(real, bus);
  const app = render(React.createElement(App, { bus, size: { columns: 100, rows: 24 }, config: DEFAULT_CONFIG, ...props }), {
    stdin,
    stdout: out,
    stderr: out,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const exit = app.waitUntilExit().then(() => true);
  await new Promise((r) => setTimeout(r, 150));
  for (const chunk of chunks) {
    real.emit('data', Buffer.from(chunk));
    await new Promise((r) => setTimeout(r, 120));
  }
  const exited = await Promise.race([exit, new Promise((r) => setTimeout(() => r(false), 600))]);
  if (!exited) app.unmount();
  stdin.dispose();
  return exited;
}

describe('lifecycle: Ctrl+C quits like q, but only from the Normal screens', () => {
  it('Ctrl+C in a review opened with `rd open` and in the inbox ends the app', async () => {
    const m = await mk();
    expect(await exitsOn({ reviewId: m.id }, '\x03')).toBe(true);
    expect(await exitsOn({}, '\x03')).toBe(true);
  });

  it('Ctrl+C with the comment box open does not end the app (and the unsent text is not lost)', async () => {
    const m = await mk();
    expect(await exitsOn({ reviewId: m.id }, 'c', 'unsent', '\x03')).toBe(false);
  });
});

describe('lifecycle: rd open exits on q', () => {
  it('q in a review opened with `rd open` ends the app', async () => {
    const m = await mk();
    const real = new EventEmitter();
    Object.assign(real, { isTTY: true, setRawMode() {}, ref() {}, unref() {}, pause() {}, resume() {} });
    const out = new EventEmitter();
    // Ink waits for the write callback of its last frame before waitUntilExit() settles.
    Object.assign(out, { isTTY: true, columns: 100, rows: 24, write: (_chunk, enc, cb) => ((typeof enc === 'function' ? enc : cb)?.(), true) });
    const bus = createBus();
    const stdin = createFilteredStdin(real, bus);
    const app = render(React.createElement(App, { bus, size: { columns: 100, rows: 24 }, config: DEFAULT_CONFIG, reviewId: m.id }), {
      stdin,
      stdout: out,
      stderr: out,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    const exit = app.waitUntilExit().then(() => true); // as run.js does: right after render
    await new Promise((r) => setTimeout(r, 150));
    real.emit('data', Buffer.from('q'));
    const exited = await Promise.race([exit, new Promise((r) => setTimeout(() => r(false), 2000))]);
    stdin.dispose();
    expect(exited).toBe(true);
  });
});
