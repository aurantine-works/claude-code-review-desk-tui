import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { useTempHome } from '../helpers/env.js';
import { App } from '../../src/tui/App.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { createReview } from '../../src/store/reviews.js';
import { addThread, listThreads } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { paths } from '../../src/store/paths.js';

const home = useTempHome();
afterEach(() => cleanup());

const h = React.createElement;
const ESC = '\x1b';
const CTRL_E = '\x05';
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

const FAKE = fileURLToPath(new URL('../helpers/fake-editor.js', import.meta.url));
const SID = 'aaaaaaaa-1111-4222-8333-444444444444';
const DOC = ['# Weekly report', '', '## Risks', 'The risk of migrating the old store is low.', 'Expected to take two weeks.', '', 'The end.'].join('\n');

let work;
let logFile;
const env = (vars) => {
  for (const [k, v] of Object.entries({ FAKE_EDITOR_LOG: logFile, ...vars })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
const runs = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-editor-screen-'));
  logFile = path.join(work, 'editor.log');
  fs.writeFileSync(path.join(work, 'week.md'), DOC);
});
afterEach(() => {
  for (const k of ['FAKE_EDITOR_MODE', 'FAKE_EDITOR_TEXT', 'FAKE_EDITOR_LOG']) delete process.env[k];
  fs.rmSync(work, { recursive: true, force: true });
});

const config = (over = {}) => ({ ...DEFAULT_CONFIG, editor: `"${process.execPath}" "${FAKE}"`, ...over });
const mkDoc = async () => {
  await updateSession(SID, { cwd: work, pid: process.pid, state: 'idle', injector: { kind: 'none' } });
  return createReview({ kind: 'doc', docPath: path.join(work, 'week.md'), sessionId: SID, cwd: work, content: DOC, source: 'Write', turn: 1 });
};

function mount({ reviewId, size = { columns: 160, rows: 40 }, cfg = config() } = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size, config: cfg, reviewId, pollMs: 40, reviewPollMs: 40, wakePollMs: 100000, resumePollMs: 100000 }));
  return {
    screen: () => strip(app.lastFrame() ?? ''),
    status: () => strip(app.lastFrame() ?? '').split('\n').at(-1),
    press: async (s, ms = 60) => {
      await wait(40);
      app.stdin.write(s);
      await wait(ms);
    },
  };
}

describe('C / R: write in $EDITOR and send like Enter', () => {
  it('Visual line mode + C: the editor text becomes a sent comment on the selection; the file has a header that is not sent', async () => {
    const m = await mkDoc();
    env({ FAKE_EDITOR_TEXT: 'Please explain the source.\\nSecond line # not a title' });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('j');
    await ui.press('j');
    await ui.press('j'); // line 4
    await ui.press('V');
    await ui.press('j');
    await ui.press('C');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    const t = listThreads(m.id)[0];
    expect(t.anchor).toMatchObject({ startLine: 4, endLine: 5 });
    expect(t.anchor.quote).toBe('The risk of migrating the old store is low.\nExpected to take two weeks.');
    expect(t.messages[0]).toMatchObject({ author: 'user', text: 'Please explain the source.\nSecond line # not a title', state: 'sent' });

    const [run] = runs();
    expect(run.content).toContain('# Review Desk · Comment L4-5');
    expect(run.content).toContain('#   > The risk of migrating the old store is low.');
    expect(run.content).toContain('#   > Expected to take two weeks.');
    expect(run.content).toContain('Save and quit = send; empty or unchanged = cancel.');
    expect(run.mode).toBe(0o600);
    expect(run.file.startsWith(paths.tmp() + path.sep)).toBe(true);
    expect(fs.existsSync(run.file)).toBe(false); // removed again
    expect(fs.readdirSync(paths.tmp())).toEqual([]);
    expect(await until(() => ui.screen().includes('NORMAL'))).toBe(true);
    expect(ui.screen()).toContain('Please explain the source.');
  });

  it('Normal mode + C comments on the cursor line; batch mode keeps a draft and says so in the header', async () => {
    const m = await mkDoc();
    env({ FAKE_EDITOR_TEXT: 'draft text' });
    const ui = mount({ reviewId: m.id, cfg: config({ review: { ...DEFAULT_CONFIG.review, sendMode: 'batch' } }) });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    for (let i = 0; i < 4; i++) await ui.press('j'); // line 5
    await ui.press('C');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    const t = listThreads(m.id)[0];
    expect(t.anchor).toMatchObject({ startLine: 5, endLine: 5, startCol: null });
    expect(t.messages[0]).toMatchObject({ text: 'draft text', state: 'draft' });
    expect(runs()[0].content).toContain('Save and quit = save as draft (s submits)');
  });

  it('R on a thread writes the follow-up in the editor and sends it; the header names the thread and its quote', async () => {
    const m = await mkDoc();
    const t = await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'Source?', send: false });
    env({ FAKE_EDITOR_TEXT: 'One more point' });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('R');
    expect(ui.screen()).toContain('The cursor is not on a thread'); // cursor is on line 1
    await ui.press(']');
    await ui.press('c');
    await ui.press('R');
    expect(await until(() => listThreads(m.id)[0].messages.length === 2)).toBe(true);
    expect(listThreads(m.id)[0].messages[1]).toMatchObject({ author: 'user', text: 'One more point', state: 'sent' });
    const [run] = runs();
    expect(run.content).toContain(`# Review Desk · Reply ${t.id}`);
    expect(run.content).toContain('#   > The risk of migrating the old store is low.');
  });

  it('no change, or an emptied file, cancels: nothing is created', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    env({ FAKE_EDITOR_MODE: 'same' });
    await ui.press('C');
    expect(await until(() => runs().length === 1)).toBe(true);
    expect(await until(() => ui.screen().includes('No changes in the editor, cancelled'))).toBe(true);
    expect(listThreads(m.id)).toEqual([]);
    await ui.press(ESC);
    env({ FAKE_EDITOR_MODE: 'clear' });
    await ui.press('C');
    expect(await until(() => runs().length === 2)).toBe(true);
    expect(await until(() => ui.screen().includes('The editor was empty, cancelled'))).toBe(true);
    expect(listThreads(m.id)).toEqual([]);
    expect(ui.status()).toContain('NORMAL');
  });

  it('an editor that fails, is killed or is not installed: a notice, nothing sent, nothing left in tmp', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    env({ FAKE_EDITOR_MODE: 'fail' });
    await ui.press('C');
    expect(await until(() => ui.screen().includes('exited abnormally (exit code 3)'))).toBe(true);
    expect(ui.screen()).toContain('nothing was sent');
    env({ FAKE_EDITOR_MODE: 'signal' });
    await ui.press(ESC);
    await ui.press('C');
    expect(await until(() => ui.screen().includes('signal SIGKILL'))).toBe(true);
    expect(listThreads(m.id)).toEqual([]);
    expect(fs.readdirSync(paths.tmp())).toEqual([]);
  });

  it('a missing editor says so', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id, cfg: config({ editor: '/nonexistent/editor-xyz --wait' }) });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('C');
    expect(await until(() => ui.screen().includes('Cannot use editor'))).toBe(true);
    expect(ui.screen()).toContain('command not found');
    expect(listThreads(m.id)).toEqual([]);
  });

  it('a finished review is read-only: C does not even start the editor', async () => {
    const m = await mkDoc();
    const { closeReview } = await import('../../src/store/lifecycle.js');
    await closeReview(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('C');
    expect(ui.screen()).toContain('Review is finished');
    expect(runs()).toEqual([]);
  });
});

describe('Ctrl+E in the comment box', () => {
  it('hands the box text to the editor and takes the result back (header not included)', async () => {
    const m = await mkDoc();
    env({ FAKE_EDITOR_TEXT: 'An appended line' });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('c');
    expect(ui.status()).toContain('INPUT');
    await ui.press('draft', 400);
    await ui.press(CTRL_E);
    expect(await until(() => runs().length === 1)).toBe(true);
    const [run] = runs();
    expect(run.content).toContain('# Review Desk · Comment L1');
    expect(run.content).toContain('Save and quit = back to the input box');
    expect(run.content.endsWith('draft\n')).toBe(true);
    expect(await until(() => ui.screen().includes('An appended line'))).toBe(true);
    expect(ui.screen()).toContain('draft');
    expect(ui.screen()).not.toContain('Review Desk · Comment');
    expect(listThreads(m.id)).toEqual([]); // nothing sent: the text is back in the box
    expect(ui.status()).toContain('INPUT');
  });

  it('a failing editor keeps the box text and says so', async () => {
    const m = await mkDoc();
    env({ FAKE_EDITOR_MODE: 'fail' });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('c');
    await ui.press('keep me', 400);
    await ui.press(CTRL_E);
    expect(await until(() => ui.screen().includes('the text in the box was kept'))).toBe(true);
    expect(ui.screen()).toContain('keep me');
    expect(ui.status()).toContain('INPUT');
  });

  it('an unchanged file leaves the text as it was', async () => {
    const m = await mkDoc();
    env({ FAKE_EDITOR_MODE: 'same' });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('c');
    await ui.press('original text', 400);
    await ui.press(CTRL_E);
    expect(await until(() => ui.screen().includes('No changes in the editor, the box is unchanged'))).toBe(true);
    expect(ui.screen()).toContain('original text');
  });
});
