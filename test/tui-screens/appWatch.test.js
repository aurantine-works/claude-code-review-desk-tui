import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});
const mocks = vi.hoisted(() => ({ bell: vi.fn() }));
vi.mock('../../src/tui/terminal.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, bell: (...a) => mocks.bell(...a) };
});

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { useTempHome } from '../helpers/env.js';
import { App, resumeOkText } from '../../src/tui/App.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { createReview, withReview } from '../../src/store/reviews.js';
import { addThread } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

useTempHome();
afterEach(() => cleanup());
beforeEach(() => mocks.bell.mockClear());

const h = React.createElement;
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const until = async (fn, ms = 2500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await wait(20);
  }
  return false;
};

const SID = '11111111-2222-4333-8444-555555555555';
const DOC = ['# 周报', '', '## 风险', '迁移旧 store 的风险较低。'].join('\n');
const mkDoc = async (title) => {
  await updateSession(SID, { cwd: '/home/dev/proj-x', pid: process.pid, state: 'idle', injector: { kind: 'none' } });
  const m = await createReview({ kind: 'doc', docPath: '/tmp/week.md', sessionId: SID, cwd: '/home/dev/proj-x', content: DOC, source: 'Write', turn: 1 });
  await withReview(m.id, (c) => {
    c.meta.title = title;
  });
  return m;
};

function mount(props = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size: { columns: 120, rows: 30 }, config: DEFAULT_CONFIG, pollMs: 30, reviewPollMs: 30, wakePollMs: 100000, resumePollMs: 30, ...props }));
  return { app, screen: () => strip(app.lastFrame() ?? '') };
}

describe('watch mode: the bell rings once when a review becomes answered', () => {
  it('not for reviews that were answered before, once per transition, never without --watch', async () => {
    const early = await mkDoc('early-answered');
    await withReview(early.id, (c) => {
      c.meta.status = 'answered';
    });
    const m = await mkDoc('will-be-answered');
    await withReview(m.id, (c) => {
      c.meta.status = 'delivered';
    });
    const ui = mount({ watch: true });
    expect(await until(() => ui.screen().includes('will-be-answered'))).toBe(true);
    await wait(200);
    expect(mocks.bell).not.toHaveBeenCalled(); // start-up: what was answered already is not news

    await withReview(m.id, (c) => {
      c.meta.status = 'answered';
    });
    expect(await until(() => mocks.bell.mock.calls.length === 1)).toBe(true);
    await wait(300);
    expect(mocks.bell).toHaveBeenCalledTimes(1); // the following polls do not ring again

    // Claude edits the document, the review goes back to awaiting, then it is answered again: a new transition
    await withReview(m.id, (c) => {
      c.meta.status = 'awaiting_review';
    });
    await wait(200);
    await withReview(m.id, (c) => {
      c.meta.status = 'answered';
    });
    expect(await until(() => mocks.bell.mock.calls.length === 2)).toBe(true);
  });

  it('plain rd inbox (no watch) stays silent', async () => {
    const m = await mkDoc('quiet');
    await withReview(m.id, (c) => {
      c.meta.status = 'delivered';
    });
    const ui = mount({ watch: false });
    expect(await until(() => ui.screen().includes('quiet'))).toBe(true);
    await withReview(m.id, (c) => {
      c.meta.status = 'answered';
    });
    await wait(300);
    expect(mocks.bell).not.toHaveBeenCalled();
  });
});

describe('resume watcher in the App', () => {
  const iso = () => new Date().toISOString();

  it('hands waiting feedback over once after the ended session came back idle (and says so)', async () => {
    const m = await mkDoc('resumed-doc');
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: '依据？', send: true });
    let plan = { channel: 'C', reason: 'session-ended', sessionState: 'ended' };
    const deliver = vi.fn(async () => ({ channel: 'inject', action: 'injected', reason: 'idle-injector' }));
    const ui = mount({ resumeDeps: { planDelivery: () => plan, deliver, waitingSince: () => iso() } });
    expect(await until(() => ui.screen().includes('resumed-doc'))).toBe(true);
    await wait(250);
    expect(deliver).not.toHaveBeenCalled(); // still ended

    plan = { channel: 'A', reason: 'idle-injector', sessionState: 'busy' };
    await wait(250);
    expect(deliver).not.toHaveBeenCalled(); // alive but busy: the Stop hook / next prompt takes it

    plan = { channel: 'inject', reason: 'idle-injector', sessionState: 'idle' };
    expect(await until(() => deliver.mock.calls.length === 1)).toBe(true);
    expect(deliver).toHaveBeenCalledWith(m.id, { whenIdle: true });
    expect(await until(() => ui.screen().includes(resumeOkText()))).toBe(true);
    await wait(300);
    expect(deliver).toHaveBeenCalledTimes(1); // once per resume
  });

  it('a session that was alive when the TUI started is not touched', async () => {
    const m = await mkDoc('alive-doc');
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: '依据？', send: true });
    const deliver = vi.fn(async () => ({ action: 'none' }));
    const ui = mount({ resumeDeps: { planDelivery: () => ({ channel: 'inject', reason: 'idle-injector', sessionState: 'idle' }), deliver, waitingSince: () => iso() } });
    expect(await until(() => ui.screen().includes('alive-doc'))).toBe(true);
    await wait(400);
    expect(deliver).not.toHaveBeenCalled();
  });
});
