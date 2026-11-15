import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { pickCandidate, CandidatePicker } from '../../src/tui/pickCandidate.js';
import { loadPicker } from '../../src/cli/addCmd.js';

afterEach(() => cleanup());

const h = React.createElement;
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const CANDS = [
  { sessionId: '11111111-aaaa-4bbb-8ccc-000000000001', cwd: '/work/proj-x', project: 'proj-x', lastAt: ago(120_000), firstPrompt: 'Write the weekly report on the store migration', source: 'transcript' },
  { sessionId: '22222222-aaaa-4bbb-8ccc-000000000002', cwd: '/work/proj-y', project: 'proj-y', lastAt: ago(7_200_000), firstPrompt: 'Draft the rollout plan for the device table', source: 'transcript' },
  { sessionId: '33333333-aaaa-4bbb-8ccc-000000000003', cwd: '/work/proj-z', project: 'proj-z', lastAt: ago(86_400_000 * 3), firstPrompt: '', source: 'transcript' },
];

/** pickCandidate with ink-testing-library's render: captures the instance so the test can type into it. */
function start(candidates = CANDS, deps = {}) {
  const box = { inst: null, unmounted: false };
  const testRender = (tree) => {
    const inst = render(tree);
    box.inst = inst;
    const unmount = inst.unmount;
    inst.unmount = () => {
      box.unmounted = true;
      unmount();
    };
    return inst;
  };
  const result = pickCandidate(candidates, { path: '/work/reports/week.md' }, { render: testRender, size: { columns: 100, rows: 20 }, ...deps });
  const screen = () => strip(box.inst?.lastFrame() ?? '');
  const press = async (s) => {
    await wait(40);
    box.inst.stdin.write(s);
    await wait(40);
  };
  return { box, result, screen, press };
}

describe('pickCandidate (rd add / rd open <path> in a terminal)', () => {
  it('lists project, age, session and first prompt; Enter returns the selected candidate and unmounts', async () => {
    const t = start();
    await wait(60);
    const text = t.screen();
    expect(text).toContain('3 sessions wrote this file');
    expect(text).toContain('/work/reports/week.md');
    expect(text).toContain('proj-x');
    expect(text).toContain('2m ago');
    expect(text).toContain('11111111');
    expect(text).toContain('Write the weekly report on the store migration');
    expect(text).toContain('Draft the rollout plan');
    expect(text).toMatch(/▸ proj-x/);
    expect(text).toContain('dir /work/proj-x');
    await t.press('j');
    expect(t.screen()).toMatch(/▸ proj-y/);
    expect(t.screen()).toContain('dir /work/proj-y');
    await t.press('\r');
    expect(await t.result).toBe(CANDS[1]);
    expect(t.box.unmounted).toBe(true);
  });

  it('keys that arrive together (SSH batching, `j` + Enter sent in one go) are separate commands', async () => {
    const t = start();
    await wait(60);
    await t.press('j\r');
    expect((await t.result).sessionId).toBe(CANDS[1].sessionId);
    cleanup();
    const t2 = start();
    await wait(60);
    await t2.press('jjk\rq');
    expect((await t2.result).sessionId).toBe(CANDS[1].sessionId);
    cleanup();
    const t3 = start();
    await wait(60);
    await t3.press('jq');
    expect(await t3.result).toBeNull();
  });

  it('moves with the arrows, g / G, and stays inside the list', async () => {
    const t = start();
    await wait(60);
    await t.press('\x1b[B');
    await t.press('\x1b[B');
    await t.press('\x1b[B'); // past the end
    expect(t.screen()).toMatch(/▸ proj-z/);
    await t.press('k');
    expect(t.screen()).toMatch(/▸ proj-y/);
    await t.press('g');
    expect(t.screen()).toMatch(/▸ proj-x/);
    await t.press('G');
    await t.press('\r');
    expect((await t.result).sessionId).toBe(CANDS[2].sessionId);
  });

  it('q, Esc and Ctrl-C cancel: null, and the instance is unmounted each time', async () => {
    for (const key of ['q', '\x1b', '\x03']) {
      const t = start();
      await wait(60);
      await t.press(key);
      await wait(80); // Esc is told apart from an escape sequence after a short delay
      expect(await t.result).toBeNull();
      expect(t.box.unmounted).toBe(true);
      cleanup();
    }
  });

  it('answers once even when keys keep coming; an empty list is null without drawing anything', async () => {
    const t = start();
    await wait(60);
    await t.press('\r');
    await t.press('\r');
    await t.press('q');
    expect((await t.result).sessionId).toBe(CANDS[0].sessionId);
    expect(await pickCandidate([], { path: '/x' }, { render: () => { throw new Error('must not draw'); } })).toBeNull();
  });

  it('a long list scrolls with the selection', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ sessionId: `s${String(i).padStart(7, '0')}-aaaa`, cwd: `/w/p${i}`, project: `proj-${i}`, lastAt: ago(60_000 * (i + 1)), firstPrompt: `prompt ${i}`, source: 'transcript' }));
    const t = start(many, { size: { columns: 100, rows: 12 } });
    await wait(60);
    expect(t.screen()).toContain('proj-0');
    expect(t.screen()).not.toContain('proj-20');
    await t.press('G');
    expect(t.screen()).toContain('proj-29');
    expect(t.screen()).not.toContain('proj-0 ');
    expect(t.screen().split('\n').length).toBeLessThanOrEqual(12);
    await t.press('\r');
    expect((await t.result).project).toBe('proj-29');
  });

  it('CandidatePicker draws at the width it is given (no row wider than the terminal)', async () => {
    const done = () => {};
    const inst = render(h(CandidatePicker, { candidates: CANDS, path: '/work/reports/week.md', onDone: done, size: { columns: 50, rows: 14 } }));
    await wait(60);
    for (const row of strip(inst.lastFrame()).split('\n')) expect([...row].length).toBeLessThanOrEqual(50);
  });

  it('loadPicker finds the component (rd add / rd open use it on a TTY) and not on a pipe', async () => {
    expect(await loadPicker({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(pickCandidate);
    expect(await loadPicker({ stdin: { isTTY: false }, stdout: { isTTY: true } })).toBeNull();
    expect(await loadPicker({ stdin: { isTTY: true }, stdout: { isTTY: false } })).toBeNull();
  });
});
