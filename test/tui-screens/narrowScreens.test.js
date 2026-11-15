// M4: the narrow layout. Every key screen is rendered at 80x24 (the acceptance size) and at 60x20, and must (1) never draw a
// row wider than the terminal or more rows than it has, (2) keep what the user needs on screen: buttons, the command to copy,
// the cursor position, the way out.
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
import stringWidth from 'string-width';
import { useTempHome } from '../helpers/env.js';
import { App } from '../../src/tui/App.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { resetAutoOpen } from '../../src/tui/lib/channelC.js';
import { createReview, withReview } from '../../src/store/reviews.js';
import { appendRevision } from '../../src/store/revisions.js';
import { addThread } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { buildStatusBar } from '../../src/tui/lib/statusModel.js';
import { ellipsize, ellipsizeStart, fitVariant } from '../../src/tui/lib/ansi.js';

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

const SA = 'aaaaaaaa-1111-4222-8333-444444444444';
const SB = 'bbbbbbbb-1111-4222-8333-444444444444';
const DEAD_PID = 2 ** 22 + 777;
const LONG_DIR = '/home/dev/some/very/long/project/directory/name/that/goes/on/and/on/reports/week-45';
const DOC = [
  '# 周报 · Week 45',
  '',
  '## 摘要',
  '',
  '本周完成了设备表格的重构，主要工作集中在 store 迁移与 slice 拆分。整体进度符合预期，但仍有两处风险需要关注。',
  '',
  '## 风险',
  '',
  '迁移旧 store 的风险较低，因为只影响 device 和 policy 两个 slice。',
  'The rollback plan relies on a feature flag; see `store.migrate()` for details.',
  '',
  '| 模块 | 负责人 | 说明 | 链接 |',
  '|---|---|---|---|',
  '| 设备表格重构 | 张三 | 拆分 device slice，迁移旧 store，补充测试 | https://example.com/very/long/url/that/never/ends/and/keeps/going |',
  '',
  `路径 ${LONG_DIR}/src/components/DeviceTable/DeviceTableRow.tsx 需要修改。`,
  '',
  '- 风险一：旧数据格式不兼容',
  '- 风险二：并发写入时的锁竞争',
].join('\n');

let work;
beforeEach(() => {
  resetAutoOpen();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-narrow-'));
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

const live = (sid = SA, extra = {}) => updateSession(sid, { cwd: work, pid: process.pid, state: 'idle', injector: { kind: 'none' }, ...extra });
const mkDoc = async ({ content = DOC, sid = SA, name = 'week.md', cwd = work, writers = null } = {}) => {
  const docPath = path.join(work, name);
  fs.writeFileSync(docPath, content);
  return createReview({ kind: 'doc', docPath, sessionId: sid, cwd, content, source: 'Write', turn: 1, extra: writers ? { writers } : {} });
};
const thread = (id, line, text, send = false) => addThread(id, { anchor: makeAnchor(DOC, { startLine: line, endLine: line }, 1), text, send });

function mount({ reviewId, size, config = DEFAULT_CONFIG, watch = false } = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size, config, reviewId, watch, pollMs: 40, reviewPollMs: 40, wakePollMs: 100000, resumePollMs: 100000 }));
  const rows = () => strip(app.lastFrame() ?? '').split('\n');
  return {
    app,
    screen: () => rows().join('\n'),
    rows,
    header: () => rows()[0],
    status: () => rows().at(-1),
    press: async (s, ms = 60) => {
      await wait(40);
      app.stdin.write(s);
      await wait(ms);
    },
    /** Every row fits the terminal and the whole screen is not taller than it. */
    expectFits: (cols, rowsN, what = '') => {
      const r = rows();
      const widest = Math.max(...r.map((l) => stringWidth(l)));
      expect(widest, `${what} widest row`).toBeLessThanOrEqual(cols);
      expect(r.length, `${what} number of rows`).toBeLessThanOrEqual(rowsN);
    },
  };
}

const SIZES = [
  { columns: 80, rows: 24 },
  { columns: 60, rows: 20 },
];

describe.each(SIZES)('narrow layout $columns x $rows', (size) => {
  const { columns: cols, rows: rowsN } = size;

  it('review: Chinese text wraps inside the width, thread cards sit in the drawer, the status bar keeps the cursor position', async () => {
    await live();
    const m = await mkDoc();
    await thread(m.id, 9, '风险低的依据是什么？列出受影响的 slice，并说明回滚方案。', true);
    await withReview(m.id, (ctx) => {
      ctx.threads[0].messages.push({ id: 'm2', author: 'claude', text: '两个 slice 只被 device 表格组件引用，没有跨 slice 依赖。', at: new Date().toISOString(), revision: 1 });
      ctx.threads[0].status = 'answered';
    });
    const ui = mount({ reviewId: m.id, size, config: { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, markdown: 'source' } } });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    ui.expectFits(cols, rowsN, 'open');
    expect(ui.screen()).toContain('周报 · Week 45');
    expect(ui.screen()).toMatch(/Comments \(1\)/);
    expect(ui.status()).toContain('NORMAL');
    expect(ui.status()).toContain('L1/'); // the cursor position is not pushed out of the bar
    for (let i = 0; i < 8; i++) await ui.press('j');
    expect(ui.screen()).toContain('▌t1');
    expect(ui.screen()).toContain('风险低的依据是什么');
    expect(ui.screen()).toContain('Claude:');
    ui.expectFits(cols, rowsN, 'cursor on a thread');
    await ui.press('\x1b', 120); // the one-time delivery hint (a notice) gives way to the cursor position
    expect(ui.status()).toContain('L9/');
  });

  it('review: the comment box floats at the bottom, inside the width, with both buttons and the Chinese text wrapped', async () => {
    await live();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id, size });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('V');
    await ui.press('j');
    await ui.press('c');
    expect(ui.status()).toContain('INPUT');
    await ui.press('这是一条很长的中文批注，用来测试输入框在窄终端中的折行和按钮位置是否正确，应该会折成两到三行。', 300);
    ui.expectFits(cols, rowsN, 'comment box');
    const box = ui.rows().filter((l) => /^[│╭╰]/.test(l));
    expect(box.length).toBeGreaterThanOrEqual(5);
    expect(box.some((l) => l.includes('send') && l.includes('cancel'))).toBe(true);
    expect(box.map((l) => stringWidth(l))).toSatisfy((ws) => ws.every((w) => w === cols));
    expect(ui.screen()).toContain('应该会折成');
    // the status bar keeps the way out and, on the narrow one, drops what does not fit instead of cutting it
    expect(ui.status()).toContain('Esc');
    expect(ui.status()).toContain('L');
  });

  it('review: the approve confirmation keeps its y / n buttons', async () => {
    await live();
    const m = await createReview({ kind: 'plan', sessionId: SA, cwd: work, content: '# Plan\n\n1. Step one\n2. Step two\n', source: 'ExitPlanMode', turn: 1 });
    const ui = mount({ reviewId: m.id, size });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('A');
    expect(ui.status()).toContain('CONFIRM');
    expect(ui.status()).toMatch(/y approve\s+n cancel/);
    ui.expectFits(cols, rowsN, 'confirm');
  });

  it('help takes the whole area below the header (the drawer included)', async () => {
    await live();
    const m = await mkDoc();
    await thread(m.id, 9, 'Why?');
    const ui = mount({ reviewId: m.id, size });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('?');
    expect(ui.status()).toContain('HELP');
    const r = ui.rows();
    expect(r.length).toBe(rowsN);
    expect(r[2]).toContain('Review Desk · help');
    expect(r.slice(2, -1).every((l) => l.trim() !== '')).toBe(true); // help text down to the status bar, no leftover drawer / rule
    expect(r.some((l) => l.includes('Comments (1)'))).toBe(false);
    ui.expectFits(cols, rowsN, 'help');
    await ui.press('G'); // any other key closes it
    expect(ui.status()).toContain('NORMAL');
  });

  it('diff view fits and shows both gutters', async () => {
    await live();
    const m = await mkDoc();
    await appendRevision(m.id, DOC.replace('预计', '预计').replace('风险一', '风险一（已修订）'), { source: 'Edit', turn: 2 });
    const ui = mount({ reviewId: m.id, size });
    expect(await until(() => ui.screen().includes('rev 2/2'))).toBe(true);
    await ui.press('d');
    expect(ui.header()).toContain('diff rev 1→2');
    expect(ui.status()).toContain('DIFF');
    ui.expectFits(cols, rowsN, 'diff');
    expect(ui.screen()).toContain('风险一（已修订）');
  });

  it('inbox: whole hints only, the list fits, the footer is never cut in the middle of a hint', async () => {
    await live();
    const m = await mkDoc();
    await createReview({ kind: 'plan', sessionId: SA, cwd: work, content: '# 一个标题特别特别特别特别长的执行计划，用来测试收件箱列的截断\n', source: 'ExitPlanMode', turn: 1 });
    void m;
    const ui = mount({ size, watch: true });
    expect(await until(() => ui.screen().includes('inbox'))).toBe(true);
    ui.expectFits(cols, rowsN, 'inbox');
    const footer = ui.status().trim();
    const parts = footer.replace(/\s+watching$/, '').split(' · ');
    const known = ['↑↓/jk select', 'Enter open', 'a show all', 'x close review', '? help', 'q quit'];
    for (const p of parts) expect(known, `footer part "${p}"`).toContain(p.trim());
    expect(footer).toContain('Enter open');
    expect(footer).toContain('q quit');
    await ui.press('x');
    expect(ui.status()).toMatch(/y confirm\s+n cancel/);
    ui.expectFits(cols, rowsN, 'inbox confirm');
  });

  it('channel C dialog: the options, the command to copy and the way out are all on screen', async () => {
    const proj = path.join(work, 'proj', 'x'.repeat(10), 'y'.repeat(10));
    fs.mkdirSync(proj, { recursive: true });
    await updateSession(SA, { cwd: proj, pid: DEAD_PID, state: 'ended', injector: { kind: 'none' } });
    const m = await mkDoc({ cwd: proj });
    const ui = mount({ reviewId: m.id, size });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('c');
    await ui.press('first feedback', 200);
    await ui.press('\r', 300);
    expect(await until(() => ui.screen().includes('session ended · feedback not delivered yet'))).toBe(true);
    ui.expectFits(cols, rowsN, 'dialog');
    expect(ui.screen()).toMatch(/\[c\]/);
    expect(ui.screen()).toMatch(/\[h\]/);
    expect(ui.screen()).toMatch(/\[l\]/);
    expect(ui.screen()).toContain('Esc');
    await ui.press('c', 300); // show the command
    ui.expectFits(cols, rowsN, 'dialog with the command');
    expect(ui.screen()).toContain('claude --resume');
    expect(ui.screen()).toContain(SA);
    expect(ui.screen()).toContain('Esc close');
    expect(ui.status()).toContain('SESSION');
  });

  it('S session picker: both sessions listed, the directory keeps the end of the path', async () => {
    await live();
    const m = await mkDoc({
      writers: [
        { sessionId: SA, cwd: LONG_DIR, project: 'week-45', lastAt: new Date().toISOString(), firstPrompt: 'Write this week\'s store migration up as a report', source: 'writes' },
        { sessionId: SB, cwd: `${LONG_DIR}/other/nested/directory`, project: 'another-project-name', lastAt: new Date(Date.now() - 300000).toISOString(), firstPrompt: 'Summarise the migration for the team', source: 'transcript' },
      ],
    });
    const ui = mount({ reviewId: m.id, size });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await ui.press('S');
    expect(ui.status()).toContain('PICK');
    ui.expectFits(cols, rowsN, 'picker');
    expect(ui.screen()).toContain('week-45');
    expect(ui.screen()).toContain('bbbbbbbb');
    const dir = ui.rows().find((l) => l.includes('dir '));
    expect(dir).toBeTruthy();
    expect(dir).toContain('nested/directory'); // the tail, not the head, of the path
    expect(dir).toContain('…');
  });

  it('wide Markdown table, a long URL and a long path: nothing is wider than the terminal in either view', async () => {
    await live();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id, size });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    for (let i = 0; i < 11; i++) await ui.press('j', 20);
    ui.expectFits(cols, rowsN, 'rendered');
    await ui.press('M');
    ui.expectFits(cols, rowsN, 'source');
    await ui.press('G');
    ui.expectFits(cols, rowsN, 'end of document');
  });

  it('external change banner and the header fit', async () => {
    await live();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id, size });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    fs.writeFileSync(path.join(work, 'week.md'), `${DOC}\nA line added from outside.`);
    expect(await until(() => ui.header().includes('modified outside'), 6000)).toBe(true);
    expect(stringWidth(ui.header())).toBeLessThanOrEqual(cols);
    expect(ui.header()).toContain('U'); // the key that resolves it
    ui.expectFits(cols, rowsN, 'banner');
  });
});

describe('status bar fitting', () => {
  const base = { mode: 'normal', sendMode: 'instant', readOnly: false, canReply: false, canResolve: false, resolved: false, drafts: 0, notice: null, confirm: null, mouseOn: true, cursorText: 'L12/340', mdMode: 'rendered' };
  const text = (s, cols) => buildStatusBar({ ...base, ...s }, cols).segs.map((x) => x.text).join('');

  it('is exactly as wide as the terminal in every mode and width', () => {
    const states = [
      {},
      { mode: 'visual', visualKind: 'char' },
      { mode: 'input' },
      { mode: 'input', sendMode: 'batch' },
      { mode: 'help' },
      { mode: 'menu' },
      { mode: 'dialog' },
      { mode: 'picker' },
      { mode: 'confirm', confirm: { text: 'Approve this plan (Claude is not waiting; it lets the plan through the next time it submits it or enters Q&A)? 3 drafts will be ignored.', yes: 'approve', no: 'cancel' } },
      { notice: { text: 'sent · delivered with your next message · this is a rather long notice text used to test truncation', kind: 'info' } },
      { notice: { text: 'x'.repeat(200), kind: 'err' } },
    ];
    for (const cols of [40, 60, 80, 110]) for (const s of states) expect(stringWidth(text(s, cols)), `${JSON.stringify(s).slice(0, 60)} @${cols}`).toBe(cols);
  });

  it('the confirm buttons survive any question length', () => {
    for (const cols of [40, 60, 80]) {
      const t = text({ mode: 'confirm', confirm: { text: 'A very long question. '.repeat(30), yes: 'approve', no: 'cancel' } }, cols);
      expect(t).toMatch(/y approve\s+n cancel/);
    }
  });

  it('input hints shorten before they push the cursor position out', () => {
    const t = text({ mode: 'input' }, 80);
    expect(t).toContain('Esc cancel');
    expect(t).toContain('L12/340');
    expect(text({ mode: 'input' }, 120)).toContain('Ctrl+E editor');
  });

  it('a long notice takes the whole bar (the right-hand info gives way), a short one leaves it', () => {
    const long = text({ notice: { text: 'This is a rather long notice text, '.repeat(4), kind: 'info' } }, 60);
    expect(long).toContain('…');
    expect(long).not.toContain('L12/340');
    expect(text({ notice: { text: 'sent', kind: 'info' } }, 60)).toContain('L12/340');
  });

  it('an information notice does not hide the comment box hints; a warning does', () => {
    expect(text({ mode: 'input', notice: { text: 'type /review-reply in Claude', kind: 'info' } }, 80)).toContain('Enter send');
    expect(text({ mode: 'input', notice: { text: 'editor exited abnormally', kind: 'err' } }, 80)).toContain('editor exited abnormally');
  });

  it('visual mode offers C (the editor)', () => {
    expect(text({ mode: 'visual', visualKind: 'line' }, 120)).toContain('C editor');
  });
});

describe('text fitting helpers', () => {
  it('ellipsize keeps the head, ellipsizeStart the tail, both within the width', () => {
    expect(ellipsize('你好世界ABC', 7)).toBe('你好世…');
    expect(ellipsizeStart('/very/long/path/to/file.md', 14)).toBe('…th/to/file.md');
    expect(ellipsizeStart('short', 14)).toBe('short');
    expect(stringWidth(ellipsizeStart('/目录/很长很长/文件.md', 9))).toBeLessThanOrEqual(9);
    expect(ellipsize('abc', 0)).toBe('');
  });
  it('fitVariant takes the longest variant that fits, else cuts the shortest', () => {
    expect(fitVariant(10, ['0123456789ABC', '0123456789', 'abc'])).toBe('0123456789');
    expect(fitVariant(4, ['0123456789ABC', '0123456789', 'abcdef'])).toBe('abc…');
  });
});

void home;
