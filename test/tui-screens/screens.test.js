import { vi } from 'vitest';

// Make chalk emit ANSI so styling paths run too; the helpers strip it before asserting.
vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import stringWidth from 'string-width';
import { useTempHome } from '../helpers/env.js';
import { App } from '../../src/tui/App.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { createReview, getMeta, withReview } from '../../src/store/reviews.js';
import { addThread, replyToThread, listThreads } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { takeUnreceived } from '../../src/store/outbox.js';
import { readJson } from '../../src/store/io.js';
import { paths } from '../../src/store/paths.js';
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

const DOC = [
  '# 周报',
  '',
  '## 风险',
  '迁移旧 store 的风险较低，因为只影响两个 slice。',
  'The rollback plan relies on a feature flag.',
  '',
  '## 排期',
  '预计两周完成。',
].join('\n');

const mkDoc = (extra = {}) => createReview({ kind: 'doc', docPath: '/tmp/week.md', sessionId: 's1', cwd: '/home/dev/proj-x', content: DOC, source: 'Write', turn: 1, ...extra });
const mkPlan = async () => {
  const m = await createReview({ kind: 'plan', sessionId: 's1', cwd: '/home/dev/proj-x', content: '# Plan\n\n1. Step one\n2. Step two\n', source: 'ExitPlanMode', turn: 1 });
  await withReview(m.id, (ctx) => {
    ctx.meta.hook = { pid: process.pid, since: new Date().toISOString() };
  });
  return m;
};

function mount({ size = { columns: 160, rows: 40 }, reviewId, watch = false, config = DEFAULT_CONFIG } = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size, config, reviewId, watch, pollMs: 40, reviewPollMs: 40 }));
  return {
    app,
    bus,
    stderr: () => app.stderr.frames.join('|'),
    screen: () => strip(app.lastFrame() ?? ''),
    rows: () => strip(app.lastFrame() ?? '').split('\n'),
    // Ink subscribes useInput handlers in passive effects, so give the previous keystroke's re-render a moment first.
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

describe('Inbox', () => {
  it('lists reviews sorted by what needs the user, hides finished ones, toggles with a', async () => {
    const answered = await mkDoc();
    await addThread(answered.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'q', send: true });
    const t = listThreads(answered.id)[0];
    await replyToThread(answered.id, t.id, 'a');
    await withReview(answered.id, (c) => {
      c.meta.status = 'answered';
      c.meta.title = 'answered-doc';
    });
    const awaiting = await mkDoc();
    await withReview(awaiting.id, (c) => {
      c.meta.title = 'awaiting-doc';
    });
    const done = await mkDoc();
    await withReview(done.id, (c) => {
      c.meta.status = 'approved';
      c.meta.title = 'finished-doc';
    });

    const ui = mount();
    await wait(80);
    let rows = ui.rows();
    expect(rows[0]).toContain('Review Desk');
    expect(rows[0]).toContain('inbox');
    expect(rows[0]).toContain('1 open · 1 answered');
    const order = rows.map((r) => (r.includes('awaiting-doc') ? 'a' : r.includes('answered-doc') ? 'b' : r.includes('finished-doc') ? 'c' : '')).filter(Boolean);
    expect(order).toEqual(['a', 'b']);
    expect(rows.join('\n')).toContain('answered (1/1)');
    expect(rows.join('\n')).toContain('proj-x');
    await ui.press('a');
    expect(ui.screen()).toContain('finished-doc');
    expect(ui.screen()).toContain('(all)');
    await ui.press('a');
    expect(ui.screen()).not.toContain('finished-doc');
  });

  it('Enter opens the selected review, q returns', async () => {
    const m = await mkDoc();
    await withReview(m.id, (c) => {
      c.meta.title = 'my-doc';
    });
    const ui = mount();
    await wait(80);
    await ui.press('\r');
    expect(ui.screen()).toContain('rev 1/1');
    expect(ui.screen()).toContain('迁移旧 store');
    await ui.press('q');
    expect(ui.screen()).toContain('inbox');
  });

  it('Ctrl+C in a review opened from the inbox returns to it, like q (Ink no longer quits on it)', async () => {
    await mkDoc();
    const ui = mount();
    await wait(80);
    await ui.press('\r');
    expect(ui.screen()).toContain('rev 1/1');
    await ui.press('\x03');
    expect(ui.screen()).toContain('inbox');
    expect(ui.screen()).not.toContain('rev 1/1');
  });

  it('Ctrl+C cancels the close confirmation like n', async () => {
    const m = await mkDoc();
    const ui = mount();
    await wait(80);
    await ui.press('x');
    expect(ui.screen()).toContain('Close "');
    await ui.press('\x03');
    expect(ui.screen()).not.toContain('y confirm');
    await wait(60);
    expect(getMeta(m.id).status).toBe('awaiting_review');
  });

  it('x closes the selected review after confirmation', async () => {
    const m = await mkDoc();
    const ui = mount();
    await wait(80);
    await ui.press('x');
    expect(ui.screen()).toContain('Close "');
    await ui.press('n');
    expect(getMeta(m.id).status).toBe('awaiting_review');
    await ui.press('x');
    await ui.press('y');
    expect(await until(() => getMeta(m.id).status === 'closed')).toBe(true);
    await until(() => !ui.screen().includes(m.id) && !ui.screen().includes('周报'));
    expect(ui.screen()).toContain('Nothing to review');
  });

  it('a mouse click on a row opens it', async () => {
    await mkDoc();
    const ui = mount();
    await wait(80);
    await ui.mouse(mouse('press', 10, 2));
    expect(ui.screen()).toContain('rev 1/1');
  });

  it('empty inbox says what it is waiting for in watch mode', async () => {
    const ui = mount({ watch: true });
    await wait(60);
    expect(ui.screen()).toContain('Waiting for Claude Code to submit a plan');
    expect(ui.screen()).toContain('watching');
  });
});

/** An idle, alive session without an injector: feedback travels by channel A (the user's next message). */
const mkSession = (extra = {}) =>
  updateSession('s1', { cwd: '/home/dev/proj-x', pid: process.pid, state: 'idle', stateSince: new Date(Date.now() - 60_000).toISOString(), injector: { kind: 'none' }, ...extra });

const T = (rows, text) => rows.findIndex((r) => r.includes(text));

describe('Review: rendering', () => {
  it('wide layout: line numbers, markers, thread cards next to the document', async () => {
    const m = await mkDoc();
    const t = await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'What is the basis for the low risk?', send: true });
    await replyToThread(m.id, t.id, 'Only two slices are referenced by the device table.');
    const ui = mount({ reviewId: m.id });
    await wait(80);
    const rows = ui.rows();
    expect(rows[0]).toContain('rev 1/1');
    expect(rows[0]).toContain('instant mode');
    expect(rows[0]).toContain('[d] diff');
    expect(rows[1]).toContain('┬');
    const r4 = rows.find((r) => r.includes('迁移旧 store'));
    expect(r4).toMatch(/^ ?4▌│ 迁移旧 store/);
    expect(r4).toContain('t1 · L4 · answered');
    expect(rows.join('\n')).toContain('you: What is the basis for the low risk?');
    expect(rows.join('\n')).toContain('Claude: Only two slices are referenced by the device table.');
    expect(rows[rows.length - 1]).toContain('NORMAL');
    expect(rows[rows.length - 1]).toContain('L1/8');
  });

  it('narrow layout: the drawer shows the thread under the cursor', async () => {
    await mkSession();
    const m = await mkDoc();
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'Why?', send: true });
    const ui = mount({ reviewId: m.id, size: { columns: 80, rows: 30 } });
    await wait(80);
    let rows = ui.rows();
    expect(rows.join('\n')).not.toContain('┬');
    expect(rows[rows.length - 1]).toContain('NORMAL');
    await ui.press('j');
    await ui.press('j');
    await ui.press('j');
    rows = ui.rows();
    expect(rows.join('\n')).toContain('Comments (1)');
    expect(rows.join('\n')).toContain('▌t1 · L4 · open');
    expect(rows.join('\n')).toContain('sent · delivered with your next message'); // sent, not received: channel A
    await ui.press('j'); // leave the thread line
    expect(ui.screen()).toContain('no comment on the cursor line');
  });

  it('opening a review marks it in_review', async () => {
    const m = await mkDoc();
    mount({ reviewId: m.id });
    expect(await until(() => getMeta(m.id).status === 'in_review')).toBe(true);
  });

  it('orphaned threads are grouped separately', async () => {
    const m = await mkDoc();
    const t = await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 8, endLine: 8 }, 1), text: 'Schedule?', send: true });
    await withReview(m.id, (c) => {
      c.threads.find((x) => x.id === t.id).anchor.orphaned = true;
    });
    const ui = mount({ reviewId: m.id });
    await wait(80);
    const s = ui.screen();
    expect(s).toContain('anchor lost');
    expect(s).toContain('t1 · L8 · open');
    expect(s).toContain('“预计两周完成。”');
    const rows = ui.rows();
    expect(rows.find((r) => r.includes('预计两周完成。') && r.includes('│ 预计')) ?? '').not.toContain('▌'); // no marker in the gutter
  });

  it('help overlay opens with ? and closes with any key', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('?');
    expect(ui.screen()).toContain('Review Desk · help');
    expect(ui.screen()).toContain('Ctrl-d / Ctrl-u');
    await ui.press('x');
    expect(ui.screen()).not.toContain('Ctrl-d / Ctrl-u');
    expect(ui.screen()).toContain('NORMAL');
  });

  it('plan reviews say who is waiting', async () => {
    const m = await mkPlan();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    expect(ui.rows()[0]).toContain('plan · waiting for your decision');
    expect(ui.rows()[0]).toContain('instant mode'); // plans are instant now too
  });
});

describe('Review: keyboard commenting', () => {
  it('V j c, Chinese text, Enter sends a whole-line thread (instant mode)', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('jjj'); // coalesced keys are separate commands
    expect(ui.screen()).toContain('L4/8');
    await ui.press('V');
    expect(ui.screen()).toContain('VISUAL');
    await ui.press('j');
    await ui.press('c');
    expect(ui.screen()).toContain('INPUT');
    expect(ui.screen()).toContain('Comment L4-5');
    await ui.type('这个回滚方案需要列出具体步骤');
    expect(ui.screen()).toContain('这个回滚方案需要列出具体步骤');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id)[0]?.messages[0]?.state === 'sent')).toBe(true);
    const [t] = listThreads(m.id);
    expect(t.anchor).toMatchObject({ startLine: 4, endLine: 5, startCol: null, endCol: null });
    expect(t.messages[0]).toMatchObject({ text: '这个回滚方案需要列出具体步骤', state: 'sent' });
    expect(readJson(paths.outbox(m.id), [])).toHaveLength(1);
    await until(() => ui.screen().includes('sent · no matching session found'));
    const s = ui.screen();
    expect(s).toContain('sent');
    expect(s).toContain('NORMAL');
    expect(s).toContain('t1 · L4-5 · open');
  });

  it('text typed right behind c in the same chunk ends up in the box, not in the command handler', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('jjc第二步kjq'); // k j q would be commands if they were not text
    expect(ui.screen()).toContain('INPUT');
    expect(ui.screen()).toContain('第二步kjq');
    expect(ui.screen()).toContain('L3/8'); // the cursor did not move
    await ui.type('后续');
    expect(ui.screen()).toContain('第二步kjq后续');
  });

  it('the comment box opens below the selection and masks only what is under it', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('jjj');
    await ui.press('c');
    const rows = ui.rows();
    const sel = T(rows, '迁移旧 store');
    const top = T(rows, 'Comment L4') - 1;
    expect(top).toBe(sel + 1); // directly below the selected line
    expect(rows[sel]).toContain('迁移旧 store'); // the selected text itself stays visible
    expect(rows[top]).toContain('╭');
    expect(rows[T(rows, 'Comment L4') + 2]).toContain('Enter send');
  });

  it('batch mode keeps a draft; s submits; plan flows return to the inbox', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('B');
    expect(ui.screen()).toContain('batch mode');
    await ui.press('jjjc');
    await ui.type('draft text');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    await until(() => ui.screen().includes('draft saved'));
    let [t] = listThreads(m.id);
    expect(t.messages[0].state).toBe('draft');
    expect(readJson(paths.outbox(m.id), [])).toHaveLength(0);
    expect(ui.screen()).toContain('draft saved');
    expect(ui.screen()).toContain('1 draft');
    await ui.press('s');
    expect(await until(() => listThreads(m.id)[0].messages[0].state === 'sent')).toBe(true);
    expect(await until(() => getMeta(m.id).status === 'feedback_pending')).toBe(true);
    expect(getMeta(m.id).status).toBe('feedback_pending');
  });

  it('s in instant mode explains instead of sending', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('s');
    expect(ui.screen()).toContain('In instant mode Enter already sends');
  });

  it('Esc closes an empty box at once, asks before discarding text', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('c');
    expect(ui.screen()).toContain('INPUT');
    await ui.press(ESC, 150);
    expect(ui.screen()).toContain('NORMAL');
    await ui.press('c');
    await ui.type('abc');
    await ui.press(ESC, 150);
    expect(ui.screen()).toContain('Discard this comment?');
    await ui.press('n');
    expect(ui.screen()).toContain('INPUT');
    expect(ui.screen()).toContain('abc');
    await ui.press(ESC, 150);
    await ui.press('y');
    expect(ui.screen()).toContain('NORMAL');
    expect(listThreads(m.id)).toHaveLength(0);
  });

  it('Ctrl+C in the box behaves like Esc: an empty box closes, text is only discarded after confirmation', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('c');
    expect(ui.screen()).toContain('INPUT');
    await ui.press('\x03', 150);
    expect(ui.screen()).toContain('NORMAL');
    await ui.press('c');
    await ui.type('unsent comment');
    await ui.press('\x03', 150);
    expect(ui.screen()).toContain('Discard this comment?');
    await ui.press('\x03', 150); // Ctrl+C in the confirmation = "keep editing", the text survives
    expect(ui.screen()).toContain('INPUT');
    expect(ui.screen()).toContain('unsent comment');
    await ui.press('\x03', 150);
    await ui.press('y');
    expect(ui.screen()).toContain('NORMAL');
    expect(listThreads(m.id)).toHaveLength(0);
  });

  it('Ctrl+C in V mode drops the selection (like q) instead of leaving the review', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('jV');
    expect(ui.screen()).toContain('VISUAL');
    await ui.press('\x03', 100);
    expect(ui.screen()).toContain('NORMAL');
    expect(ui.screen()).toContain('rev 1/1');
  });

  it('Ctrl+C confirms nothing: it cancels the approve question', async () => {
    const m = await mkPlan();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('A');
    expect(ui.screen()).toContain('Approve this plan');
    await ui.press('\x03');
    expect(ui.screen()).not.toContain('Approve this plan');
    await wait(100);
    expect(getMeta(m.id).status).not.toBe('approved');
  });

  it('r replies on the focused thread; x resolves and reopens; D deletes a draft after confirmation', async () => {
    const m = await mkDoc();
    const t = await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'first', send: false });
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('r');
    expect(ui.screen()).toContain('The cursor is not on a thread');
    await ui.press('jjj'); // line 4
    await ui.press('r');
    expect(ui.screen()).toContain('Reply t1');
    await ui.type('and more');
    await ui.press('\r'); // instant mode sends the reply
    expect(await until(() => listThreads(m.id)[0].messages.length === 2)).toBe(true);
    let th = listThreads(m.id)[0];
    expect(th.messages.map((x) => x.text)).toEqual(['first', 'and more']);
    expect(th.messages[1].state).toBe('sent');
    await ui.press('x');
    expect(await until(() => listThreads(m.id)[0].status === 'resolved')).toBe(true);
    expect(await until(() => ui.screen().includes('resolved ✓'))).toBe(true);
    await ui.press('x');
    expect(await until(() => listThreads(m.id)[0].status === 'open')).toBe(true);
    // D: the first message is still a draft
    await ui.press('D');
    expect(ui.screen()).toContain('Delete the draft of t1?');
    await ui.press('y');
    expect(await until(() => listThreads(m.id)[0].messages.length === 1)).toBe(true);
    th = listThreads(m.id)[0];
    expect(th.messages.map((x) => x.text)).toEqual(['and more']);
    expect(t.id).toBe('t1');
  });

  it(']c and [c jump between threads', async () => {
    const m = await mkDoc();
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'a', send: false });
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 8, endLine: 8 }, 1), text: 'b', send: false });
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press(']');
    await ui.press('c');
    expect(ui.screen()).toContain('L4/8');
    await ui.press(']');
    await ui.press('c');
    expect(ui.screen()).toContain('L8/8');
    await ui.press('[');
    await ui.press('c');
    expect(ui.screen()).toContain('L4/8');
  });

  it('approve asks for confirmation; afterwards the review is read-only', async () => {
    const m = await mkPlan();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('A');
    expect(ui.screen()).toContain('Approve this plan');
    await ui.press('n');
    expect(getMeta(m.id).status).not.toBe('approved');
    await ui.press('A');
    await ui.press('y');
    expect(await until(() => getMeta(m.id).status === 'approved')).toBe(true);
    expect(await until(() => ui.rows()[0].includes('approved'))).toBe(true);
    await ui.press('c');
    expect(ui.screen()).toContain('Review is finished');
    expect(ui.screen()).not.toContain('INPUT');
  });

  it('m toggles mouse mode (indicator in the status bar)', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('m');
    expect(ui.screen()).toContain('Mouse');
  });

  it('scrolling keys move through a long document', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join('\n');
    const m = await createReview({ kind: 'doc', docPath: '/tmp/big.md', sessionId: 's1', cwd: '/x', content: big, source: 'Write', turn: 1 });
    const ui = mount({ reviewId: m.id, size: { columns: 100, rows: 24 } });
    await wait(60);
    await ui.press('\x04'); // Ctrl-d
    expect(ui.screen()).toMatch(/L1[0-9]\/300/);
    expect(ui.screen()).toContain('Line 12');
    await ui.press('G');
    expect(ui.screen()).toContain('Line 300');
    expect(ui.screen()).toContain('L300/300');
    await ui.press('g');
    expect(ui.screen()).toContain('L1/300');
    expect(ui.screen()).toContain('Line 1');
  });

  it('a new answer shows up within one poll', async () => {
    const m = await mkDoc();
    const t = await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'Why?', send: true });
    await takeUnreceived(m.id, { via: 'await' }); // Claude has the message and is answering
    const ui = mount({ reviewId: m.id });
    await wait(80);
    expect(ui.screen()).toContain('Claude is answering…');
    await replyToThread(m.id, t.id, 'Because only two slices are affected');
    expect(await until(() => ui.screen().includes('Claude: Because only two slices are affected'))).toBe(true);
    expect(ui.screen()).not.toContain('Claude is answering…');
  });
});

describe('Review: character-wise visual mode', () => {
  // line 4: 迁移旧 store 的风险较低，因为只影响两个 slice。   (风 is at offset 11)
  const toFeng = async (ui) => {
    await ui.press('jjj');
    await ui.press('l'.repeat(11));
  };

  it('v + motions + c comments on exactly the selected characters (startCol/endCol, quote)', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await toFeng(ui);
    await ui.press('v');
    expect(ui.screen()).toContain('VISUAL');
    await ui.press('lll');
    await ui.press('c');
    expect(ui.screen()).toContain('INPUT');
    expect(ui.screen()).toContain('Comment L4');
    await ui.type('the basis for this');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    const [t] = listThreads(m.id);
    expect(t.anchor).toMatchObject({ startLine: 4, endLine: 4, startCol: 11, endCol: 15, quote: '风险较低' });
    expect(t.messages[0].text).toBe('the basis for this');
  });

  it('w / b / e / 0 / $ and the column cursor: selections follow Chinese words and cross lines', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('jjj0');
    await ui.press('v');
    await ui.press('$');
    await ui.press('c');
    await ui.type('whole line');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    const [t] = listThreads(m.id);
    expect(t.anchor).toMatchObject({ startLine: 4, endLine: 4, startCol: 0, endCol: DOC.split('\n')[3].length });
    // across lines: from the middle of line 4 to the middle of line 5 with j
    await until(() => ui.screen().includes('NORMAL'));
    await ui.press('0w'); // second word of line 4
    await ui.press('v');
    await ui.press('j');
    await ui.press('c');
    await ui.type('across lines');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 2)).toBe(true);
    const t2 = listThreads(m.id)[1];
    expect(t2.anchor.startLine).toBe(4);
    expect(t2.anchor.endLine).toBe(5);
    expect(t2.anchor.startCol).toBeGreaterThan(0);
    expect(t2.anchor.quote.includes('\n')).toBe(true);
  });

  it('v inside V switches, the same key leaves, Esc cancels; q too', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('jv');
    expect(ui.screen()).toContain('VISUAL');
    await ui.press('V');
    expect(ui.screen()).toContain('VISUAL LINE');
    await ui.press('v');
    expect(ui.screen()).not.toContain('VISUAL LINE');
    expect(ui.screen()).toContain('VISUAL');
    await ui.press('v');
    expect(ui.screen()).toContain('NORMAL');
    await ui.press('v');
    await ui.press('\x1b', 150);
    expect(ui.screen()).toContain('NORMAL');
  });

  it('the footer and the help screen describe v / V', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    expect(ui.rows().at(-1)).toContain('v char');
    expect(ui.rows().at(-1)).toContain('V line');
    await ui.press('v');
    expect(ui.rows().at(-1)).toContain('hjkl');
    expect(ui.rows().at(-1)).toContain('c comment');
    await ui.press('\x1b', 150);
    await ui.press('?');
    expect(ui.screen()).toContain('character selection');
    expect(ui.screen()).toContain('w / b / e');
  });

  it('the cursor character is drawn in inverse video and follows h / l', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    const inverse = () => {
      const row = (ui.app.lastFrame() ?? '').split('\n').find((r) => r.includes('\x1b[7m') && !r.includes('1▌')) ?? '';
      // eslint-disable-next-line no-control-regex
      return [...row.matchAll(/\x1b\[7m([^\x1b]*)\x1b\[27m/g)].map((x) => x[1]).filter((x) => x.trim());
    };
    await ui.press('jjj');
    const before = inverse();
    await ui.press('ll');
    expect(inverse()).not.toEqual(before);
    expect(inverse().join('')).toContain('旧');
  });

  it('toggling the send mode moved from b to B (b is "back a word" now)', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.press('b');
    expect(ui.screen()).toContain('instant mode');
    await ui.press('B');
    expect(ui.screen()).toContain('batch mode');
  });
});

describe('Review: mouse', () => {
  // wide layout 160x40: doc pane 95 columns, gutter = 1 digit + 3 = 4, line n is on screen row 2 + n - 1
  const X0 = 4;
  const rowY = (line) => 1 + line;

  it('a click moves the cursor to the clicked character; v then selects from there', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    // 低 is at text column 21 (offset 14) on line 4
    await ui.mouse(mouse('press', X0 + 21, rowY(4)));
    await ui.mouse(mouse('release', X0 + 21, rowY(4)));
    expect(ui.screen()).toContain('L4/8');
    await ui.press('v');
    await ui.press('l');
    await ui.press('c');
    await ui.type('click');
    await ui.press('\r');
    expect(await until(() => listThreads(m.id).length === 1)).toBe(true);
    expect(listThreads(m.id)[0].anchor).toMatchObject({ startLine: 4, startCol: 14, endCol: 16, quote: '低，' });
  });

  it('dragging does not select anything and there is no [comment] button', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    await ui.mouse(mouse('press', X0 + 15, rowY(4)));
    await ui.mouse(mouse('drag', X0 + 18, rowY(4)));
    await ui.mouse(mouse('drag', X0 + 21, rowY(4)));
    await ui.mouse(mouse('release', X0 + 21, rowY(4)));
    expect(ui.screen()).not.toContain('[comment]');
    expect(ui.screen()).toContain('NORMAL');
    expect(ui.screen()).not.toContain('VISUAL');
  });

  it('clicking an overlap of two threads opens the picker; the keyboard picks', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    const comment = async (keys, text) => {
      await ui.press(keys);
      await ui.press('c');
      await ui.type(text);
      await ui.press('\r');
      await until(() => ui.screen().includes('NORMAL'));
    };
    await toLine4Col(ui, 11);
    await comment('vlll', 'first'); // 风险较低
    await toLine4Col(ui, 13);
    await comment('vllll', 'second'); // 较低，因为
    expect(await until(() => listThreads(m.id).length === 2)).toBe(true);
    const ts = listThreads(m.id);
    expect(ts[0].anchor.quote).toBe('风险较低');
    expect(ts[1].anchor.quote).toBe('较低，因为');
    await ui.mouse(mouse('press', X0 + 21, rowY(4))); // 低 belongs to both
    expect(ui.screen()).toContain('MENU');
    expect(ui.screen()).toContain('t2');
    await ui.press('j');
    await ui.press('\r');
    expect(ui.screen()).toContain('NORMAL');
    async function toLine4Col(u, n) {
      await u.mouse(mouse('press', X0, rowY(4)));
      await u.press('l'.repeat(n));
    }
  });

  it('wheel scrolls the document and a click moves the cursor', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join('\n');
    const m = await createReview({ kind: 'doc', docPath: '/tmp/big.md', sessionId: 's1', cwd: '/x', content: big, source: 'Write', turn: 1 });
    const ui = mount({ reviewId: m.id, size: { columns: 100, rows: 24 } });
    await wait(60);
    await ui.mouse(mouse('wheel', 20, 10, 'wheelDown'));
    await ui.mouse(mouse('wheel', 20, 10, 'wheelDown'));
    expect(ui.rows()[2]).toContain('7 │ Line 7');
    await ui.mouse(mouse('press', 20, 10));
    await ui.mouse(mouse('release', 20, 10));
    expect(ui.screen()).toContain('L15/300');
  });

  it('the wheel still scrolls the body while the comment box is open; typing keeps going to the box', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join('\n');
    const m = await createReview({ kind: 'doc', docPath: '/tmp/big.md', sessionId: 's1', cwd: '/x', content: big, source: 'Write', turn: 1 });
    const ui = mount({ reviewId: m.id, size: { columns: 160, rows: 30 } });
    await wait(60);
    await ui.press('c');
    await ui.type('abc');
    expect(ui.screen()).toContain('INPUT');
    for (let i = 0; i < 5; i++) await ui.mouse(mouse('wheel', 20, 10, 'wheelDown'));
    expect(ui.rows()[2]).toContain('16 │ Line 16'); // 5 x 3 rows
    expect(ui.screen()).toContain('INPUT'); // the box is still open
    expect(ui.screen()).toContain('Comment L1');
    await ui.type('def');
    expect(ui.screen()).toContain('abcdef');
    // the box is still completely on screen
    const rows = ui.rows();
    expect(rows.findIndex((r) => r.includes('╭'))).toBeGreaterThan(1);
    expect(rows.findIndex((r) => r.includes('╰'))).toBeLessThan(rows.length - 1);
    expect(rows.some((r) => r.includes('send') && r.includes('cancel'))).toBe(true);
  });

  it('a reply box under a very long thread card is fully visible, and the wheel moves the panel under it', async () => {
    const m = await mkDoc();
    const t = await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: '长问题 '.repeat(40), send: true });
    await replyToThread(m.id, t.id, '很长的回答，'.repeat(120));
    const ui = mount({ reviewId: m.id, size: { columns: 160, rows: 24 } });
    await wait(80);
    await ui.press('jjj');
    await ui.press('r');
    expect(ui.screen()).toContain('Reply t1');
    const rows = ui.rows();
    const top = rows.findIndex((r) => r.includes('Reply t1'));
    const bottom = rows.findIndex((r, i) => i > top && r.includes('╰'));
    expect(top).toBeGreaterThan(1);
    expect(bottom).toBeGreaterThan(top);
    expect(bottom).toBeLessThan(rows.length - 1);
    expect(rows[bottom - 1]).toContain('send');
    // typing works and nothing else moved
    await ui.type('follow-up text');
    expect(ui.screen()).toContain('follow-up text');
    // the wheel over the panel scrolls the cards beneath the open box
    const cardRowBefore = ui.rows().findIndex((r) => r.includes('t1 · L4'));
    await ui.mouse(mouse('wheel', 120, 6, 'wheelDown'));
    await ui.mouse(mouse('wheel', 120, 6, 'wheelDown'));
    const cardRowAfter = ui.rows().findIndex((r) => r.includes('t1 · L4'));
    expect(cardRowAfter).not.toBe(cardRowBefore);
    expect(ui.screen()).toContain('follow-up text');
    expect(ui.screen()).toContain('INPUT');
  });

  it('opening the reply box does not change what the panel shows (it floats)', async () => {
    const m = await mkDoc();
    for (const line of [4, 5, 8]) await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: line, endLine: line }, 1), text: `question ${line}`, send: false });
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await ui.press('jjj');
    const panelOf = () => ui.rows().map((r) => r.slice(r.indexOf('│', 4) + 1)).join('\n');
    const before = ui.rows().map((r) => r.slice(100));
    await ui.press('r');
    expect(ui.screen()).toContain('Reply');
    const after = ui.rows().map((r) => r.slice(100));
    // every card header that was visible is still at the same row
    for (const id of ['t1 · L4', 't2 · L5', 't3 · L8']) {
      expect(after.findIndex((r) => r.includes(id))).toBe(before.findIndex((r) => r.includes(id)));
    }
    expect(panelOf()).toBeTruthy();
  });

  it('narrow: the reply box floats at the bottom over the drawer and stays on screen', async () => {
    const m = await mkDoc();
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 4, endLine: 4 }, 1), text: 'Why?', send: false });
    const ui = mount({ reviewId: m.id, size: { columns: 80, rows: 24 } });
    await wait(80);
    await ui.press('jjj');
    await ui.press('r');
    const rows = ui.rows();
    expect(rows.some((r) => r.includes('Reply t1'))).toBe(true);
    expect(rows.at(-1)).toContain('INPUT');
    expect(rows.findIndex((r) => r.includes('╰'))).toBe(rows.length - 2);
  });

  it('clicking a status bar button runs its action', async () => {
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(60);
    const status = ui.rows()[39];
    const x = stringWidth(status.slice(0, status.indexOf('? help'))) + 1;
    await ui.mouse(mouse('press', x, 39));
    expect(ui.screen()).toContain('Ctrl-d / Ctrl-u');
  });

  it('clicking a thread card in the panel focuses it and jumps to its anchor', async () => {
    const m = await mkDoc();
    await addThread(m.id, { anchor: makeAnchor(DOC, { startLine: 8, endLine: 8 }, 1), text: 'schedule?', send: false });
    const ui = mount({ reviewId: m.id });
    await wait(60);
    const rows = ui.rows();
    const y = rows.findIndex((r) => r.includes('t1 · L8'));
    const x = rows[y].indexOf('t1 ·');
    await ui.mouse(mouse('press', x, y));
    expect(ui.screen()).toContain('L8/8');
  });
});

describe('clicks land on the row that is drawn there (full stack)', () => {
  const CJK = '一二三四五六七八九十'.repeat(5);
  const content = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? `第${i + 1}行 ${CJK}，“引号”和——破折号` : `行${i + 1}`)).join('\n');

  for (const size of [{ columns: 160, rows: 40 }, { columns: 80, rows: 30 }, { columns: 100, rows: 20 }]) {
    it(`${size.columns}x${size.rows}: clicking each drawn row (wrapped rows and scrolled views included) selects its line`, async () => {
      const m = await createReview({ kind: 'doc', docPath: '/tmp/wrap.md', sessionId: 's1', cwd: '/x', content, source: 'Write', turn: 1 });
      await addThread(m.id, { anchor: makeAnchor(content, { startLine: 5, endLine: 5 }, 1), text: 'note', send: false });
      const ui = mount({ reviewId: m.id, size });
      await wait(80);
      const numOf = (row) => /^\s*(\d+)[▌ ]│/.exec(row)?.[1];
      let checked = 0;
      for (const scroll of ['', '\x04', '\x04', 'G']) {
        if (scroll) await ui.press(scroll);
        const rows = ui.rows();
        const bodyEnd = rows.findIndex((r, i) => i > 2 && /^[─┴]+/.test(r.trim().replace(/[┴─]/g, '─')) && r.includes('─'));
        for (let y = 2; y < bodyEnd; y++) {
          // the line a row belongs to: its own number, or the number of the nearest row above that has one
          let n;
          for (let k = y; k >= 2 && !n; k--) n = numOf(rows[k]);
          if (!n || rows[y].startsWith('~')) continue;
          await ui.mouse(mouse('press', 6, y), 15);
          const status = ui.rows().at(-1);
          expect(status, `row ${y}: ${rows[y].slice(0, 40)}`).toContain(`L${n}/40`);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(30);
    });
  }
});

describe('watch mode and the plan hook', () => {
  it('auto-opens a plan when its hook starts waiting; approving answers allow and returns to the inbox', async () => {
    const { planReview } = await import('../../src/hooks/plan-review.js');
    const ui = mount({ watch: true });
    await wait(80);
    expect(ui.screen()).toContain('Waiting for Claude Code to submit a plan');
    const hook = planReview(
      { session_id: 'sess-1', cwd: '/home/dev/proj-x', tool_input: { plan: '# New plan\n\n1. Do things\n' } },
      { pollMs: 20, isClaudeAlive: () => true },
    );
    expect(await until(() => ui.screen().includes('New plan') && ui.screen().includes('rev 1/1'))).toBe(true);
    expect(ui.rows()[0]).toContain('plan · waiting for your decision');
    await wait(100);
    await ui.press('A');
    await ui.press('y');
    const result = await hook;
    expect(result.outcome).toBe('approved');
    expect(result.output.hookSpecificOutput.decision.behavior).toBe('allow');
    expect(await until(() => ui.screen().includes('inbox'))).toBe(true);
  });

  it('feedback submitted with s makes the hook deny and returns to the inbox', async () => {
    const { planReview } = await import('../../src/hooks/plan-review.js');
    const ui = mount({ watch: true });
    await wait(80);
    const hook = planReview(
      { session_id: 'sess-2', cwd: '/home/dev/proj-x', tool_input: { plan: '# Plan\n\n1. Step one\n2. Step two\n' } },
      { pollMs: 20, isClaudeAlive: () => true },
    );
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await wait(100);
    await ui.press('B'); // plans are instant by default; switch to batch to collect a draft first
    await ui.press('jjc');
    await ui.type('split step two');
    await ui.press('\r');
    expect(await until(() => ui.screen().includes('draft saved'))).toBe(true);
    await ui.press('s');
    const result = await hook;
    expect(result.outcome).toBe('feedback');
    expect(result.output.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(result.output.hookSpecificOutput.decision.message).toContain('split step two');
    expect(await until(() => ui.screen().includes('inbox'))).toBe(true);
  });

  it('an instant comment on a plan makes the hook deny at once; the review stays open', async () => {
    const { planReview } = await import('../../src/hooks/plan-review.js');
    await updateSession('sess-3', { cwd: '/home/dev/proj-x', pid: process.pid, state: 'idle', injector: { kind: 'none' } });
    const ui = mount({ watch: true });
    await wait(80);
    const hook = planReview(
      { session_id: 'sess-3', cwd: '/home/dev/proj-x', tool_input: { plan: '# Plan\n\n1. Step one\n2. Step two\n' } },
      { pollMs: 20, isClaudeAlive: () => true },
    );
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    expect(ui.rows()[0]).toContain('instant mode');
    await wait(100);
    await ui.press('jjc');
    await ui.type('split step two');
    await ui.press('\r');
    const result = await hook;
    expect(result.outcome).toBe('feedback');
    expect(result.output.hookSpecificOutput.decision.message).toContain('split step two');
    await wait(300);
    expect(ui.rows()[0]).toContain('rev 1/1'); // still in the review: the answer will show up here
    expect(await until(() => ui.screen().includes('Claude is answering…'))).toBe(true);
  });

  it('does not reopen a plan the user already looked at, but opens it again when the hook waits anew', async () => {
    const m = await mkPlan();
    const ui = mount({ watch: true });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true); // existing waiting plan opens at start-up
    ui.app.stdin.write('q'); // typed right after the screen changed: must never quit through the inbox underneath
    await wait(150);
    expect(ui.screen()).not.toBe('');
    if (!ui.screen().includes('inbox')) await ui.press('q'); // it may have landed before the review subscribed
    expect(ui.screen()).toContain('inbox');
    await wait(150);
    expect(ui.screen()).toContain('inbox'); // seen: stays in the inbox
    await withReview(m.id, (c) => {
      c.meta.status = 'awaiting_review';
      c.meta.hook = { pid: process.pid, since: new Date(Date.now() + 5).toISOString() };
    });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
  });

  it('a plan whose hook is gone is not opened automatically', async () => {
    const m = await mkPlan();
    await withReview(m.id, (c) => {
      c.meta.hook = { pid: 2 ** 22 + 12345, since: new Date().toISOString() };
    });
    const ui = mount({ watch: true });
    await wait(200);
    expect(ui.screen()).toContain('inbox');
    expect(ui.screen()).toContain('awaiting_review · hook gone'); // the plan row says nobody is waiting on it
  });
});
