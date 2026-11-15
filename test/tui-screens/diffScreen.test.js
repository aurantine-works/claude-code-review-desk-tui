import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { useTempHome } from '../helpers/env.js';
import { App } from '../../src/tui/App.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { createReview, getMeta, withReview } from '../../src/store/reviews.js';
import { appendRevision } from '../../src/store/revisions.js';
import { addThread, listThreads } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { mouse } from './harness.js';

useTempHome();
afterEach(() => cleanup());

const h = React.createElement;
const ESC = '\x1b';
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

const V1 = ['# Weekly report', '', '## Risks', 'Migrating the old store is low risk.', 'The rollback plan relies on a feature flag.', '', '## Schedule', 'Expected to finish in two weeks.'].join('\n');
const V2 = ['# Weekly report', '', '## Risks', 'Migrating the old store is medium risk, affecting three slices.', 'The rollback plan relies on a feature flag.', 'One more explanatory line.', '', '## Schedule', 'Expected to finish in two weeks.'].join('\n');
const V3 = ['# Weekly report', '', '## Risks', 'Migrating the old store is medium risk, affecting three slices.', 'The rollback plan relies on a feature flag and a gradual rollout.', 'One more explanatory line.', '', '## Schedule', 'Expected to finish in three weeks.'].join('\n');

const live = () => updateSession('s1', { cwd: '/home/dev/proj-x', pid: process.pid, state: 'idle', injector: { kind: 'none' } });

/** A doc review with one revision per text. */
async function mkRevs(texts, extra = {}) {
  await live();
  const m = await createReview({ kind: 'doc', docPath: '/tmp/week.md', sessionId: 's1', cwd: '/home/dev/proj-x', content: texts[0], source: 'Write', turn: 1, ...extra });
  for (let i = 1; i < texts.length; i++) await appendRevision(m.id, texts[i], { source: 'Edit', turn: i + 1 });
  return m;
}

function mount({ size = { columns: 160, rows: 40 }, reviewId, config = DEFAULT_CONFIG } = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size, config, reviewId, pollMs: 40, reviewPollMs: 40, wakePollMs: 100000, resumePollMs: 100000 }));
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
    mouse: async (ev, ms = 30) => {
      bus.emit('mouse', ev);
      await wait(ms);
    },
  };
}

describe('diff view', () => {
  it('a single revision has nothing to compare: says so and stays in the document', async () => {
    const m = await mkRevs([V1]);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('d');
    expect(ui.screen()).toContain('Only one revision');
    expect(ui.status()).toContain('NORMAL');
  });

  it('d shows the previous -> current revision: source text, both numbers, signs, thread marker on new lines, panel visible', async () => {
    const m = await mkRevs([V1, V2]);
    await addThread(m.id, { anchor: makeAnchor(V2, { startLine: 4, endLine: 4 }, 2), text: 'Why medium?', send: false });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    const rows = ui.rows();
    expect(rows[0]).toContain('diff rev 1→2');
    expect(rows[0]).toContain('+2 -1');
    expect(rows[0]).toContain('[d] back to text');
    expect(ui.status()).toContain('DIFF');
    const del = rows.find((r) => r.includes('Migrating the old store is low risk.'));
    const add = rows.find((r) => r.includes('Migrating the old store is medium risk'));
    expect(del).toMatch(/^ ?4 +-│ Migrating the old store is low risk\./); // old line 4, removed
    expect(add).toMatch(/^ +4▌\+│ Migrating the old store is medium risk/); // new line 4 with the thread marker, added
    expect(rows.find((r) => r.includes('One more explanatory line.'))).toMatch(/^ +6 \+│ /);
    expect(rows.find((r) => r.includes('## Schedule'))).toMatch(/^ ?7 +8 +│ ## Schedule/); // context: old 7 -> new 8
    // the thread panel stays on screen next to the diff
    expect(ui.screen()).toContain('t1 · L4');
    expect(ui.screen()).toContain('you·draft: Why medium?');
    // the source is shown, not the rendered Markdown (the heading marker stays)
    expect(ui.screen()).toContain('## Risks');
  });

  it('< and > change the base revision, ]c / [c jump between blocks of changes', async () => {
    const m = await mkRevs([V1, V2, V3]);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 3/3'))).toBe(true);
    await ui.press('d');
    expect(ui.header()).toContain('diff rev 2→3');
    await ui.press('<');
    expect(ui.header()).toContain('diff rev 1→3');
    expect(ui.screen()).toContain('Migrating the old store is low risk.'); // rev 1 text, removed by the later revisions
    await ui.press('<');
    expect(ui.screen()).toContain('Already the oldest revision');
    expect(ui.header()).toContain('diff rev 1→3');
    await ui.press('>');
    expect(ui.header()).toContain('diff rev 2→3');
    await ui.press('>');
    expect(ui.screen()).toContain('Already the newest base');
    await ui.press('<');
    const cursorBefore = ui.status();
    await ui.press(']');
    await ui.press('c');
    expect(ui.status()).not.toEqual(cursorBefore);
    await ui.press('G');
    await ui.press(']');
    await ui.press('c');
    expect(ui.screen()).toContain('No next change');
  });

  it('Enter goes back to the normal view on the new line number of the row', async () => {
    const m = await mkRevs([V1, V2, V3]);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 3/3'))).toBe(true);
    await ui.press('d'); // first change: the removed line of rev 2 -> 3 (old line 5)
    await ui.press('j'); // its replacement: new line 5
    expect(ui.status()).toContain('L5/9');
    await ui.press('\r');
    expect(ui.status()).toContain('NORMAL');
    expect(ui.status()).toContain('L5/9');
    expect(ui.header()).toContain('[d] diff');
    // d / q / Esc all leave the diff
    for (const back of ['d', 'q', ESC]) {
      await ui.press('d');
      expect(ui.status()).toContain('DIFF');
      await ui.press(back, 120);
      expect(ui.status()).toContain('NORMAL');
    }
  });

  it('the view is read-only: writing keys explain it and nothing is created', async () => {
    const m = await mkRevs([V1, V2]);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    for (const k of ['c', 'v', 'V', 'r', 'x', 's', 'A']) {
      await ui.press(k);
      expect(ui.screen()).toContain('The diff view is read-only');
      expect(ui.status()).not.toContain('INPUT');
      expect(ui.status()).not.toContain('VISUAL');
      expect(ui.status()).not.toContain('CONFIRM');
    }
    expect(listThreads(m.id)).toHaveLength(0);
  });

  it('threads follow the cursor: the drawer of the narrow layout shows the thread of the new line under it', async () => {
    const m = await mkRevs([V1, V2]);
    await addThread(m.id, { anchor: makeAnchor(V2, { startLine: 6, endLine: 6 }, 2), text: 'Why add this line?', send: false });
    const ui = mount({ reviewId: m.id, size: { columns: 80, rows: 30 } });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    expect(ui.screen()).toContain('no comment on the cursor line');
    await ui.press('j'); // new line 4 (the removed line was the first change)
    await ui.press('j'); // new line 5
    await ui.press('j'); // new line 6
    expect(await until(() => ui.screen().includes('Why add this line?'))).toBe(true);
    expect(ui.rows().every((r) => r.length < 200)).toBe(true);
    expect(ui.status()).toContain('DIFF');
  });

  it('a diff with more than 2000 changed lines shows a summary, not rows; the panel stays', async () => {
    const a = Array.from({ length: 2100 }, (_, i) => `old content ${i}`).join('\n');
    const b = Array.from({ length: 2100 }, (_, i) => `new content ${i}`).join('\n');
    const m = await mkRevs([a, b]);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    expect(ui.screen()).toContain('too many changes to show line by line');
    expect(ui.screen()).toContain('+2100 / -2100');
    expect(ui.header()).toContain('too many changes');
    expect(ui.screen()).not.toContain('old content 5');
    await ui.press('j'); // nothing to move over, nothing breaks
    await ui.press('d');
    expect(ui.status()).toContain('NORMAL');
  });

  it('scrolls like the document view: wheel, page keys, click; only the visible rows are drawn', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1} content ${'x'.repeat(i % 7)}`);
    const edited = lines.slice();
    edited[2] = 'line 3 was changed';
    edited[390] = 'line 391 was changed too';
    const m = await mkRevs([lines.join('\n'), edited.join('\n')]);
    const ui = mount({ reviewId: m.id, size: { columns: 160, rows: 30 } });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    expect(ui.screen()).toContain('line 3 was changed');
    expect(ui.screen()).not.toContain('line 391 was changed too');
    await ui.mouse(mouse('wheel', 20, 10, 'wheelDown'));
    await ui.mouse(mouse('wheel', 20, 10, 'wheelDown'));
    expect(ui.rows()[2]).not.toMatch(/^ *1 +1 /); // scrolled off the top
    await ui.press('\x04'); // Ctrl-d
    await ui.press('G');
    expect(ui.screen()).toContain('line 391 was changed too');
    // click a row: the cursor (shown as L<new line>) moves there
    const y = ui.rows().findIndex((r) => r.includes('line 391 was changed too'));
    await ui.mouse(mouse('press', 30, y));
    expect(ui.status()).toContain('L391/400');
    await ui.press('g');
    expect(ui.status()).toMatch(/L1\/400/);
    await ui.press(']');
    await ui.press('c');
    expect(ui.status()).toContain('-L3'); // the first change block starts with the removed old line 3
  });

  it('a new revision written while the diff is open becomes the new comparison', async () => {
    const m = await mkRevs([V1, V2]);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    expect(ui.header()).toContain('diff rev 1→2');
    await appendRevision(m.id, V3, { source: 'Edit', turn: 3 });
    expect(await until(() => ui.header().includes('diff rev 2→3'))).toBe(true);
    expect(ui.screen()).toContain('feature flag and a gradual rollout');
  });

  it('a finished review can still show its diff', async () => {
    const m = await mkRevs([V1, V2]);
    await withReview(m.id, (c) => {
      c.meta.status = 'closed';
    });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('closed'))).toBe(true);
    await ui.press('d');
    expect(ui.header()).toContain('diff rev 1→2');
    expect(getMeta(m.id).status).toBe('closed');
  });

  it('identical revisions (only the final newline differs) say so', async () => {
    const m = await mkRevs([V1, `${V1}\n`]);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    expect(ui.screen()).toContain('no differences');
  });

  it('? opens the help from the diff view and returns to it', async () => {
    const m = await mkRevs([V1, V2]);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    await ui.press('?');
    expect(ui.screen()).toContain('diff view');
    await ui.press('x');
    expect(ui.status()).toContain('DIFF');
  });
});
