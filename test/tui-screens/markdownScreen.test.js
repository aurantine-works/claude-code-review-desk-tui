// The Markdown body in the real screens: rendered by default, M toggles, anchors stay source based.
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
import { createReview, withReview } from '../../src/store/reviews.js';
import { addThread, listThreads } from '../../src/store/threads.js';
import { makeAnchor, locate } from '../../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import stringWidth from 'string-width';
import { mouse } from './harness.js';

useTempHome();
afterEach(() => cleanup());

const h = React.createElement;
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const DOC = [
  '# 周报', // 1
  '', // 2
  '## 风险', // 3
  '迁移**旧 store** 的风险较低，因为只影响 `两个` slice。', // 4
  '- 第一项', // 5
  '', // 6
  '| 名称 | 数量 |', // 7
  '|---|--:|', // 8
  '| 苹果 | 3 |', // 9
].join('\n');
const L4 = DOC.split('\n')[3];

const mkDoc = (extra = {}) => createReview({ kind: 'doc', docPath: '/tmp/week.md', sessionId: 's1', cwd: '/home/dev/proj-x', content: DOC, source: 'Write', turn: 1, ...extra });

const withUi = (ui) => ({ ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, ...ui } });

function mount({ size = { columns: 160, rows: 40 }, reviewId, config = DEFAULT_CONFIG } = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size, config, reviewId, watch: false, pollMs: 40, reviewPollMs: 40 }));
  return {
    app,
    screen: () => strip(app.lastFrame() ?? ''),
    rows: () => strip(app.lastFrame() ?? '').split('\n'),
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
      await wait(30);
    },
    mouse: async (ev, ms = 30) => {
      await wait(30);
      bus.emit('mouse', ev);
      await wait(ms);
    },
  };
}

const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await wait(20);
  }
  return false;
};

/** Cursor character(s) drawn in inverse video on the document rows. */
const inverse = (ui) => {
  const row = (ui.app.lastFrame() ?? '').split('\n').find((r) => r.includes('\x1b[7m')) ?? ''; // the gutter number is 1;7m
  // eslint-disable-next-line no-control-regex
  return [...row.matchAll(/\x1b\[7m([^\x1b]*)\x1b\[27m/g)].map((x) => x[1]).filter((x) => x.trim());
};

describe('Markdown body: rendered by default, M toggles', () => {
  it('opens rendered: no # marks or ** on screen, md in the status bar', async () => {
    expect(DEFAULT_CONFIG.ui.markdown).toBe('rendered');
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    const screen = ui.screen();
    expect(screen).toContain('迁移旧 store 的风险较低，因为只影响 两个 slice。');
    expect(screen).not.toContain('## 风险');
    expect(screen).not.toContain('**旧');
    expect(screen).not.toContain('`两个`');
    expect(screen).toContain('• 第一项');
    expect(screen).toContain('│ 名称 │ 数量 │');
    expect(ui.rows().at(-1)).toContain('md');
    expect(ui.rows().at(-1)).toContain('L1/9'); // the line numbers are the source's
  });

  it('M switches to the source (verbatim) and back; the cursor stays on its line and the notice says which view', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await ui.press('jjj');
    expect(ui.rows().at(-1)).toContain('L4/9');
    await ui.press('M');
    let screen = ui.screen();
    expect(screen).toContain('# 周报');
    expect(screen).toContain('迁移**旧 store** 的风险较低，因为只影响 `两个` slice。');
    expect(screen).toContain('| 名称 | 数量 |');
    expect(ui.rows().at(-1)).toContain('src');
    expect(ui.rows().at(-1)).toContain('L4/9');
    expect(screen).toContain('Source view');
    await ui.press('M');
    screen = ui.screen();
    expect(screen).toContain('迁移旧 store 的风险较低');
    expect(ui.rows().at(-1)).toContain('md');
    expect(ui.rows().at(-1)).toContain('L4/9');
  });

  it('config.ui.markdown = source starts in the source view', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id, config: withUi({ markdown: 'source' }) });
    await wait(80);
    expect(ui.screen()).toContain('## 风险');
    expect(ui.rows().at(-1)).toContain('src');
    await ui.press('M');
    expect(ui.screen()).not.toContain('## 风险');
  });

  it('the mode is kept at App level: the next review opened from the inbox starts in it', async () => {
    const a = await mkDoc();
    await withReview(a.id, (c) => {
      c.meta.title = 'doc-a';
    });
    const b = await mkDoc();
    await withReview(b.id, (c) => {
      c.meta.title = 'doc-b';
    });
    const ui = mount({});
    await wait(120);
    await ui.press('\r'); // opens the first one in the list
    await wait(80);
    expect(ui.screen()).toContain('rev 1/1');
    await ui.press('M');
    expect(ui.rows().at(-1)).toContain('src');
    await ui.press('q');
    await wait(80);
    await ui.press('j');
    await ui.press('\r');
    await wait(80);
    expect(ui.screen()).toContain('rev 1/1');
    expect(ui.screen()).toContain('## 风险');
    expect(ui.rows().at(-1)).toContain('src');
  });

  it('plan reviews are Markdown too', async () => {
    const p = await createReview({ kind: 'plan', sessionId: 's1', cwd: '/home/dev/proj-x', content: '# Plan\n\n1. **Step one**\n- sub item\n', source: 'ExitPlanMode', turn: 1 });
    await withReview(p.id, (c) => {
      c.meta.hook = { pid: process.pid, since: new Date().toISOString() };
    });
    const ui = mount({ reviewId: p.id });
    await wait(80);
    expect(ui.screen()).not.toContain('# Plan');
    expect(ui.screen()).not.toContain('**Step one**');
    expect(ui.screen()).toContain('1. Step one');
    expect(ui.rows().at(-1)).toContain('md');
  });

  it('a non-Markdown file is never rendered and M says so', async () => {
    const m = await mkDoc({ docPath: '/tmp/notes.txt' });
    const ui = mount({ reviewId: m.id });
    await wait(80);
    expect(ui.screen()).toContain('## 风险');
    expect(ui.screen()).toContain('迁移**旧 store**');
    expect(ui.rows().at(-1)).not.toContain(' md');
    expect(ui.rows().at(-1)).not.toContain(' src');
    await ui.press('M');
    expect(ui.screen()).toContain('Not a Markdown file');
    expect(ui.screen()).toContain('## 风险');
  });

  it('the help screen lists M', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('?');
    expect(ui.screen()).toContain('Markdown body');
  });
});

describe('rendered mode: cursor, selection, anchors and mouse work on what is shown', () => {
  it('h / l skip the hidden markers; the inverse cursor is on the displayed character', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await ui.press('jjj');
    await ui.press('l'.repeat(2)); // 迁移 -> the third displayed character is 旧 (the ** are not stops)
    expect(inverse(ui).join('')).toContain('旧');
    await ui.press('h');
    expect(inverse(ui).join('')).toContain('移');
  });

  it('v over the displayed text of **旧 store** then c: the anchor is the source range and locate finds it', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await ui.press('jjj');
    await ui.press('ll'); // on 旧
    await ui.press('v');
    await ui.press('llllll'); // 旧 + 6 more characters = "旧 store"
    await ui.press('c');
    expect(ui.screen()).toContain('INPUT');
    await ui.type('what is this');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    const [t] = listThreads(m.id);
    expect(t.anchor.quote).toBe('旧 store');
    expect(t.anchor).toMatchObject({ startLine: 4, endLine: 4, startCol: L4.indexOf('旧 store'), endCol: L4.indexOf('旧 store') + '旧 store'.length });
    expect(DOC.split('\n')[3].slice(t.anchor.startCol, t.anchor.endCol)).toBe('旧 store');
    const loc = locate(t.anchor, DOC);
    expect(loc).toMatchObject({ found: true, startLine: 4, startCol: t.anchor.startCol, endCol: t.anchor.endCol });
    expect(t.messages[0].text).toBe('what is this');
    // the sent comment is drawn on the displayed characters, the cursor is back on its start
    await until(() => ui.screen().includes('t1 · L4'));
    expect(ui.screen()).toContain('t1 · L4');
  });

  it('selecting across the markers includes them in the quote (source is the truth)', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await ui.press('jjj');
    await ui.press('l'); // 移
    await ui.press('v');
    await ui.press('lll'); // 移, 旧, space, s
    await ui.press('c');
    await ui.type('across markers');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    expect(listThreads(m.id)[0].anchor.quote).toBe('移**旧 s');
  });

  it('a mouse click next to hidden markers puts the cursor on the displayed character; v + c then anchors it', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    // wide layout: gutter = 1 digit + 3 = 4; line 4 is on screen row 1 + 4. 迁移 occupy columns 0-3, 旧 is at text column 4.
    await ui.mouse(mouse('press', 4 + 4, 1 + 4));
    await ui.mouse(mouse('release', 4 + 4, 1 + 4));
    expect(inverse(ui).join('')).toContain('旧');
    await ui.press('v');
    await ui.press('c');
    await ui.type('click');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    expect(listThreads(m.id)[0].anchor).toMatchObject({ startLine: 4, startCol: L4.indexOf('旧'), endCol: L4.indexOf('旧') + 1, quote: '旧' });
  });

  it('an existing source anchor is drawn on the right displayed characters and the thread jumps there', async () => {
    const m = await mkDoc();
    const from = L4.indexOf('**旧');
    const to = L4.indexOf(' 的风险');
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4, startCol: from, endCol: to }, 1), text: 'Why', send: true });
    const ui = mount({ reviewId: m.id });
    await wait(120);
    expect(ui.screen()).toContain('t1 · L4');
    // ]c puts the cursor on the first displayed character of the anchor (旧), not on the hidden **
    await ui.press(']c');
    expect(inverse(ui).join('')).toContain('旧');
    // (which characters the anchor background covers is checked on the frame in markdownView.test.js, with true colours)
  });

  it('after M the source-mode cursor is on the same character; the thread anchor is unchanged', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await ui.press('jjj');
    await ui.press('ll'); // 旧
    await ui.press('M');
    // source line: 迁移**旧 ...: the cursor character is still 旧 (the ** are before it)
    expect(inverse(ui).join('')).toContain('旧');
    await ui.press('v');
    await ui.press('lll');
    await ui.press('c');
    await ui.type('selected in source');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    expect(listThreads(m.id)[0].anchor.quote).toBe('旧 st'); // v includes the character under the cursor: 旧 + 3 moves
  });
});

describe('a table wider than the pane wraps inside its cells', () => {
  const WORDS = Array.from({ length: 40 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ');
  const ROW = `| 苹果 | ${WORDS} |`;
  const WIDE = ['# 表', '', '| 名称 | 说明 |', '|---|---|', ROW, '| 梨 | short |'].join('\n');
  const colOf = (row, needle) => stringWidth(row.slice(0, row.indexOf(needle)));
  const open = async () => {
    const m = await createReview({ kind: 'doc', docPath: '/tmp/wide.md', sessionId: 's1', cwd: '/home/dev/proj-x', content: WIDE, source: 'Write', turn: 1 });
    const ui = mount({ reviewId: m.id, size: { columns: 100, rows: 30 } });
    await wait(100);
    return { m, ui };
  };

  it('the long cell wraps in its column, one source line stays one numbered line, the gutter number is on the first screen row only', async () => {
    const { ui } = await open();
    const rows = ui.rows();
    const first = rows.findIndex((r) => r.includes('word00'));
    expect(first).toBeGreaterThan(0);
    expect(rows[first]).toMatch(/^5 │ │ 苹果 │ word00 /);
    for (let k = 1; k <= 3; k++) {
      expect(rows[first + k]).toMatch(/^ {2}│ │ {6}│ word\d\d/); // no number, the same borders
      expect(rows[first + k].indexOf('│', 4)).toBe(rows[first].indexOf('│', 4));
    }
    expect(rows[first + 4]).toMatch(/^6 │ │ 梨 {3}│ short/); // the next source line is the next numbered one
    expect(rows[first + 3]).toContain('word39');
    expect(ui.rows().at(-1)).toContain('L1/6');
    await ui.press('jjjj');
    expect(ui.rows().at(-1)).toContain('L5/6');
    await ui.press('j');
    expect(ui.rows().at(-1)).toContain('L6/6'); // j moves by source line, over the wrapped screen rows
  });

  it('a comment on text in the 2nd screen row anchors the source line and quotes the cell text', async () => {
    const { m, ui } = await open();
    const rows = ui.rows();
    const r2 = rows.findIndex((r) => r.includes('word12'));
    expect(rows[r2]).not.toMatch(/^5 /); // it is the second screen row of line 5
    const x = colOf(rows[r2], 'word14');
    await ui.mouse(mouse('press', x, r2));
    await ui.mouse(mouse('release', x, r2));
    expect(ui.rows().at(-1)).toContain('L5/6');
    await ui.press('v');
    await ui.press('lllll'); // word14
    await ui.press('c');
    expect(ui.screen()).toContain('INPUT');
    await ui.type('this word');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    const [t] = listThreads(m.id);
    const at = ROW.indexOf('word14');
    expect(t.anchor.quote).toBe('word14');
    expect(t.anchor).toMatchObject({ startLine: 5, endLine: 5, startCol: at, endCol: at + 'word14'.length });
    expect(ROW.slice(t.anchor.startCol, t.anchor.endCol)).toBe('word14');
    expect(locate(t.anchor, WIDE)).toMatchObject({ found: true, startLine: 5, startCol: at });
    await until(() => ui.screen().includes('t1 · L5'));
    expect(ui.screen()).toContain('t1 · L5');
  });

  it('a selection that runs over two screen rows stays on the source line; its quote runs from the lowest to the highest source offset', async () => {
    const { m, ui } = await open();
    const rows = ui.rows();
    const r1 = rows.findIndex((r) => r.includes('word10'));
    const x = colOf(rows[r1], 'word10');
    await ui.mouse(mouse('press', x, r1));
    await ui.mouse(mouse('release', x, r1));
    await ui.press('v');
    // the rest of the first screen row's piece, the closing border, and into the next screen row
    await ui.press('l'.repeat('word10 word11 '.length + 4 + 8));
    await ui.press('c');
    await ui.type('across lines');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    const [t] = listThreads(m.id);
    const at = ROW.indexOf('word10');
    expect(t.anchor).toMatchObject({ startLine: 5, endLine: 5, startCol: at });
    // the screen rows share one display line, so the selection reaches the row's closing pipe: adjacent columns are quoted too
    expect(t.anchor.quote.startsWith('word10 word11 word12 word13')).toBe(true);
    expect(t.anchor.endCol).toBeGreaterThan(at + 'word10 word11 word12'.length);
  });
});
