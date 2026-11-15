import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { planDelivery, deliver, injectWake, deliveryState, WAKE_AFTER_MS } from '../src/delivery/index.js';
import { createReview, withReview } from '../src/store/reviews.js';
import { addThread, addUserMessage, replyToThread } from '../src/store/threads.js';
import { updateSession } from '../src/store/sessions.js';
import { approveReview } from '../src/store/lifecycle.js';
import { takeUnreceived } from '../src/store/outbox.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';

useTempHome();
const SID = 'deliv-session';
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const content = ['# Report', '', 'Risk is low.', 'Takes two weeks.'].join('\n');
const anchor = (line) => makeAnchor(content, { startLine: line, endLine: line }, 1);
const DEAD_PID = 2 ** 22 + 4242;
const config = (over = {}) => ({ ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, ...over } });

async function session(over = {}) {
  return updateSession(SID, { cwd: '/w', pid: process.pid, state: 'idle', stateSince: ago(30), injector: { kind: 'none' }, ...over });
}
const doc = (over = {}) => createReview({ kind: 'doc', docPath: '/w/docs/a.md', sessionId: SID, cwd: '/w', content, source: 'Write', ...over });
const plan = () => createReview({ kind: 'plan', sessionId: SID, cwd: '/w', content, source: 'ExitPlanMode' });
const mockAdapter = (over = {}) => ({ isAlive: vi.fn(async () => true), inject: vi.fn(async () => {}), ...over });
const TMUX = { kind: 'tmux', target: '%7' };

describe('planDelivery', () => {
  const plan1 = (id, over = {}) => planDelivery(id, { config: DEFAULT_CONFIG, now: NOW, ...over });

  it('idle without injector -> A; busy -> B; ended / unknown / dead process -> C; finished -> none', async () => {
    const { id } = await doc();
    expect(plan1(id)).toMatchObject({ channel: 'C', reason: 'no-session', sessionState: 'unknown' });
    await session();
    expect(plan1(id)).toMatchObject({ channel: 'A', reason: 'idle-no-injector', sessionState: 'idle', injector: { kind: 'none', usable: false } });
    await session({ state: 'busy' });
    expect(plan1(id)).toMatchObject({ channel: 'B', reason: 'busy', sessionState: 'busy' });
    await session({ state: 'ended' });
    expect(plan1(id)).toMatchObject({ channel: 'C', reason: 'session-ended', sessionState: 'ended' });
    await session({ state: 'idle', pid: DEAD_PID });
    expect(plan1(id)).toMatchObject({ channel: 'C', reason: 'process-gone' });
    await session({ pid: process.pid });
    await approveReview(id);
    expect(plan1(id).channel).toBe('none');
  });

  it('idle with a usable injector -> inject; autoInject off -> A', async () => {
    const { id } = await doc();
    await session({ injector: TMUX });
    expect(plan1(id)).toMatchObject({ channel: 'inject', reason: 'idle-injector', idleForMs: 30_000, injector: { kind: 'tmux', target: '%7', usable: true } });
    const off = plan1(id, { config: config({ autoInject: false }) });
    expect(off).toMatchObject({ channel: 'A', reason: 'idle-autoinject-off', injector: { usable: false } });
    await session({ injector: { kind: 'bogus', target: 'x' } });
    expect(plan1(id).channel).toBe('A'); // unknown adapter kinds are ignored
  });

  it('a live rd await wins (even busy); only for its review when it waits for one; a stale record does not count', async () => {
    const a = await doc();
    const b = await doc({ docPath: '/w/docs/b.md' });
    await session({ state: 'busy', awaiting: { reviewId: null, since: ago(5), pid: process.pid } });
    expect(plan1(a.id)).toMatchObject({ channel: 'await', reason: 'awaiting-alive' });
    await session({ state: 'busy', awaiting: { reviewId: a.id, since: ago(5), pid: process.pid } });
    expect(plan1(a.id).channel).toBe('await');
    expect(plan1(b.id).channel).toBe('B'); // that await does not wait for b
    await session({ state: 'busy', awaiting: { reviewId: null, since: ago(5), pid: DEAD_PID } });
    expect(plan1(a.id).channel).toBe('B');
  });

  it('a plan with a waiting hook is delivered by the hook', async () => {
    const p = await plan();
    await session({ awaiting: { reviewId: null, since: ago(5), pid: process.pid } });
    await withReview(p.id, (ctx) => {
      ctx.meta.hook = { pid: process.pid, since: ago(1) };
    });
    expect(plan1(p.id)).toMatchObject({ channel: 'hook', reason: 'plan-hook-waiting' });
    await withReview(p.id, (ctx) => {
      ctx.meta.hook = { pid: DEAD_PID, since: ago(1) };
    });
    expect(plan1(p.id).channel).toBe('await');
  });

  it('validates the review id', () => {
    expect(() => planDelivery('../etc')).toThrow(/invalid review id/);
  });
});

describe('deliver (auto-injection)', () => {
  async function setup(sessionOver = {}) {
    await session({ injector: TMUX, ...sessionOver });
    const r = await doc();
    await addThread(r.id, { anchor: anchor(3), text: 'q', send: true });
    return r.id;
  }
  const base = (adapter, over = {}) => ({ config: DEFAULT_CONFIG, adapter, now: () => NOW, sleep: async () => {}, ...over });

  it('types the fixed /review-reply <id> into an idle session and records injectedAt', async () => {
    const id = await setup();
    const adapter = mockAdapter();
    const r = await deliver(id, {}, base(adapter));
    expect(r).toMatchObject({ channel: 'inject', action: 'injected' });
    expect(adapter.inject).toHaveBeenCalledTimes(1);
    expect(adapter.inject.mock.calls[0][0]).toEqual(TMUX);
    expect(adapter.inject.mock.calls[0][1]).toBe(`/review-reply ${id}`);
    const entry = readJson(paths.outbox(id))[0];
    expect(entry.injectedAt).toBeTruthy();
    expect(entry.receivedAt).toBeUndefined(); // received only when the prompt-submit hook sees the command

    // typing it twice for the same waiting feedback would be noise
    const again = await deliver(id, {}, base(adapter));
    expect(again).toMatchObject({ action: 'skipped', reason: 'already-injected' });
    expect(adapter.inject).toHaveBeenCalledTimes(1);
  });

  it('a burst of deliver() calls (several messages sent quickly) types the command once', async () => {
    const id = await setup();
    const adapter = mockAdapter({ inject: vi.fn(async () => new Promise((r) => setTimeout(r, 40))) });
    const results = await Promise.all([deliver(id, {}, base(adapter)), deliver(id, {}, base(adapter)), deliver(id, {}, base(adapter))]);
    expect(adapter.inject).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.action).sort()).toEqual(['injected', 'skipped', 'skipped']);
  });

  it('waits for the idle period, then injects; gives up to channel A when the session never settles', async () => {
    const id = await setup({ stateSince: new Date(NOW - 500).toISOString() }); // idle for 0.5 s only
    const adapter = mockAdapter();
    let t = NOW;
    const deps = base(adapter, { now: () => t, sleep: async (ms) => { t += ms; } });
    const r = await deliver(id, {}, deps);
    expect(r.action).toBe('injected');
    expect(t - NOW).toBeGreaterThanOrEqual(1500); // waited ~1.5 s until idle reached 2 s

    const id2 = await (async () => {
      await updateSession(SID, { state: 'busy', stateSince: new Date(NOW).toISOString() });
      const r2 = await doc({ docPath: '/w/docs/c.md' });
      await addThread(r2.id, { anchor: anchor(3), text: 'q', send: true });
      return r2.id;
    })();
    // busy session: plain deliver leaves it to the Stop hook; with whenIdle it waits and then reports A/B when time runs out
    expect(await deliver(id2, {}, base(adapter))).toMatchObject({ channel: 'B', action: 'none' });
    t = NOW;
    const waited = await deliver(id2, { whenIdle: true }, base(adapter, { now: () => t, sleep: async (ms) => { t += ms; } }));
    expect(waited).toMatchObject({ channel: 'B', action: 'none', reason: 'inject-not-idle' });
    expect(t - NOW).toBeGreaterThanOrEqual(30_000);
  });

  it('whenIdle injects as soon as the busy session turns idle', async () => {
    const id = await setup({ state: 'busy', stateSince: ago(1) });
    const adapter = mockAdapter();
    let t = NOW;
    let calls = 0;
    const deps = base(adapter, {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (++calls === 2) await updateSession(SID, { state: 'idle', stateSince: new Date(t - 3000).toISOString() });
      },
    });
    const r = await deliver(id, { whenIdle: true }, deps);
    expect(r).toMatchObject({ channel: 'inject', action: 'injected' });
  });

  it('does not inject when autoInject is off, the target is gone, or the adapter does not recognise the terminal', async () => {
    const id = await setup();
    const adapter = mockAdapter();
    expect(await deliver(id, {}, base(adapter, { config: config({ autoInject: false }) }))).toMatchObject({ channel: 'A', reason: 'idle-autoinject-off', action: 'none' });

    const gone = mockAdapter({ isAlive: async () => false });
    expect(await deliver(id, {}, base(gone))).toMatchObject({ channel: 'A', reason: 'inject-target-gone', action: 'none' });

    const foreign = mockAdapter({ verify: async () => ({ ok: false, reason: 'pane-process-mismatch' }) });
    expect(await deliver(id, {}, base(foreign))).toMatchObject({ channel: 'A', reason: 'inject-pane-process-mismatch', action: 'none' });
    for (const a of [adapter, gone, foreign]) expect(a.inject).not.toHaveBeenCalled();
  });

  it('refuses when a later claude registered the same pane (the pane no longer belongs to this session)', async () => {
    const id = await setup();
    await updateSession('newer-session', { cwd: '/w', pid: process.pid, state: 'idle', stateSince: ago(30), injector: TMUX, startedAt: new Date(Date.now() + 60_000).toISOString() });
    const adapter = mockAdapter();
    const r = await deliver(id, {}, base(adapter));
    expect(r).toMatchObject({ channel: 'A', reason: 'inject-target-owned-by-another-session', action: 'none' });
    expect(adapter.inject).not.toHaveBeenCalled();
    // ... but an ENDED newer session does not count (e.g. /clear in the same pane ended the other one)
    await updateSession('newer-session', { state: 'ended' });
    expect((await deliver(id, {}, base(adapter))).action).toBe('injected');
  });

  it('is a no-op for the other channels and when nothing is waiting; reports adapter failures', async () => {
    const id = await setup({ injector: { kind: 'none' } });
    const adapter = mockAdapter();
    expect(await deliver(id, {}, base(adapter))).toMatchObject({ channel: 'A', action: 'none' });
    await updateSession(SID, { injector: TMUX });
    await takeUnreceived(id, { via: 'A' });
    expect(await deliver(id, {}, base(adapter))).toMatchObject({ action: 'none', reason: 'nothing-waiting' });

    await addUserMessage(id, 't1', { text: 'again', send: true });
    const broken = mockAdapter({ inject: async () => { throw new Error('tmux exploded'); } });
    expect(await deliver(id, {}, base(broken))).toMatchObject({ channel: 'A', action: 'failed', error: 'tmux exploded', reason: 'inject-failed' });
    expect(readJson(paths.outbox(id)).find((e) => !e.receivedAt).injectedAt).toBeUndefined();
  });

  it('with an awaiting rd the feedback is not injected', async () => {
    const id = await setup({ awaiting: { reviewId: null, since: ago(3), pid: process.pid } });
    const adapter = mockAdapter();
    expect(await deliver(id, {}, base(adapter))).toMatchObject({ channel: 'await', action: 'none' });
    expect(adapter.inject).not.toHaveBeenCalled();
  });
});

describe('injectWake', () => {
  const deps = (adapter, over = {}) => ({ config: DEFAULT_CONFIG, adapter, now: () => NOW, ...over });
  it('types the fixed command for an idle session; with a review id it names it', async () => {
    await session({ injector: TMUX });
    const adapter = mockAdapter();
    expect(await injectWake(SID, { reviewId: 'doc-20261109-142301-a3f9' }, deps(adapter))).toEqual({ ok: true });
    expect(adapter.inject.mock.calls[0][1]).toBe('/review-reply doc-20261109-142301-a3f9');
    expect(await injectWake(SID, {}, deps(adapter))).toEqual({ ok: true });
    expect(adapter.inject.mock.calls[1][1]).toBe('/review-reply');
  });
  it('refuses bad ids, busy sessions, missing injectors and disabled autoInject', async () => {
    const adapter = mockAdapter();
    expect(await injectWake(SID, {}, deps(adapter))).toMatchObject({ ok: false }); // unknown session
    await session({ injector: TMUX });
    expect(await injectWake(SID, { reviewId: 'doc-1; rm -rf /' }, deps(adapter))).toEqual({ ok: false, reason: 'invalid-review-id' });
    await session({ state: 'busy' });
    expect(await injectWake(SID, {}, deps(adapter))).toEqual({ ok: false, reason: 'not-idle' });
    await session({ state: 'idle', stateSince: new Date(NOW - 1000).toISOString() });
    expect(await injectWake(SID, {}, deps(adapter))).toEqual({ ok: false, reason: 'idle-too-short' });
    await session({ stateSince: ago(30), injector: { kind: 'none' } });
    expect(await injectWake(SID, {}, deps(adapter))).toEqual({ ok: false, reason: 'no-injector' });
    await session({ injector: TMUX });
    expect(await injectWake(SID, {}, deps(adapter, { config: config({ autoInject: false }) }))).toEqual({ ok: false, reason: 'autoInject-off' });
    expect(adapter.inject).not.toHaveBeenCalled();
    const failing = mockAdapter({ inject: async () => { throw new Error('boom'); } });
    expect(await injectWake(SID, {}, deps(failing))).toMatchObject({ ok: false, reason: 'inject-failed', error: 'boom' });
  });
});

describe('deliveryState', () => {
  it('describes queued / received / answering threads, the awaiting record and the wake-up need', async () => {
    await session({ stateSince: ago(120) });
    const { id } = await doc();
    await addThread(id, { anchor: anchor(3), text: 'q1', send: true });
    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    let s = deliveryState(id, { now: NOW });
    expect(s).toMatchObject({ queued: expect.any(Array), received: [], answering: [], wakeNeeded: false, instantEnded: false, interrupted: false, awaiting: null });
    expect(s.queued).toHaveLength(2);
    expect(s.session).toMatchObject({ state: 'idle', alive: true, idleForMs: 120_000 });

    await takeUnreceived(id, { via: 'await', now: new Date(NOW - WAKE_AFTER_MS - 1000).toISOString() });
    s = deliveryState(id, { now: NOW });
    expect(s.queued).toHaveLength(0);
    expect(s.answering).toEqual(['t1', 't2']);
    expect(s.oldestReceivedAt).toBeTruthy();
    expect(s.wakeNeeded).toBe(true); // received a minute ago, nobody answered, session idle, no await

    await replyToThread(id, 't1', 'a1');
    expect(deliveryState(id, { now: NOW }).answering).toEqual(['t2']);
    await updateSession(SID, { state: 'busy', stateSince: ago(5) });
    expect(deliveryState(id, { now: NOW }).wakeNeeded).toBe(false); // Claude is working on it

    // await record: alive vs. interrupted
    await updateSession(SID, { state: 'idle', stateSince: ago(100), awaiting: { reviewId: id, since: ago(50), pid: process.pid } });
    s = deliveryState(id, { now: NOW });
    expect(s.awaiting).toMatchObject({ alive: true, reviewId: id });
    expect(s.interrupted).toBe(false);
    expect(s.wakeNeeded).toBe(false);
    await updateSession(SID, { awaiting: { reviewId: id, since: ago(50), pid: DEAD_PID } });
    s = deliveryState(id, { now: NOW });
    expect(s).toMatchObject({ interrupted: true, awaiting: { alive: false } });
    expect(s.wakeNeeded).toBe(true);
  });
});
