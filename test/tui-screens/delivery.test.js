import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});
const mocks = vi.hoisted(() => ({ deliver: vi.fn(), injectWake: vi.fn() }));
// The real engine reads the store (kept) but never types into a terminal from a test.
vi.mock('../../src/delivery/index.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, deliver: (...a) => mocks.deliver(...a), injectWake: (...a) => mocks.injectWake(...a) };
});

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { useTempHome } from '../helpers/env.js';
import { App } from '../../src/tui/App.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { createReview, getMeta, withReview } from '../../src/store/reviews.js';
import { addThread, listThreads } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { takeUnreceived } from '../../src/store/outbox.js';
import { readProc } from '../../src/store/proc.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

useTempHome();
afterEach(() => cleanup());
beforeEach(() => {
  mocks.deliver.mockReset().mockResolvedValue({ channel: 'A', reason: 'idle-no-injector', action: 'none' });
  mocks.injectWake.mockReset().mockResolvedValue({ ok: true });
});

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

const DOC = ['# Weekly report', '', '## Risks', 'The risk of migrating the old store is low.', 'Expected to take two weeks.'].join('\n');
const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString();

const session = (extra = {}) =>
  updateSession('s1', { cwd: '/home/dev/proj-x', pid: process.pid, state: 'idle', stateSince: iso(60_000), injector: { kind: 'none' }, ...extra });
const awaiting = (extra = {}) => ({ reviewId: null, since: iso(5000), pid: process.pid, startTime: readProc(process.pid)?.startTime ?? null, ...extra });

const mkDoc = () => createReview({ kind: 'doc', docPath: '/tmp/week.md', sessionId: 's1', cwd: '/home/dev/proj-x', content: DOC, source: 'Write', turn: 1 });
const mkPlan = () => createReview({ kind: 'plan', sessionId: 's1', cwd: '/home/dev/proj-x', content: '# Plan\n\n1. Step one\n', source: 'ExitPlanMode', turn: 1 });
const send = (id, text = 'Source?', line = 4) => addThread(id, { anchor: makeAnchor(DOC, { startLine: line, endLine: line }, 1), text, send: true });

function mount({ reviewId, size = { columns: 160, rows: 40 }, watch = false, config = DEFAULT_CONFIG, wakeDeps } = {}) {
  const bus = createBus();
  const app = render(h(App, { bus, size, config, reviewId, watch, pollMs: 40, reviewPollMs: 40, wakePollMs: 40, wakeDeps }));
  return {
    app,
    rows: () => strip(app.lastFrame() ?? '').split('\n'),
    screen: () => strip(app.lastFrame() ?? ''),
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
      await wait(30);
    },
  };
}

describe('header: round, session and the channel hint', () => {
  it('shows round N next to rev n/m once feedback was sent', async () => {
    await session();
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('rev 1/1 · round 1'))).toBe(true);
    expect(ui.header()).toContain('session idle');
  });

  it('idle session, no injector: channel A, and the /review-reply hint once', async () => {
    await session();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('After you send: delivered with your next message'))).toBe(true);
    expect(await until(() => ui.screen().includes('Type /review-reply in Claude to start instant Q&A'))).toBe(true);
  });

  it('busy session: the feedback is injected when the turn ends (channel B)', async () => {
    await session({ state: 'busy' });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('After you send: injected when this turn ends'))).toBe(true);
    expect(ui.screen()).not.toContain('Type /review-reply in Claude to start instant Q&A'); // only for an idle session
  });

  it('idle session with a usable injector: channel inject', async () => {
    await session({ injector: { kind: 'tmux', target: '%9', socket: '/tmp/none' } });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('After you send: injected automatically'))).toBe(true);
  });

  it('ended session: says so (nothing queued yet: no O hint)', async () => {
    await session({ state: 'ended' });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('session ended'))).toBe(true);
  });

  it('a live rd await: instant Q&A; the E key ends instant Q&A', async () => {
    await session({ awaiting: awaiting() });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('instant Q&A'))).toBe(true);
    expect(ui.header()).not.toContain('After you send'); // the channel hint is replaced
    expect(ui.rows().at(-1)).toContain('E end Q&A'); // the status bar offers it
    await ui.press('E');
    expect(await until(() => getMeta(m.id).instant?.endedAt)).toBeTruthy();
    expect(await until(() => ui.screen().includes("Ended this session's instant Q&A (1 review); Claude's rd await exits within 1 s"))).toBe(true);
  });

  it('E ends the instant Q&A of every open review of the session, and says how many', async () => {
    await session({ awaiting: awaiting() });
    const m = await mkDoc();
    const sibling = await createReview({ kind: 'doc', docPath: '/tmp/other.md', sessionId: 's1', cwd: '/home/dev/proj-x', content: DOC, source: 'Write', turn: 1 });
    const foreign = await createReview({ kind: 'doc', docPath: '/tmp/foreign.md', sessionId: 's2', cwd: '/home/dev/proj-y', content: DOC, source: 'Write', turn: 1 });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('instant Q&A'))).toBe(true);
    await ui.press('E');
    expect(await until(() => ui.screen().includes("Ended this session's instant Q&A (2 reviews)"))).toBe(true);
    expect(getMeta(m.id).instant?.endedAt).toBeTruthy();
    expect(getMeta(sibling.id).instant?.endedAt).toBeTruthy();
    expect(getMeta(foreign.id).instant).toBeUndefined();
  });

  it('an rd await that died: Q&A interrupted', async () => {
    await session({ awaiting: awaiting({ pid: 2 ** 22 + 4321, startTime: 1 }) });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('Q&A interrupted'))).toBe(true);
  });

  it('E without a waiting rd await still records the end and says so', async () => {
    await session();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await ui.press('E');
    expect(await until(() => getMeta(m.id).instant?.endedAt)).toBeTruthy();
    expect(await until(() => ui.screen().includes('Instant Q&A ended (Claude is not waiting right now)'))).toBe(true);
    expect(await until(() => ui.header().includes('instant Q&A ended'))).toBe(true);
    await ui.press('E');
    expect(await until(() => ui.screen().includes('instant Q&A already ended'))).toBe(true);
  });
});

describe('the session\'s wake-up watcher is alive (comments are delivered automatically)', () => {
  const watcher = (extra = {}) => ({ since: iso(5000), pid: process.pid, startTime: readProc(process.pid)?.startTime ?? null, ...extra });

  it('idle or busy: the top bar says automatic delivery, nothing sends the user to the Claude terminal, nothing is typed', async () => {
    await session({ watcher: watcher(), injector: { kind: 'tmux', target: '%9', socket: '/tmp/none' } });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('After you send: delivered to Claude automatically'))).toBe(true);
    expect(ui.header()).not.toContain('/review-reply');
    expect(ui.header()).not.toContain('After you send: injected automatically');
    await wait(250); // the one-time /review-reply hint would be up by now
    expect(ui.screen()).not.toContain('/review-reply');
    expect(ui.screen()).not.toContain('Type /review-reply in Claude');
    await session({ state: 'busy', watcher: watcher(), injector: { kind: 'none' } });
    expect(await until(() => ui.header().includes('session busy'))).toBe(true);
    expect(ui.header()).toContain('After you send: delivered to Claude automatically');
    expect(ui.header()).not.toContain('injected when this turn ends');
    expect(mocks.injectWake).not.toHaveBeenCalled();
  });

  it('without a live watcher (record of a dead process) it is the old channel text', async () => {
    await session({ watcher: watcher({ pid: 2 ** 22 + 4321, startTime: 1 }) });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('After you send: delivered with your next message'))).toBe(true);
    expect(ui.header()).not.toContain('delivered to Claude automatically');
  });

  it('a live rd await still shows instant Q&A (and E); the watcher does not hide it', async () => {
    await session({ watcher: watcher(), awaiting: awaiting() });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('instant Q&A'))).toBe(true);
    expect(ui.rows().at(-1)).toContain('E end Q&A');
  });

  it('E offers nothing without an rd await, but still works and says comments keep arriving automatically', async () => {
    await session({ watcher: watcher() });
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('delivered to Claude automatically'))).toBe(true);
    expect(ui.rows().at(-1)).not.toContain('E end Q&A');
    await ui.press('E');
    expect(await until(() => ui.screen().includes('automatic delivery is unaffected, new comments are delivered as usual'))).toBe(true);
  });

  it('sending: the card and the notice say it is delivered automatically; batch mode submits the same way', async () => {
    await session({ watcher: watcher() });
    const m = await mkDoc();
    await send(m.id);
    mocks.deliver.mockResolvedValue({ channel: 'watch', reason: 'watcher-alive', action: 'none' });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('sent · delivered automatically, Claude will receive it'))).toBe(true); // the card wraps the rest
    await wait(80);
    await ui.press('B');
    await ui.press('jjjc');
    await ui.type('draft');
    await ui.press('\r');
    await ui.press('s');
    expect(await until(() => ui.screen().includes('sent · delivered to Claude automatically'))).toBe(true);
  });

  it('a plan: no "Claude is not waiting for this plan"; approving says Claude is woken up', async () => {
    await session({ watcher: watcher() });
    const p = await mkPlan();
    const ui = mount({ reviewId: p.id });
    expect(await until(() => ui.header().includes('After you send: delivered to Claude automatically'))).toBe(true);
    expect(ui.header()).not.toContain('not waiting');
    await ui.press('A');
    expect(await until(() => ui.screen().includes('Approve this plan (Claude will be woken up automatically to submit the plan)?'))).toBe(true);
    await ui.press('y');
    expect(await until(() => getMeta(p.id).status === 'approved')).toBe(true);
    expect(getMeta(p.id).approvedPendingExit).toBe(true);
    expect(await until(() => ui.screen().includes('Approved; Claude will be woken up automatically to submit the plan'))).toBe(true);
  });

  it('received but unanswered for 60 s: the warning stays, but nothing is typed into the terminal', async () => {
    await session({ watcher: watcher(), injector: { kind: 'tmux', target: '%9', socket: '/tmp/none' } });
    const m = await mkDoc();
    await send(m.id);
    await takeUnreceived(m.id, { via: 'watch' });
    await withReview(m.id, (c) => {
      for (const e of c.outbox) e.receivedAt = iso(120_000);
    });
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('Claude not woken'))).toBe(true);
    await wait(300);
    expect(mocks.injectWake).not.toHaveBeenCalled();
  });
});

describe('thread cards: waiting lines', () => {
  it('sent but not received: by channel; received: Claude is answering…', async () => {
    await session({ awaiting: awaiting() });
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('sent · Claude will receive it shortly'))).toBe(true);
    await takeUnreceived(m.id, { via: 'await' });
    expect(await until(() => ui.screen().includes('Claude is answering…'))).toBe(true);
    expect(ui.screen()).not.toContain('Claude will receive it shortly');
  });

  it('a message sent while Claude answers another one waits (queued) next to the one being answered', async () => {
    await session({ awaiting: awaiting() });
    const m = await mkDoc();
    await send(m.id, 'First question', 4);
    await takeUnreceived(m.id, { via: 'await' });
    await send(m.id, 'Second question', 5);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('Claude is answering…') && ui.screen().includes('sent · Claude will receive it shortly'))).toBe(true);
  });

  it('channel B and A texts', async () => {
    await session({ state: 'busy' });
    const m = await mkDoc();
    await send(m.id);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.screen().includes('sent · Claude picks it up when this turn ends'))).toBe(true);
  });
});

describe('after sending: deliver() and the message', () => {
  const typeComment = async (ui, text = 'Please add detail') => {
    await ui.press('jjjc');
    await ui.type(text);
    await ui.press('\r');
  };

  it('every instant send fires deliver(id) and shows the channel', async () => {
    await session();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await typeComment(ui);
    expect(await until(() => mocks.deliver.mock.calls.length === 1)).toBe(true);
    expect(mocks.deliver.mock.calls[0][0]).toBe(m.id);
    expect(await until(() => ui.screen().includes('sent · delivered with your next message'))).toBe(true);
  });

  it('shows what the engine did: injected / failed / hook / await', async () => {
    await session();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    mocks.deliver.mockResolvedValueOnce({ channel: 'inject', reason: 'idle-injector', action: 'injected' });
    await typeComment(ui, 'one');
    expect(await until(() => ui.screen().includes('sent · /review-reply injected automatically'))).toBe(true);

    mocks.deliver.mockResolvedValueOnce({ channel: 'A', reason: 'inject-failed', action: 'failed', error: 'tmux: no server' });
    await ui.press('c');
    await ui.type('two');
    await ui.press('\r');
    expect(await until(() => ui.screen().includes('auto-injection failed (tmux: no server)'))).toBe(true);

    mocks.deliver.mockResolvedValueOnce({ channel: 'await', reason: 'awaiting-alive', action: 'none' });
    await ui.press('c');
    await ui.type('three');
    await ui.press('\r');
    expect(await until(() => ui.screen().includes('instant Q&A, Claude will receive it shortly'))).toBe(true);
  });

  it('batch s delivers once for all drafts; saving a draft does not deliver', async () => {
    await session();
    const m = await mkDoc();
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await ui.press('B');
    await typeComment(ui, 'draft one');
    expect(await until(() => ui.screen().includes('draft saved'))).toBe(true);
    expect(mocks.deliver).not.toHaveBeenCalled();
    await ui.press('s');
    expect(await until(() => mocks.deliver.mock.calls.length === 1)).toBe(true);
    expect(await until(() => ui.screen().includes('sent · delivered with your next message'))).toBe(true);
  });

  it('a delivery check that throws becomes a warning, not a crash', async () => {
    await session();
    const m = await mkDoc();
    mocks.deliver.mockRejectedValueOnce(new Error('boom'));
    const ui = mount({ reviewId: m.id });
    await wait(80);
    await typeComment(ui);
    expect(await until(() => ui.screen().includes('delivery check failed: boom'))).toBe(true);
    expect(listThreads(m.id)).toHaveLength(1);
  });
});

describe('Claude did not wake up', () => {
  const stale = async (m) => {
    await send(m.id);
    await takeUnreceived(m.id, { via: 'await' });
    await withReview(m.id, (c) => {
      for (const e of c.outbox) e.receivedAt = iso(120_000);
    });
  };

  it('header hint after 60 s unanswered while idle; one automatic wake-up per batch when an injector is usable', async () => {
    await session({ injector: { kind: 'tmux', target: '%9', socket: '/tmp/none' } });
    const m = await mkDoc();
    await stale(m);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('Claude not woken: press Enter in Claude'))).toBe(true);
    expect(await until(() => mocks.injectWake.mock.calls.length === 1)).toBe(true);
    expect(mocks.injectWake).toHaveBeenCalledWith('s1', { reviewId: m.id });
    await wait(250); // several polls later it still fired exactly once
    expect(mocks.injectWake).toHaveBeenCalledTimes(1);
    expect(await until(() => ui.screen().includes('Claude woken up automatically'))).toBe(true);
  });

  it('also from the inbox: no review is open, the wake-up is typed once and the inbox footer says so', async () => {
    await session({ injector: { kind: 'tmux', target: '%9', socket: '/tmp/none' } });
    const m = await mkDoc();
    await stale(m);
    const ui = mount();
    expect(await until(() => mocks.injectWake.mock.calls.length === 1)).toBe(true);
    expect(mocks.injectWake).toHaveBeenCalledWith('s1', { reviewId: m.id });
    expect(await until(() => ui.rows().at(-1).includes('Claude woken up automatically (/review-reply)'))).toBe(true);
    await wait(200);
    expect(mocks.injectWake).toHaveBeenCalledTimes(1);
  });

  it('a transient refusal (session just went idle) is retried; the notice appears after the successful retry only', async () => {
    mocks.injectWake.mockReset().mockResolvedValueOnce({ ok: false, reason: 'idle-too-short' }).mockResolvedValue({ ok: true });
    await session({ injector: { kind: 'tmux', target: '%9', socket: '/tmp/none' } });
    const m = await mkDoc();
    await stale(m);
    const ui = mount({ reviewId: m.id, wakeDeps: { retryMs: 150 } });
    expect(await until(() => mocks.injectWake.mock.calls.length === 1)).toBe(true);
    expect(ui.screen()).not.toContain('Claude woken up automatically');
    expect(await until(() => mocks.injectWake.mock.calls.length === 2)).toBe(true);
    expect(await until(() => ui.screen().includes('Claude woken up automatically (/review-reply)'))).toBe(true);
    await wait(250);
    expect(mocks.injectWake).toHaveBeenCalledTimes(2);
  });

  it('a permanent refusal is not retried', async () => {
    mocks.injectWake.mockReset().mockResolvedValue({ ok: false, reason: 'target-owned-by-another-session' });
    await session({ injector: { kind: 'tmux', target: '%9', socket: '/tmp/none' } });
    const m = await mkDoc();
    await stale(m);
    const ui = mount({ reviewId: m.id, wakeDeps: { retryMs: 30 } });
    expect(await until(() => mocks.injectWake.mock.calls.length === 1)).toBe(true);
    await wait(300);
    expect(mocks.injectWake).toHaveBeenCalledTimes(1);
    expect(ui.screen()).not.toContain('Claude woken up automatically');
    expect(ui.header()).toContain('Claude not woken'); // the header hint stays
  });

  it('without an injector only the hint is shown', async () => {
    await session();
    const m = await mkDoc();
    await stale(m);
    const ui = mount({ reviewId: m.id });
    expect(await until(() => ui.header().includes('Claude not woken'))).toBe(true);
    await wait(150);
    expect(mocks.injectWake).not.toHaveBeenCalled();
  });

  it('no hint while an rd await is alive, or when the batch is fresh', async () => {
    await session({ awaiting: awaiting() });
    const m = await mkDoc();
    await stale(m);
    const ui = mount({ reviewId: m.id });
    await wait(200);
    expect(ui.header()).not.toContain('Claude not woken');
    const m2 = await mkDoc();
    await send(m2.id);
    await takeUnreceived(m2.id, { via: 'await' });
    await updateSession('s1', { awaiting: undefined });
    const ui2 = mount({ reviewId: m2.id });
    await wait(200);
    expect(ui2.header()).not.toContain('Claude not woken');
  });
});

describe('plan reviews in M2', () => {
  it('approving while no hook waits stores the approval and says Claude will let it through later', async () => {
    await session();
    const p = await mkPlan();
    const ui = mount({ reviewId: p.id });
    await wait(80);
    await ui.press('A');
    expect(ui.screen()).toContain('it lets the plan through the next time it submits it or enters Q&A');
    await ui.press('y');
    expect(await until(() => getMeta(p.id).approvedPendingExit === true)).toBe(true);
    expect(await until(() => ui.screen().includes('Approved; Claude is not waiting right now - it will let the plan through the next time it submits it or enters Q&A'))).toBe(true);
    expect(await until(() => ui.header().includes('approved · passes once Claude submits the plan'))).toBe(true);
  });

  it('the same approval from the watch inbox returns to the inbox and keeps the message there', async () => {
    await session();
    const p = await mkPlan();
    await withReview(p.id, (c) => {
      c.meta.hook = { pid: process.pid, since: iso() }; // a waiting hook makes watch open it...
    });
    const ui = mount({ watch: true });
    expect(await until(() => ui.screen().includes('rev 1/1'))).toBe(true);
    await withReview(p.id, (c) => {
      delete c.meta.hook; // ...and it is gone when the user decides (Claude ended its turn behind rd await)
    });
    await wait(150);
    await ui.press('A');
    await ui.press('y');
    expect(await until(() => ui.screen().includes('inbox') && ui.screen().includes('it will let the plan through the next time it submits it or enters Q&A'))).toBe(true);
  });

  it('with a blocking hook the approval needs no explanation', async () => {
    await session();
    const p = await mkPlan();
    await withReview(p.id, (c) => {
      c.meta.hook = { pid: process.pid, since: iso() };
    });
    const ui = mount({ reviewId: p.id });
    await wait(80);
    await ui.press('A');
    await ui.press('y');
    expect(await until(() => getMeta(p.id).status === 'approved')).toBe(true);
    expect(getMeta(p.id).approvedPendingExit).toBeUndefined();
    expect(await until(() => ui.screen().includes('approved'))).toBe(true);
    expect(ui.screen()).not.toContain('not waiting');
  });

  it('delivered / answered plans show Claude working or done, not "waiting for a resubmission"', async () => {
    await session();
    const p = await mkPlan();
    await withReview(p.id, (c) => {
      c.meta.status = 'delivered';
    });
    const ui = mount({ reviewId: p.id });
    expect(await until(() => ui.header().includes('Claude has it · answering'))).toBe(true);
    expect(ui.header()).not.toContain('resubmi');
    await withReview(p.id, (c) => {
      c.meta.status = 'answered';
    });
    expect(await until(() => ui.header().includes('Claude answered'))).toBe(true);
  });
});

describe('watch mode and docs', () => {
  it('a newly registered doc review sorts above older ones in the inbox', async () => {
    await session();
    const old = await mkDoc();
    await withReview(old.id, (c) => {
      c.meta.title = 'old-doc';
      c.meta.updatedAt = iso(3600_000);
    });
    const fresh = await mkDoc();
    await withReview(fresh.id, (c) => {
      c.meta.title = 'fresh-doc';
    });
    const ui = mount();
    await wait(100);
    const rows = ui.rows();
    expect(rows.findIndex((r) => r.includes('fresh-doc'))).toBeLessThan(rows.findIndex((r) => r.includes('old-doc')));
  });

  it('config.docs.autoOpen: watch opens a newly registered doc like a plan', async () => {
    await session();
    const ui = mount({ watch: true, config: { ...DEFAULT_CONFIG, docs: { ...DEFAULT_CONFIG.docs, autoOpen: true } } });
    await wait(100);
    expect(ui.screen()).toContain('inbox');
    const m = await mkDoc();
    expect(await until(() => ui.screen().includes('rev 1/1') && ui.screen().includes('migrating the old store'))).toBe(true);
    expect(m.id).toBeTruthy();
  });

  it('without autoOpen a new doc only shows up in the inbox', async () => {
    await session();
    const ui = mount({ watch: true });
    await wait(100);
    await mkDoc();
    await wait(300);
    expect(ui.screen()).toContain('inbox');
    expect(ui.screen()).not.toContain('rev 1/1');
  });
});
