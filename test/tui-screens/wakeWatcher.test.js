import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../helpers/env.js';
import { createWakeWatcher, isTransientWakeReason, WAKE_RETRY_MS, WAKE_MAX_RETRIES, WAKE_POLL_MS } from '../../src/tui/lib/wakeWatcher.js';

useTempHome();

/**
 * A fake world: reviews = { id: {sessionId, status, wake, oldest} }, an injectable clock and an injectWake whose
 * answers are scripted per call.
 */
function world(reviews, script = []) {
  let t = 1_000_000;
  const calls = [];
  const queue = [...script];
  const w = createWakeWatcher({
    listReviews: () => Object.entries(reviews).map(([id, r]) => ({ id, sessionId: r.sessionId, status: r.status ?? 'delivered' })),
    deliveryState: (id) => {
      const r = reviews[id];
      if (r.throws) throw new Error('half-written');
      return { status: r.status ?? 'delivered', wakeNeeded: r.wake !== false, oldestReceivedAt: r.oldest ?? '2026-11-12T10:00:00.000Z' };
    },
    planDelivery: (id) => ({ channel: reviews[id].channel ?? 'A', injector: { usable: reviews[id].usable !== false } }),
    injectWake: async (sessionId, opts) => {
      calls.push([sessionId, opts.reviewId]);
      const next = queue.length ? queue.shift() : { ok: true };
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => t,
  });
  return { w, calls, advance: (ms) => (t += ms), reviews };
}

describe('reason classification', () => {
  it('transient: the session is busy / went idle a moment ago / the adapter hiccuped', () => {
    for (const r of ['not-idle', 'idle-too-short', 'inject-failed']) expect(isTransientWakeReason(r)).toBe(true);
  });
  it('permanent: no injector, autoInject off, wrong session, vanished terminal, anything unknown', () => {
    for (const r of ['no-injector', 'autoInject-off', 'target-owned-by-another-session', 'target-gone', 'pane-gone', 'pane-process-mismatch', 'no-session-pid', 'verify-failed', 'process-gone', 'invalid-review-id', 'whatever', undefined]) {
      expect(isTransientWakeReason(r)).toBe(false);
    }
  });
  it('constants: 2.5 s checks, 15 s retry delay, 3 retries', () => {
    expect([WAKE_POLL_MS, WAKE_RETRY_MS, WAKE_MAX_RETRIES]).toEqual([2500, 15_000, 3]);
  });
});

describe('createWakeWatcher', () => {
  it('wakes the session once per (sessionId, oldestReceivedAt) and reports the success', async () => {
    const x = world({ 'doc-a': { sessionId: 's1' } });
    expect(await x.w.tick()).toEqual([{ sessionId: 's1', reviewId: 'doc-a' }]);
    expect(x.calls).toEqual([['s1', 'doc-a']]);
    expect(await x.w.tick()).toEqual([]); // same batch: never again, however many ticks and however long it takes
    x.advance(10 * 60_000);
    expect(await x.w.tick()).toEqual([]);
    expect(x.calls).toHaveLength(1);

    // a different batch (the oldest received entry changed) is a new wake-up, even after a pause in between
    x.reviews['doc-a'].wake = false;
    await x.w.tick();
    x.reviews['doc-a'].wake = true;
    x.reviews['doc-a'].oldest = '2026-11-12T11:00:00.000Z';
    expect(await x.w.tick()).toEqual([{ sessionId: 's1', reviewId: 'doc-a' }]);
    expect(x.calls).toHaveLength(2);
  });

  it('does not forget a success when wakeNeeded flickers off and on for the same batch', async () => {
    const x = world({ 'doc-a': { sessionId: 's1' } });
    await x.w.tick();
    x.reviews['doc-a'].wake = false; // Claude got busy
    await x.w.tick();
    x.reviews['doc-a'].wake = true; // idle again without having answered
    await x.w.tick();
    expect(x.calls).toHaveLength(1);
  });

  it('ignores finished reviews, reviews without a session, reviews that need no wake-up and unreadable ones', async () => {
    const x = world({
      'doc-a': { sessionId: 's1', status: 'closed' },
      'doc-b': { sessionId: undefined },
      'doc-c': { sessionId: 's3', wake: false },
      'doc-d': { sessionId: 's4', throws: true },
    });
    expect(await x.w.tick()).toEqual([]);
    expect(x.calls).toEqual([]);
  });

  it('a session is woken once per run: of its reviews the one waiting longest, other sessions independently', async () => {
    const x = world({
      'doc-late': { sessionId: 's1', oldest: '2026-11-12T10:05:00.000Z' },
      'doc-early': { sessionId: 's1', oldest: '2026-11-12T10:01:00.000Z' },
      'doc-other': { sessionId: 's2', oldest: '2026-11-12T10:09:00.000Z' },
    });
    const woke = await x.w.tick();
    expect(x.calls.sort()).toEqual([['s1', 'doc-early'], ['s2', 'doc-other']]);
    expect(woke).toHaveLength(2);
    // the later review of s1 does not get a second injection while the first one is still unanswered
    await x.w.tick();
    expect(x.calls).toHaveLength(2);
    // once the early one is answered the later one is the session's oldest batch: a new wake-up
    x.reviews['doc-early'].wake = false;
    await x.w.tick();
    expect(x.calls).toContainEqual(['s1', 'doc-late']);
    expect(x.calls).toHaveLength(3);
  });

  it('a transient refusal is retried after 15 s, at most 3 times; the success ends it', async () => {
    const x = world({ 'doc-a': { sessionId: 's1' } }, [{ ok: false, reason: 'idle-too-short' }, { ok: false, reason: 'not-idle' }]);
    expect(await x.w.tick()).toEqual([]);
    expect(x.calls).toHaveLength(1);
    x.advance(WAKE_RETRY_MS - 1);
    expect(await x.w.tick()).toEqual([]);
    expect(x.calls).toHaveLength(1); // not yet
    x.advance(1);
    expect(await x.w.tick()).toEqual([]); // retry 1: refused again
    expect(x.calls).toHaveLength(2);
    x.advance(WAKE_RETRY_MS);
    expect(await x.w.tick()).toEqual([{ sessionId: 's1', reviewId: 'doc-a' }]); // retry 2: ok
    expect(x.calls).toHaveLength(3);
    x.advance(5 * WAKE_RETRY_MS);
    await x.w.tick();
    expect(x.calls).toHaveLength(3);
  });

  it('gives up after the first attempt plus 3 retries', async () => {
    const x = world({ 'doc-a': { sessionId: 's1' } }, Array.from({ length: 10 }, () => ({ ok: false, reason: 'inject-failed' })));
    for (let i = 0; i < 12; i++) {
      await x.w.tick();
      x.advance(WAKE_RETRY_MS);
    }
    expect(x.calls).toHaveLength(1 + WAKE_MAX_RETRIES);
  });

  it('a permanent refusal is final for that batch (a new batch is tried again)', async () => {
    const x = world({ 'doc-a': { sessionId: 's1' } }, [{ ok: false, reason: 'target-owned-by-another-session' }]);
    expect(await x.w.tick()).toEqual([]);
    for (let i = 0; i < 3; i++) {
      x.advance(WAKE_RETRY_MS * 2);
      await x.w.tick();
    }
    expect(x.calls).toHaveLength(1);
    x.reviews['doc-a'].oldest = '2026-11-12T12:00:00.000Z';
    expect(await x.w.tick()).toHaveLength(1);
    expect(x.calls).toHaveLength(2);
  });

  it('an injectWake that throws counts as a transient inject-failed', async () => {
    const x = world({ 'doc-a': { sessionId: 's1' } }, [new Error('tmux died')]);
    expect(await x.w.tick()).toEqual([]);
    x.advance(WAKE_RETRY_MS);
    expect(await x.w.tick()).toHaveLength(1);
    expect(x.calls).toHaveLength(2);
  });

  it('without a usable injector injectWake is not called; an injector registered later is picked up', async () => {
    const x = world({ 'doc-a': { sessionId: 's1', usable: false } });
    await x.w.tick();
    await x.w.tick();
    expect(x.calls).toEqual([]);
    x.reviews['doc-a'].usable = true;
    expect(await x.w.tick()).toHaveLength(1);
  });

  it('while the session\'s wake-up watcher is alive nothing is typed; once it is gone the injection is allowed again', async () => {
    const x = world({ 'doc-a': { sessionId: 's1', channel: 'watch' } });
    await x.w.tick();
    await x.w.tick();
    expect(x.calls).toEqual([]);
    x.reviews['doc-a'].channel = 'A'; // the watcher died (Claude Code stopped it, the next Stop has not armed another)
    expect(await x.w.tick()).toHaveLength(1);
    expect(x.calls).toEqual([['s1', 'doc-a']]);
  });

  it('default dependencies read the real store without throwing (empty RD_HOME)', async () => {
    const spy = vi.fn();
    const w = createWakeWatcher({ injectWake: spy });
    expect(await w.tick()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
