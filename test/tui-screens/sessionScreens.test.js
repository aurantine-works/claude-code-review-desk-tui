import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { useTempHome } from '../helpers/env.js';
import { App } from '../../src/tui/App.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { createReview, getMeta, withReview, readRevision } from '../../src/store/reviews.js';
import { addThread, listThreads } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { takeUnreceived } from '../../src/store/outbox.js';
import { recordWrite } from '../../src/store/writes.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { mouse } from './harness.js';

useTempHome();
afterEach(() => cleanup());

const h = React.createElement;
const ESC = '\x1b';
const DOWN = '\x1b[B';
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

const SA = 'aaaaaaaa-1111-4222-8333-444444444444';
const SB = 'bbbbbbbb-1111-4222-8333-444444444444';
const DOC = ['# Weekly report', '', '## Risks', 'Migrating the old store is low risk.', 'Expected to finish in two weeks.'].join('\n');

let work;
let file;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-sess-screen-'));
  file = path.join(work, 'week.md');
  fs.writeFileSync(file, DOC);
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

const live = (sid = SA, extra = {}) => updateSession(sid, { cwd: work, pid: process.pid, state: 'idle', injector: { kind: 'none' }, ...extra });
const mkDoc = async (extra = {}) => {
  await live();
  return createReview({ kind: 'doc', docPath: file, sessionId: SA, cwd: work, content: DOC, source: 'Write', turn: 1, ...extra });
};

function mount({ reviewId, size = { columns: 160, rows: 40 }, config = DEFAULT_CONFIG } = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size, config, reviewId, pollMs: 40, reviewPollMs: 40, wakePollMs: 100000, resumePollMs: 100000 }));
  return {
    app,
    screen: () => strip(app.lastFrame() ?? ''),
    rows: () => strip(app.lastFrame() ?? '').split('\n'),
    status: () => strip(app.lastFrame() ?? '').split('\n').at(-1),
    header: () => strip(app.lastFrame() ?? '').split('\n')[0],
    press: async (s, ms = 40) => {
      await wait(40);
      app.stdin.write(s);
      await wait(ms);
    },
    mouse: async (ev, ms = 30) => {
      bus.emit('mouse', ev);
      await wait(ms);
    },
  };
}

describe('external modification', () => {
  it('a changed file is reported after 3 s; U asks, then makes a new revision (manual) and the banner goes away', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await wait(300);
    expect(ui.header()).not.toContain('modified outside');
    await ui.press('U');
    expect(ui.screen()).toContain('The file has not been modified outside');

    const t0 = Date.now();
    fs.writeFileSync(file, `${DOC}\nA line added from outside.`);
    await wait(1600);
    expect(ui.header()).not.toContain('modified outside'); // seen for less than 3 s: not yet
    expect(await until(() => ui.header().includes('file modified outside · U makes a new revision'), 4000)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2800);
    await ui.press(ESC); // clear the earlier notice, if any
    expect(ui.status()).toContain('U adopt edit');

    await ui.press('U');
    expect(ui.status()).toContain('CONFIRM');
    expect(ui.screen()).toContain('Make revision rev 2 from the current file');
    await ui.press('n');
    expect(getMeta(m.id).currentRevision).toBe(1);
    await ui.press('U');
    await ui.press('y');
    expect(await until(() => getMeta(m.id).currentRevision === 2)).toBe(true);
    expect(getMeta(m.id).revisions[1].source).toBe('manual');
    expect(readRevision(m.id, 2)).toContain('A line added from outside.');
    expect(await until(() => ui.screen().includes('New revision rev 2 created'))).toBe(true);
    expect(await until(() => ui.header().includes('rev 2/2'))).toBe(true);
    expect(ui.header()).not.toContain('modified outside');

    // the external edit is now the newest revision: the diff view shows it
    await ui.press('d');
    expect(ui.header()).toContain('diff rev 1→2');
    expect(ui.screen()).toContain('A line added from outside.');
  });

  it('a file that keeps changing is not reported until it settles; Claude\'s own recent write is never reported', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(file, `${DOC}\nversion ${i}`);
      await wait(900);
    }
    expect(ui.header()).not.toContain('modified outside'); // a new content every 0.9 s restarts the 3 s clock each time
    // the hook has logged a write of Claude's a moment ago: the store calls it settling
    recordWrite({ path: file, sessionId: SA, cwd: work, tool: 'Edit' });
    fs.writeFileSync(file, `${DOC}\nClaude's own write`);
    await wait(3800);
    expect(ui.header()).not.toContain('modified outside');
  });

  it('a missing file shows the snapshot banner after 3 s and U refuses; it clears when the file is back', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    fs.rmSync(file);
    await wait(1500);
    expect(ui.header()).not.toContain('file is missing');
    expect(await until(() => ui.header().includes('file is missing (showing the snapshot)'), 4000)).toBe(true);
    expect(ui.screen()).toContain('Migrating the old store is low risk.'); // the snapshot is still shown
    await ui.press('U');
    expect(ui.screen()).toContain('The file is missing, nothing to adopt');
    fs.writeFileSync(file, DOC);
    expect(await until(() => !ui.header().includes('file is missing'), 3000)).toBe(true);
  });

  it('a file over 2 MB is reported but cannot be adopted; plans and finished reviews are never checked', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 10));
    expect(await until(() => ui.header().includes('over 2MB'), 5000)).toBe(true);
    expect(ui.status()).not.toContain('U adopt edit');
    await ui.press('U');
    expect(ui.screen()).toContain('a new revision cannot be made');
    expect(getMeta(m.id).currentRevision).toBe(1);

    cleanup();
    await withReview(m.id, (c) => {
      c.meta.status = 'closed';
    });
    const ui2 = mount({ reviewId: m.id });
    await wait(3600);
    expect(ui2.header()).not.toContain('modified outside');
  });
});

describe('S: bind the review to another session', () => {
  const writers = (cur = SA) => [
    { sessionId: cur, cwd: work, project: 'proj-a', lastAt: new Date(Date.now() - 600_000).toISOString(), firstPrompt: 'Write a weekly report', source: 'transcript' },
    { sessionId: SB, cwd: path.join(work, 'other'), project: 'proj-b', lastAt: new Date(Date.now() - 3_600_000).toISOString(), firstPrompt: 'Tidy up the store migration', source: 'transcript' },
  ];

  it('lists meta.writers with the current session marked; Enter rebinds and says so', async () => {
    const m = await mkDoc({ extra: { writers: writers() } });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    expect(await until(() => ui.status().includes('S rebind') || ui.status().includes('NORMAL'))).toBe(true);
    await ui.press('S');
    expect(ui.status()).toContain('PICK');
    expect(ui.screen()).toContain('bind to another session');
    expect(ui.screen()).toContain('proj-a');
    expect(ui.screen()).toContain('proj-b');
    expect(ui.screen()).toContain('[current]');
    expect(ui.screen()).toContain('Tidy up the store migration');
    expect(ui.screen()).toMatch(/▸ proj-b/); // the first session that is not the current one is selected
    await ui.press('\r');
    expect(await until(() => getMeta(m.id).sessionId === SB)).toBe(true);
    expect(getMeta(m.id).cwd).toBe(path.join(work, 'other'));
    expect(ui.status()).toContain('NORMAL');
    expect(ui.screen()).toContain('Rebound to session bbbbbbbb (proj-b)');
  });

  it('Esc cancels, the current session is a no-op, a lone session says there is nothing else', async () => {
    const m = await mkDoc({ extra: { writers: writers() } });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('S');
    await ui.press(ESC, 120);
    expect(ui.status()).toContain('NORMAL');
    expect(getMeta(m.id).sessionId).toBe(SA);
    await ui.press('S');
    await ui.press('k'); // up to the current session
    await ui.press('\r');
    expect(ui.screen()).toContain('Already bound to this session');
    expect(getMeta(m.id).sessionId).toBe(SA);

    cleanup();
    const lone = await mkDoc({ docPath: path.join(work, 'lone.md') });
    const ui2 = mount({ reviewId: lone.id });
    expect(await until(() => ui2.screen().includes('rev 1/1'))).toBe(true);
    await ui2.press('S');
    expect(ui2.screen()).toContain('No other candidate session');
    expect(ui2.status()).toContain('NORMAL');
  });

  it('a row can be chosen with the mouse', async () => {
    const m = await mkDoc({ extra: { writers: writers() } });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('S');
    const rows = ui.rows();
    const y = rows.findIndex((r) => r.includes('proj-b'));
    await ui.mouse(mouse('press', rows[y].indexOf('proj-b'), y));
    expect(await until(() => getMeta(m.id).sessionId === SB)).toBe(true);
  });

  it('while Claude is answering the refusal of the store is shown as it is', async () => {
    const m = await mkDoc({ extra: { writers: writers() } });
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'Why?', send: true });
    await takeUnreceived(m.id, { via: 'A' }); // received, not answered
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('S');
    await ui.press('\r');
    expect(await until(() => ui.screen().includes('Rebind failed: Claude is answering this review right now'))).toBe(true);
    expect(getMeta(m.id).sessionId).toBe(SA);
    expect(listThreads(m.id)).toHaveLength(1);
  });

  it('plans and finished reviews cannot be rebound', async () => {
    await live();
    const plan = await createReview({ kind: 'plan', sessionId: SA, cwd: work, content: '# Plan\n\n1. One\n', source: 'ExitPlanMode', turn: 1 });
    const ui = mount({ reviewId: plan.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('S');
    expect(ui.screen()).toContain('Only document reviews can be rebound to another session');
  });
});

describe('help screen scrolls in a small terminal', () => {
  it('arrows and PageDown scroll, the wheel scrolls, any other key closes; the new keys are documented', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id, size: { columns: 80, rows: 24 } });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('?');
    expect(ui.status()).toContain('HELP');
    expect(ui.screen()).toContain('Ctrl-d / Ctrl-u');
    expect(ui.screen()).not.toContain('Ctrl-e / Ctrl-y'); // beyond the first screen
    const all = new Set();
    for (const r of ui.rows()) all.add(r.trim());
    const second = ui.rows()[4]; // (row 2 is the help title, which stays)
    await ui.press(DOWN);
    expect(ui.status()).toContain('HELP');
    expect(ui.rows()[3]).toEqual(second); // scrolled by one row: the second help row is now the first
    expect(ui.rows()[2]).toContain('help');
    for (let i = 0; i < 12; i++) {
      for (const r of ui.rows()) all.add(r.trim());
      await ui.press('\x1b[6~');
    }
    const text = [...all].join('\n');
    expect(text).toContain('diff view');
    expect(text).toContain('O');
    expect(text).toContain('file modified outside');
    expect(text).toContain('rebind the document to another session');
    await ui.mouse(mouse('wheel', 10, 10, 'wheelUp'));
    expect(ui.status()).toContain('HELP');
    await ui.press('x');
    expect(ui.status()).toContain('NORMAL');
  });
});
