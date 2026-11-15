import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});
const mocks = vi.hoisted(() => ({ copy: vi.fn(() => true) }));
// The clipboard sequence goes to the real stdout otherwise; everything else of the terminal module stays.
vi.mock('../../src/tui/terminal.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, copyToClipboard: (...a) => mocks.copy(...a) };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import stringWidth from 'string-width';
import { useTempHome } from '../helpers/env.js';
import { installFakeClaude } from '../helpers/fake-claude.js';
import { App } from '../../src/tui/App.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { resetAutoOpen } from '../../src/tui/lib/channelC.js';
import { createReview, getMeta } from '../../src/store/reviews.js';
import { addThread, addUserMessage, listThreads } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { readJson } from '../../src/store/io.js';
import { paths } from '../../src/store/paths.js';
import { headlessStatus } from '../../src/delivery/resume.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { mouse } from './harness.js';

const home = useTempHome();
afterEach(() => cleanup());

const h = React.createElement;
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await wait(20);
  }
  return false;
};

const SID = '11111111-2222-4333-8444-555555555555';
const DEAD_PID = 2 ** 22 + 4242;
const RD_BIN = path.resolve('bin/rd.js');
const DOC = ['# Weekly report', '', '## Risks', 'The risk of migrating the old store is low.', 'Expected to take two weeks.'].join('\n');

let work;
let fake;
const saved = {};
beforeEach(() => {
  resetAutoOpen();
  mocks.copy.mockClear();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-c-screen-'));
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
const endedSession = (over = {}) => updateSession(SID, { cwd: path.join(work, 'proj'), pid: DEAD_PID, state: 'ended', injector: { kind: 'none' }, ...over });
// The file exists (a missing one would show the "file missing" banner after 3 s).
const mkDoc = (over = {}) => {
  const docPath = path.join(work, 'week.md');
  fs.writeFileSync(docPath, DOC);
  return createReview({ kind: 'doc', docPath, sessionId: SID, cwd: path.join(work, 'proj'), content: DOC, source: 'Write', turn: 1, ...over });
};
const send = (id, text = 'Source?', line = 4) => addThread(id, { anchor: makeAnchor(DOC, { startLine: line, endLine: line }, 1), text, send: true });
const outbox = (id) => readJson(paths.outbox(id), []);

function mount({ reviewId, size = { columns: 160, rows: 40 }, config = cfg(), resumeDeps, origin } = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size, config, reviewId, pollMs: 40, reviewPollMs: 40, wakePollMs: 100000, resumePollMs: 100000, resumeDeps }));
  void origin;
  return {
    app,
    bus,
    screen: () => strip(app.lastFrame() ?? ''),
    rows: () => strip(app.lastFrame() ?? '').split('\n'),
    status: () => strip(app.lastFrame() ?? '').split('\n').at(-1),
    header: () => strip(app.lastFrame() ?? '').split('\n')[0],
    press: async (s, ms = 40) => {
      await wait(40);
      app.stdin.write(s);
      await wait(ms);
    },
    type: async (text) => {
      await wait(40);
      for (const ch of text) {
        app.stdin.write(ch);
        await wait(8);
      }
      await wait(60);
    },
    mouse: async (ev, ms = 30) => {
      bus.emit('mouse', ev);
      await wait(ms);
    },
  };
}

/** Comment on line 4 through the UI (instant mode: Enter sends). */
async function comment(ui, text) {
  await ui.press('j'.repeat(1));
  await ui.press('c');
  await ui.type(text);
  await ui.press('\r');
}

describe('channel C dialog', () => {
  it('opens by itself after a send that lands on an ended session; l leaves the feedback queued; O reopens', async () => {
    await endedSession();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    expect(ui.header()).not.toContain('O resume'); // nothing queued yet
    await ui.press('j');
    await ui.press('j');
    await ui.press('j');
    await ui.press('c');
    await ui.type('Please add the source');
    await ui.press('\r');
    expect(await until(() => ui.screen().includes('session ended · feedback not delivered yet'))).toBe(true);
    expect(ui.status()).toContain('SESSION');
    expect(ui.screen()).toContain('1 comment queued');
    expect(ui.screen()).toContain('[c] show resume command');
    expect(ui.screen()).toContain('[h] resume in background and answer');
    expect(ui.screen()).toContain('[l] leave for later');
    expect(listThreads(m.id)).toHaveLength(1);

    await ui.press('l');
    expect(ui.status()).toContain('NORMAL');
    expect(ui.screen()).toContain('Feedback stays queued');
    expect(await until(() => ui.header().includes('session ended · O resume'))).toBe(true);
    expect(outbox(m.id)).toHaveLength(1); // [l] changes nothing

    // a second message joins the same queued batch: no second pop-up
    await ui.press('c');
    await ui.type('One more question');
    await ui.press('\r');
    await wait(250);
    expect(ui.status()).toContain('NORMAL');
    expect(ui.screen()).not.toContain('feedback not delivered yet');
    expect(outbox(m.id)).toHaveLength(2);

    await ui.press('O');
    expect(await until(() => ui.screen().includes('2 comments queued'))).toBe(true);
    await ui.press('\x1b');
    expect(await until(() => ui.status().includes('NORMAL'))).toBe(true);
  });

  it('[c] shows the interactive command and copies it', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    expect(ui.screen()).toContain('[c] show resume command');
    await ui.press('c');
    const cmd = `cd ${path.join(work, 'proj')} && ${fake.bin} --resume ${SID}`;
    expect(ui.screen().replace(/[│\s]/g, '')).toContain(cmd.replace(/\s/g, ''));
    expect(mocks.copy).toHaveBeenCalledWith(cmd);
    expect(ui.screen()).toContain('Tried to copy to the clipboard');
    expect(ui.screen().replace(/[│\s]/g, '')).toContain(`rdresume${m.id}`);
    expect(outbox(m.id)).toHaveLength(1);
  });

  it('[h] resumes in the background: the header follows running -> finished, the log path is shown on failure', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id);
    process.env.FAKE_CLAUDE_SLEEP_MS = '600';
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    await ui.press('h');
    expect(await until(() => ui.status().includes('NORMAL'))).toBe(true);
    expect(ui.screen()).toContain('Session resumed in the background');
    expect(await until(() => /resuming in background \(pid \d+\)/.test(ui.header()))).toBe(true);
    const st = headlessStatus(m.id);
    expect(st.state).toBe('running');
    expect(ui.header()).not.toContain('O resume'); // channel C's hint is gone, the header says what happens
    // the fake exits with 0 without taking the feedback: the run counts as failed (it never fetched it)
    expect(await until(() => ui.header().includes('background resume failed: see'), 6000)).toBe(true);
    expect(ui.header()).toContain(`headless-${m.id}.log`);
    expect(ui.screen()).toContain('background resume failed: see');
    // the dialog tells about it too
    await ui.press('\x1b');
    await ui.press('O');
    expect(ui.screen()).toContain('Last background resume failed');
  });

  it('[h] with a claude that answers: finished, the answer arrives in the thread', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id, 'Please answer');
    process.env.FAKE_CLAUDE_HOOKS = RD_BIN;
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    await ui.press('h');
    expect(await until(() => ui.screen().includes('headless answer for t1'), 15000)).toBe(true);
    expect(await until(() => ui.header().includes('background resume finished'), 5000)).toBe(true);
    expect(ui.header()).not.toContain('failed');
  });

  it('a comment sent after a successful run is a fresh channel C situation: no failure line, [h] is offered again', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id, 'Please answer');
    process.env.FAKE_CLAUDE_HOOKS = RD_BIN;
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    await ui.press('h');
    expect(await until(() => ui.header().includes('background resume finished'), 20000)).toBe(true);
    expect(await until(() => getMeta(m.id).headless?.exitedAt)).toBeTruthy(); // the exit record follows the process
    expect(headlessStatus(m.id)).toMatchObject({ state: 'finished', exitCode: 0 });

    // the user asks something else while the session is still dead
    await wait(30);
    await send(m.id, 'What about the second line?', 5);
    expect(await until(() => ui.header().includes('session ended · O resume'))).toBe(true);
    expect(ui.header()).not.toMatch(/background resume|resuming/); // neither "failed" nor the stale "finished"
    expect(ui.header().match(/session ended/g)).toHaveLength(1); // and the session is not announced twice
    await ui.press('O');
    expect(ui.screen()).toContain('1 comment queued');
    expect(ui.screen()).toContain('[h] resume in background and answer');
    expect(ui.screen()).not.toContain('Last background resume');
  });

  it('the status of a finished run disappears once the session was resumed interactively', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id, 'Please answer');
    process.env.FAKE_CLAUDE_HOOKS = RD_BIN;
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    await ui.press('h');
    expect(await until(() => ui.header().includes('background resume finished'), 20000)).toBe(true);
    await wait(30);
    await updateSession(SID, { state: 'idle', pid: process.pid, headless: undefined, stateSince: new Date().toISOString() });
    expect(await until(() => !/background resume|resuming/.test(ui.header()))).toBe(true);
  });

  it('every refusal of startHeadless is shown in words inside the dialog, which stays open', async () => {
    // cwd-missing
    await endedSession({ cwd: path.join(work, 'gone') });
    const m = await mkDoc({ cwd: path.join(work, 'gone') });
    await send(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    await ui.press('h');
    expect(await until(() => ui.screen().includes('working directory no longer exists'))).toBe(true);
    expect(ui.status()).toContain('SESSION');
    expect(ui.screen().replace(/[│\s]/g, '')).toContain(path.join(work, 'gone')); // the box wraps the long path

    // spawn-failed: the executable does not exist
    await endedSession();
    await ui.press('\x1b');
    ui.app.unmount();
    cleanup();
    const ui2 = mount({ reviewId: m.id, config: cfg({ claudeBin: path.join(work, 'no-such-claude') }) });
    // the review was created with the missing cwd: move it to a real one
    const { withReview } = await import('../../src/store/reviews.js');
    await withReview(m.id, (c) => {
      c.meta.cwd = path.join(work, 'proj');
    });
    expect(await until(() => ui2.header().includes('O resume'))).toBe(true);
    await ui2.press('O');
    await ui2.press('h');
    expect(await until(() => ui2.screen().includes('could not start claude'))).toBe(true);
    expect(ui2.screen()).toContain('delivery.claudeBin');
  });

  it('session-alive and nothing-waiting refusals explain themselves', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    // the user resumed the session elsewhere in the meantime: the dialog closes itself
    await updateSession(SID, { pid: process.pid, state: 'idle' });
    expect(await until(() => ui.status().includes('NORMAL'))).toBe(true);
    expect(ui.screen()).toContain('The feedback is no longer waiting for a resume');
    await ui.press('O');
    expect(ui.screen()).toContain('The session is still running, no need to resume');
  });

  it('the batch is announced again after the old one was taken (a new send after delivery)', async () => {
    await endedSession();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('O');
    expect(ui.screen()).toContain('No feedback is waiting for delivery');
    await comment(ui, 'First batch');
    expect(await until(() => ui.screen().includes('feedback not delivered yet'))).toBe(true);
    await ui.press('l');
    // Claude (resumed elsewhere) takes the feedback
    const { takeUnreceived } = await import('../../src/store/outbox.js');
    await takeUnreceived(m.id, { via: 'A' });
    await ui.press('\r');
    await comment(ui, 'Second batch');
    expect(await until(() => ui.screen().includes('feedback not delivered yet'))).toBe(true);
  });

  it('buttons of the dialog can be pressed with the mouse', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    const rows = ui.rows();
    const yShow = rows.findIndex((r) => r.includes('[c] show resume command'));
    const xShow = rows[yShow].indexOf('[c]');
    await ui.mouse(mouse('press', xShow + 2, yShow));
    expect(ui.screen()).toContain('run in a terminal:');
    const yLeave = ui.rows().findIndex((r) => r.includes('[l] leave for later'));
    await ui.mouse(mouse('press', xShow + 2, yLeave));
    expect(ui.status()).toContain('NORMAL');
  });

  it('works in the narrow layout too', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id, size: { columns: 80, rows: 30 } });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('O');
    expect(ui.screen()).toContain('[h] resume in background and answer');
    for (const r of ui.rows()) expect([...r].length).toBeLessThanOrEqual(80);
    await ui.press('c');
    expect(ui.screen()).toContain('--resume');
    await ui.press('l');
  });

  it('a tip right after [l] explains that h is a one-shot start (not pressable, dim), and [h] still works', async () => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('O resume'))).toBe(true);
    await ui.press('O');
    const rows = ui.rows();
    const yH = rows.findIndex((r) => r.includes('[h] resume in background and answer'));
    const yL = rows.findIndex((r) => r.includes('[l] leave for later'));
    const yTip = rows.findIndex((r) => r.includes('Tip:'));
    expect(yH).toBeGreaterThan(-1);
    expect(yL).toBeGreaterThan(yH);
    expect(yTip).toBeGreaterThan(yL); // after [l], not under [h]
    const tip = rows.slice(yTip).join('').replace(/[│\s]/g, '');
    expect(tip).toContain('Tip:hisaone-shotstart;addinganothercommentmeansresumingagainandcostsmoretokens.Foraback-and-forth,usec');
    // the tip is text, not a button: pressing it starts nothing
    const xTip = rows[yTip].indexOf('Tip:');
    await ui.mouse(mouse('press', xTip + 2, yTip + 1));
    expect(ui.status()).toContain('SESSION');
    expect(ui.screen()).toContain('[h] resume in background and answer');
    expect(getMeta(m.id).headless).toBeUndefined();
    // it is dim like the other descriptions
    // eslint-disable-next-line no-control-regex
    expect(ui.app.lastFrame()).toMatch(/\x1b\[2m[^\n]*Tip:/);
    // [h] still works
    await ui.press('h');
    expect(await until(() => ui.status().includes('NORMAL'))).toBe(true);
    expect(ui.screen()).toContain('Session resumed in the background');
  });

  it.each([
    [80, 30],
    [80, 24],
    [60, 20],
    [60, 14],
    [60, 11],
  ])('the tip never pushes c/h/l or the Esc line off the screen (%d x %d), with and without the command', async (columns, rowsN) => {
    await endedSession();
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id, size: { columns, rows: rowsN } });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('O');
    const fits = (what) => {
      const lines = ui.screen().split('\n');
      expect(lines.length, `${what}: rows`).toBeLessThanOrEqual(rowsN);
      for (const r of lines) expect(stringWidth(r), `${what}: "${r}"`).toBeLessThanOrEqual(columns);
      for (const k of ['[c]', '[h] resume in background and answer', '[l]', 'Esc']) expect(ui.screen(), `${what}: ${k}`).toContain(k);
    };
    fits('dialog');
    await ui.press('c'); // the command appears below the buttons
    if (rowsN >= 20) expect(ui.screen()).toContain('--resume'); // (on a tiny screen the box clips the command to what fits)
    fits('dialog with the command');
    // when the roomy version still fits the tip is there, else (compact) it is left out in favour of the buttons
    const text = ui.screen().replace(/[│\s]/g, '');
    if (rowsN >= 30) expect(text).toContain('Tip:hisaone-shotstart');
    await ui.press('l');
  });

  it('batch submit (s) of an ended session opens the dialog instead of leaving the review', async () => {
    await endedSession();
    const m = await mkDoc();
    const bus = createBus();
    const ui = render(h(App, { bus, size: { columns: 160, rows: 40 }, config: { ...cfg(), review: { sendMode: 'batch' } }, pollMs: 40, reviewPollMs: 40, wakePollMs: 100000, resumePollMs: 100000 }));
    const press = async (s, ms = 40) => {
      await wait(40);
      ui.stdin.write(s);
      await wait(ms);
    };
    const screen = () => strip(ui.lastFrame() ?? '');
    await wait(120);
    await addUserDraft(m.id);
    await press('\r'); // open the review from the inbox
    expect(await until(() => screen().includes('rev 1/1'))).toBe(true);
    await press('s');
    expect(await until(() => screen().includes('feedback not delivered yet'))).toBe(true);
    expect(screen()).not.toContain('Review Desk · inbox');
  });
});

describe('delivery.autoResume = "headless"', () => {
  const auto = (over = {}) => cfg({ autoResume: 'headless', ...over });

  it('a send to an ended session starts the background resume by itself: a notice instead of the dialog, the answer arrives', async () => {
    await endedSession();
    const m = await mkDoc();
    process.env.FAKE_CLAUDE_HOOKS = RD_BIN;
    const ui = mount({ reviewId: m.id, config: auto() });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await comment(ui, 'Please add the source');
    expect(await until(() => ui.screen().includes('resumed in the background automatically'))).toBe(true);
    expect(ui.status()).toContain('NORMAL'); // no dialog
    expect(ui.screen()).not.toContain('feedback not delivered yet');
    expect(ui.screen()).toContain(`headless-${m.id}.log`);
    expect(getMeta(m.id).headless?.pid).toBeGreaterThan(0);
    expect(await until(() => ui.screen().includes('headless answer for t1'), 20000)).toBe(true);
    expect(await until(() => ui.header().includes('background resume finished'), 5000)).toBe(true);
  });

  it('with the default ("ask") the same send opens the dialog and starts nothing', async () => {
    await endedSession();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id, config: cfg() });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await comment(ui, 'Please add the source');
    expect(await until(() => ui.screen().includes('feedback not delivered yet'))).toBe(true);
    expect(getMeta(m.id).headless).toBeUndefined();
  });

  it('never starts two: a second message of the same batch, and a second review of the same session, start nothing more', async () => {
    await endedSession();
    const m = await mkDoc();
    const other = await mkDoc({ docPath: path.join(work, 'other.md') });
    fs.writeFileSync(path.join(work, 'other.md'), DOC);
    process.env.FAKE_CLAUDE_SLEEP_MS = '1500';
    const ui = mount({ reviewId: m.id, config: auto() });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await comment(ui, 'First');
    expect(await until(() => ui.screen().includes('resumed in the background automatically'))).toBe(true);
    const pid = getMeta(m.id).headless.pid;
    await ui.press('c');
    await ui.type('Second');
    await ui.press('\r');
    await wait(300);
    expect(getMeta(m.id).headless.pid).toBe(pid);
    expect(outbox(m.id)).toHaveLength(2);
    // the other review of the session: refused by startHeadless (a run of this session is going), said in a notice
    await send(other.id);
    const { startHeadless } = await import('../../src/delivery/resume.js');
    expect(await startHeadless(other.id, { config: auto() })).toMatchObject({ ok: false, reason: 'headless-running' });
    expect(getMeta(other.id).headless).toBeUndefined();
  });

  it('when the start fails the dialog opens with the reason (the user can still choose)', async () => {
    await endedSession();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id, config: auto({ claudeBin: path.join(work, 'no-such-claude') }) });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await comment(ui, 'Please add the source');
    expect(await until(() => ui.status().includes('SESSION'))).toBe(true);
    expect(ui.screen()).toContain('Automatic resume failed');
    expect(ui.screen()).toContain('could not start claude');
    expect(ui.screen()).toContain('[l] leave for later');
  });

  it('batch submit (s) resumes by itself and stays on the screen to show the notice', async () => {
    await endedSession();
    const m = await mkDoc();
    process.env.FAKE_CLAUDE_SLEEP_MS = '800';
    const bus = createBus();
    const ui = render(h(App, { bus, size: { columns: 160, rows: 40 }, config: { ...auto(), review: { sendMode: 'batch' } }, pollMs: 40, reviewPollMs: 40, wakePollMs: 100000, resumePollMs: 100000 }));
    const press = async (k, ms = 40) => {
      await wait(40);
      ui.stdin.write(k);
      await wait(ms);
    };
    const screen = () => strip(ui.lastFrame() ?? '');
    await wait(120);
    await addUserDraft(m.id);
    await press('\r');
    expect(await until(() => screen().includes('rev 1/1'))).toBe(true);
    await press('s');
    expect(await until(() => screen().includes('resumed in the background automatically'))).toBe(true);
    expect(screen()).not.toContain('Review Desk · inbox');
  });
});

async function addUserDraft(id) {
  const t = await addThread(id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'Draft question', send: false });
  void addUserMessage;
  return t;
}
