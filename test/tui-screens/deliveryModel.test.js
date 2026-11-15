import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import {
  summarizeDelivery,
  deliveryParts,
  pendingLabelFor,
  deliveryNotice,
  endInstantNotice,
  needsReviewReplyHint,
  channelHint,
  wakeText,
  watchText,
  approvedWakeText,
} from '../../src/tui/lib/deliveryModel.js';
import { buildHeader, stateText } from '../../src/tui/lib/headerModel.js';
import { buildCard } from '../../src/tui/lib/cards.js';
import { segsText, segsWidth } from '../../src/tui/lib/ansi.js';
import { thread, anchor, msg } from './harness.js';

const base = { channel: 'A', reason: 'idle-no-injector', sessionState: 'idle', injectorKind: 'none', injectorUsable: false, awaitingAlive: false, interrupted: false, instantEnded: false, queuedIds: [], answeringIds: [], wakeNeeded: false, oldestReceivedAt: null };
const D = (o = {}) => ({ ...base, ...o });

describe('summarizeDelivery', () => {
  it('keeps what the screen needs and drops the per-second noise', () => {
    const plan = { channel: 'await', reason: 'awaiting-alive', sessionState: 'idle', idleForMs: 12345, injector: { kind: 'tmux', usable: true, target: '%1' } };
    const state = { awaiting: { alive: true }, watcher: { alive: true }, interrupted: false, instantEnded: false, queued: [{ threadId: 't1' }, { threadId: 't1' }, { threadId: 't2' }], answering: ['t3'], wakeNeeded: false, oldestReceivedAt: null };
    const d = summarizeDelivery(plan, state);
    expect(d).toMatchObject({ channel: 'await', awaitingAlive: true, watcherAlive: true, injectorUsable: true, injectorKind: 'tmux', queuedIds: ['t1', 't2'], answeringIds: ['t3'] });
    expect(JSON.stringify(d)).not.toContain('12345');
  });
});

describe('header parts', () => {
  it('nothing for a finished review; the Q&A state beats the channel hint', () => {
    expect(deliveryParts(D({ channel: 'none' }))).toEqual([]);
    expect(deliveryParts(D({ channel: 'await', awaitingAlive: true })).map((p) => p.text)).toEqual(['instant Q&A']);
    expect(deliveryParts(D({ interrupted: true })).map((p) => p.text)).toEqual(['Q&A interrupted', 'After you send: delivered with your next message (type /review-reply in Claude)']);
    expect(deliveryParts(D({ instantEnded: true })).map((p) => p.text)[0]).toBe('instant Q&A ended');
  });

  it('the watcher channel: automatic delivery, no /review-reply anywhere, no A hint', () => {
    const d = D({ channel: 'watch', reason: 'watcher-alive', watcherAlive: true });
    expect(channelHint(d)).toEqual({ text: watchText(), short: 'After you send: automatic', kind: 'dim' });
    expect(watchText()).toBe('After you send: delivered to Claude automatically');
    expect(deliveryParts(d).map((p) => p.text)).toEqual([watchText()]);
    expect(deliveryParts(D({ ...d, sessionState: 'busy' })).map((p) => p.text)).toEqual([watchText()]);
    expect(needsReviewReplyHint(d)).toBe(false);
    expect(needsReviewReplyHint(D({ ...d, sessionState: 'idle' }))).toBe(false);
    // a live rd await still reads instant Q&A
    expect(deliveryParts(D({ channel: 'await', awaitingAlive: true, watcherAlive: true })).map((p) => p.text)).toEqual(['instant Q&A']);
    // the unanswered warning stays, the hint after it
    expect(deliveryParts(D({ ...d, wakeNeeded: true })).map((p) => p.text)).toEqual([wakeText(), watchText()]);
  });

  it('every channel has a hint', () => {
    expect(channelHint(D({ channel: 'inject' })).text).toBe('After you send: injected automatically');
    expect(channelHint(D({ channel: 'B' })).text).toBe('After you send: injected when this turn ends');
    expect(channelHint(D({ channel: 'hook' })).text).toBe('After you send: delivered via the plan hook');
    expect(channelHint(D({ channel: 'C', reason: 'session-ended' })).text).toContain('session ended');
    expect(channelHint(D({ channel: 'C', reason: 'no-session' })).text).toBe('session not found');
    expect(channelHint(D({ channel: 'await' }))).toBeNull();
  });

  it('the wake-up hint is the most important part', () => {
    const parts = deliveryParts(D({ wakeNeeded: true }));
    expect(parts[0]).toMatchObject({ id: 'wake', text: wakeText(), kind: 'warn' });
    expect(Math.max(...parts.map((p) => p.prio))).toBe(parts[0].prio);
  });

  it('the /review-reply start hint is for an idle session that cannot be reached', () => {
    expect(needsReviewReplyHint(D())).toBe(true);
    expect(needsReviewReplyHint(D({ sessionState: 'busy', channel: 'B' }))).toBe(false);
    expect(needsReviewReplyHint(D({ channel: 'await' }))).toBe(false);
    expect(needsReviewReplyHint(null)).toBe(false);
  });
});

describe('buildHeader with delivery', () => {
  const meta = { id: 'doc-1', kind: 'doc', title: 'Weekly report', status: 'in_review', currentRevision: 2, revisions: [{}, {}], round: 3 };
  const header = (cols, delivery, extra = {}) => buildHeader({ meta: { ...meta, ...extra }, session: { state: 'idle', pid: 7 }, sessionAlive: true, hookAlive: false, sendMode: 'instant', cols, delivery });

  it('round N follows rev n/m (only once there is a round)', () => {
    expect(segsText(header(160, D()))).toContain('rev 2/2 · round 3');
    expect(segsText(header(160, D(), { round: 0 }))).not.toContain('round');
  });

  it('is always exactly cols wide, whatever the delivery state', () => {
    for (const cols of [40, 60, 80, 120, 160]) {
      for (const d of [null, D(), D({ wakeNeeded: true, interrupted: true }), D({ channel: 'await', awaitingAlive: true })]) {
        expect(segsWidth(header(cols, d))).toBe(cols);
      }
    }
  });

  it('narrow: long channel hints use their short wording; the wake-up hint outlives everything else', () => {
    const t80 = segsText(header(80, D()));
    expect(t80).toContain('After you send: with your next message');
    expect(t80).not.toContain('(type /review-reply in Claude)');
    expect(segsText(header(80, D({ wakeNeeded: true })))).toContain(wakeText());
    const woke = segsText(header(58, D({ wakeNeeded: true })));
    expect(woke).toContain(wakeText()); // the diff hint, rev and the rest go first
    expect(woke).not.toContain('[d] diff');
    expect(stringWidth(woke)).toBe(58);
  });

  it('an ended session is said once: channel C\'s own hint replaces the plain "session ended"', () => {
    const ended = (delivery, session = { state: 'ended' }) => segsText(buildHeader({ meta, session, sessionAlive: false, hookAlive: false, sendMode: 'instant', cols: 160, delivery }));
    const none = ended(D({ channel: 'C', reason: 'session-ended', sessionState: 'ended' }));
    expect(none).toContain('session ended');
    expect(none.match(/session ended/g)).toHaveLength(1); // not repeated by the plain session part
    const queued = ended(D({ channel: 'C', reason: 'session-ended', sessionState: 'ended', queuedIds: ['t1'], queuedCount: 1 }));
    expect(queued).toContain('session ended · O resume');
    expect(queued.match(/session ended/g)).toHaveLength(1);
    expect(ended(D({ channel: 'C', reason: 'process-gone', sessionState: 'ended' }))).not.toContain('session gone');
    expect(ended(D({ channel: 'C', reason: 'no-session', sessionState: 'unknown' }), null)).not.toContain('session ?');
    // without a channel C hint (no delivery info, or rd's own resume is running) the session part stays
    expect(ended(null).match(/session ended/g)).toHaveLength(1);
    const running = segsText(buildHeader({ meta, session: { state: 'ended' }, sessionAlive: false, hookAlive: false, sendMode: 'instant', cols: 160, headless: { state: 'running', pid: 9, log: '/l' }, delivery: D({ channel: 'C', reason: 'session-ended', sessionState: 'ended', queuedCount: 1 }) }));
    expect(running).toContain('resuming in background (pid 9)');
    expect(running.match(/session ended/g)).toHaveLength(1); // the plain session part stays
  });

  it('plan: instant Q&A replaces "Claude is not waiting for this plan"', () => {
    const plan = { ...meta, kind: 'plan' };
    expect(stateText(plan, false, D()).text).toContain('Claude is not waiting for this plan');
    expect(stateText(plan, false, D({ awaitingAlive: true }))).toBeNull();
    expect(stateText(plan, false, D({ channel: 'watch' }))).toBeNull(); // the watcher wakes Claude for the next comment / the approval
    expect(stateText({ ...plan, status: 'answered' }, false, D({ channel: 'watch' })).text).toBe('Claude answered');
  });

  it('the header shows the watcher hint and stays exactly cols wide', () => {
    const d = D({ channel: 'watch', reason: 'watcher-alive', watcherAlive: true });
    const text = segsText(header(160, d));
    expect(text).toContain('After you send: delivered to Claude automatically');
    expect(text).not.toContain('/review-reply');
    for (const cols of [40, 60, 80, 120]) expect(segsWidth(header(cols, d))).toBe(cols);
  });
});

describe('waiting lines of pending threads', () => {
  const t = thread('t1', anchor(3), [msg('m1', 'user', 'q', { state: 'sent' })]);
  it('being answered wins; queued ones say which channel will carry them', () => {
    expect(pendingLabelFor(t, D({ answeringIds: ['t1'] }))).toBe('Claude is answering…');
    const label = (channel, reason = '') => pendingLabelFor(t, D({ channel, reason, queuedIds: ['t1'] }));
    expect(label('await')).toBe('sent · Claude will receive it shortly');
    expect(label('A')).toContain('delivered with your next message');
    expect(label('B')).toContain('Claude picks it up when this turn ends');
    expect(label('inject')).toContain('injected');
    expect(label('hook')).toContain('plan hook');
    expect(label('watch')).toBe('sent · delivered automatically, Claude will receive it shortly');
    expect(label('watch')).not.toContain('/review-reply');
    expect(label('C', 'no-session')).toContain('no matching session found');
    expect(label('C', 'session-ended')).toContain('session ended');
  });
  it('without delivery info the old wording is kept', () => {
    expect(pendingLabelFor(t, null)).toBe('Claude is answering…');
  });
  it('long labels wrap inside the card instead of being cut', () => {
    const rows = buildCard(t, 24, { pendingLabel: pendingLabelFor(t, D({ queuedIds: ['t1'] })) }).map((r) => segsText(r));
    const text = rows.join('');
    expect(text.replace(/\s/g, '')).toContain('deliveredwithyournextmessage(type/review-replyinClaude)');
    for (const r of buildCard(t, 24, { pendingLabel: pendingLabelFor(t, D({ queuedIds: ['t1'] })) })) expect(segsWidth(r)).toBe(24);
  });
});

describe('system notes on cards', () => {
  const card = (messages) => buildCard(thread('t1', anchor(3), messages), 80).map((r) => segsText(r)).join('\n');

  it('an unanswered note is shown through t() by its kind, whatever text was stored; one without a kind is shown as stored', () => {
    expect(card([msg('m1', 'user', 'q', { state: 'sent' }), msg('m2', 'system', 'text stored by another UI language', { kind: 'unanswered' })])).toContain('system: Claude did not answer this one separately');
    expect(card([msg('m1', 'user', 'q', { state: 'sent' }), msg('m2', 'system', 'Claude 未单独回答此条')])).toContain('system: Claude 未单独回答此条');
  });
});

describe('messages', () => {
  it('after a send', () => {
    expect(deliveryNotice({ channel: 'await', action: 'none' }).text).toContain('instant Q&A');
    expect(deliveryNotice({ channel: 'A', action: 'none' }).text).toContain('/review-reply');
    expect(deliveryNotice({ channel: 'inject', action: 'injected' }).text).toBe('sent · /review-reply injected automatically');
    expect(deliveryNotice({ channel: 'A', action: 'failed', error: 'x' })).toMatchObject({ kind: 'warn' });
    expect(deliveryNotice({ channel: 'hook', reason: 'nothing-waiting', action: 'none' }).text).toBe('sent · Claude has received it');
    expect(deliveryNotice({ channel: 'C', reason: 'session-ended', action: 'none' }).kind).toBe('warn');
    expect(deliveryNotice({ channel: 'B', action: 'none' }).text).toContain('this turn ends');
    expect(deliveryNotice({ channel: 'watch', reason: 'watcher-alive', action: 'none' })).toEqual({ text: 'sent · delivered to Claude automatically', kind: 'info' });
    expect(approvedWakeText()).toContain('woken up automatically');
  });
  it('after E', () => {
    expect(endInstantNotice({ ended: ['a', 'b'], awaitingAlive: true })).toEqual({
      text: "Ended this session's instant Q&A (2 reviews); Claude's rd await exits within 1 s",
      kind: 'info',
    });
    expect(endInstantNotice({ ended: ['a'], awaitingAlive: false })).toEqual({ text: 'Instant Q&A ended (Claude is not waiting right now)', kind: 'info' });
    expect(endInstantNotice({ ended: ['a'], awaitingAlive: false, watcherAlive: true }).text).toBe('Instant Q&A ended (Claude is not waiting right now); automatic delivery is unaffected, new comments are delivered as usual');
    expect(endInstantNotice({ ended: ['a'], awaitingAlive: true, watcherAlive: true }).text).toContain('rd await exits within 1 s');
    expect(endInstantNotice({ ended: [], awaitingAlive: true }).text).toContain('already ended'); // nothing new: it had been ended
    expect(endInstantNotice({ ended: [], awaitingAlive: false }).text).toContain('already ended');
  });
});
