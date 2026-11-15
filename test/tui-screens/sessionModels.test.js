import { describe, it, expect, beforeEach } from 'vitest';
import stringWidth from 'string-width';
import { buildStatusBar } from '../../src/tui/lib/statusModel.js';
import { buildHeader, diffPart } from '../../src/tui/lib/headerModel.js';
import { channelHint, deliveryNotice, pendingLabelFor, summarizeDelivery } from '../../src/tui/lib/deliveryModel.js';
import { refusalText, headlessPart, headlessLine, headlessEndNotice, channelCOffer, takeAutoOpen, resetAutoOpen, tildePath, RESUMABLE_REASONS } from '../../src/tui/lib/channelC.js';
import { createExternalTracker, externalPart } from '../../src/tui/lib/externalModel.js';
import { sessionChoices, candidateLine, movePick, pickWindow, ellipsize } from '../../src/tui/lib/pickList.js';
import { channelCRows, pickerRows, boxLayout } from '../../src/tui/lib/dialogModel.js';
import { newlyAnswered } from '../../src/tui/lib/watch.js';
import { helpLines, helpRows, helpMaxTop } from '../../src/tui/Help.js';
import { segsText, segsWidth } from '../../src/tui/lib/ansi.js';

const base = { mode: 'normal', sendMode: 'instant', readOnly: false, canReply: false, canResolve: false, resolved: false, drafts: 0, notice: null, confirm: null, mouseOn: true, cursorText: 'L1/9' };
const actions = (s, cols = 120) => buildStatusBar(s, cols).buttons.map((b) => b.action);

describe('status bar: d / O / U / S / diff', () => {
  it('normal mode offers diff always, O / U / S only when they apply', () => {
    expect(actions(base)).toContain('diff');
    for (const a of ['channelC', 'adoptExternal', 'rebind']) expect(actions(base)).not.toContain(a);
    const all = actions({ ...base, canResume: true, canAdopt: true, canRebind: true });
    for (const a of ['channelC', 'adoptExternal', 'rebind', 'diff']) expect(all).toContain(a);
    // a finished review offers none of the write-ish ones
    expect(actions({ ...base, readOnly: true, canResume: true, canAdopt: true, canRebind: true })).toEqual(['diff', 'help', 'back']);
  });

  it('narrow bars drop the least important buttons first and keep O / U / diff / comment', () => {
    const narrow = buildStatusBar({ ...base, canResume: true, canAdopt: true, canRebind: true }, 56);
    const a = narrow.buttons.map((b) => b.action);
    expect(a).toContain('comment');
    expect(a).toContain('channelC');
    expect(a).toContain('adoptExternal');
    expect(a).not.toContain('rebind');
    expect(segsWidth(narrow.segs)).toBe(56);
  });

  it('diff mode: its own buttons and badge; every button has a known action', () => {
    const bar = buildStatusBar({ ...base, diff: true }, 120);
    expect(segsText(bar.segs)).toContain(' DIFF ');
    expect(bar.buttons.map((b) => b.action)).toEqual(['diffBack', 'diffJump', 'diffOlder', 'diffNewer', 'diffNext', 'help']);
    const narrow = buildStatusBar({ ...base, diff: true }, 50);
    expect(narrow.buttons.map((b) => b.action)).toContain('diffBack');
    expect(segsWidth(narrow.segs)).toBe(50);
  });

  it('dialog and picker modes show their own hints even while a notice is set', () => {
    const d = buildStatusBar({ ...base, mode: 'dialog', notice: { text: 'sent' } }, 100);
    expect(segsText(d.segs)).toContain(' SESSION ');
    expect(segsText(d.segs)).toContain('h resume in background');
    expect(segsText(d.segs)).not.toContain('sent');
    const p = buildStatusBar({ ...base, mode: 'picker' }, 100);
    expect(segsText(p.segs)).toContain('Enter bind');
  });
});

describe('header: diff, external change, background resume', () => {
  const meta = { id: 'doc-x', kind: 'doc', title: 'Weekly report', status: 'in_review', currentRevision: 3, revisions: [{}, {}, {}], round: 0 };
  const hdr = (extra, cols = 160) => segsText(buildHeader({ meta, session: { state: 'ended' }, sessionAlive: false, hookAlive: false, sendMode: 'instant', cols, ...extra }));

  it('diff view: range, counts, and the way back', () => {
    const t = hdr({ diff: { from: 2, to: 3, kind: 'rows', summary: { added: 4, removed: 1 } } });
    expect(t).toContain('diff rev 2→3 · +4 -1');
    expect(t).toContain('[d] back to text');
    expect(diffPart({ from: 1, to: 3, kind: 'tooLarge', summary: {} }).text).toContain('too many changes');
    expect(diffPart({ from: 1, to: 3, kind: 'identical', summary: {} }).text).toContain('no differences');
    expect(hdr({})).toContain('[d] diff');
  });

  it('external change and missing file banners', () => {
    const changed = { state: 'changed', canAdopt: true, tooLarge: false, binary: false, waitMs: 0 };
    expect(hdr({ external: changed })).toContain('file modified outside · U makes a new revision');
    expect(hdr({ external: { ...changed, canAdopt: false, tooLarge: true } })).toContain('over 2MB');
    expect(hdr({ external: { ...changed, canAdopt: false, binary: true } })).toContain('not text');
    expect(hdr({ external: { state: 'missing', canAdopt: false, waitMs: 0 } })).toContain('file is missing (showing the snapshot)');
    expect(hdr({ external: { state: 'same', canAdopt: false, waitMs: 0 } })).not.toContain('modified outside');
  });

  it('background resume: running / failed (log path) / finished', () => {
    const run = { state: 'running', pid: 4242, log: '/x/headless.log', pending: 1, unreceived: 0 };
    expect(hdr({ headless: run })).toContain('resuming in background (pid 4242)');
    expect(hdr({ headless: { ...run, state: 'failed', exitCode: 1 } })).toContain('background resume failed: see /x/headless.log');
    expect(hdr({ headless: { ...run, state: 'finished', pending: 0 } })).toContain('background resume finished');
    expect(hdr({ headless: { ...run, state: 'finished', pending: 2 } })).toContain('2 still unanswered: see /x/headless.log');
  });

  it('every combination fits exactly the width, down to 40 columns, keeping the most important part', () => {
    const extra = {
      diff: { from: 1, to: 3, kind: 'rows', summary: { added: 12, removed: 3 } },
      external: { state: 'changed', canAdopt: true, waitMs: 0 },
      headless: { state: 'failed', pid: 1, log: '/home/dev/.review-desk/logs/headless-doc-20261112-105130-f20q.log', pending: 1 },
      delivery: { channel: 'C', reason: 'session-ended', queuedCount: 2, queuedIds: ['t1'], answeringIds: [], sessionState: 'ended', injectorKind: 'none' },
    };
    for (const cols of [40, 56, 80, 110, 160]) {
      const segs = buildHeader({ meta, session: { state: 'ended' }, sessionAlive: false, hookAlive: false, sendMode: 'batch', cols, ...extra });
      expect(segsWidth(segs)).toBe(cols);
    }
    expect(hdr(extra, 80)).toMatch(/diff|modified outside|background resume/);
  });
});

describe('delivery texts for channel C', () => {
  const sum = (extra) => summarizeDelivery({ channel: 'C', reason: 'session-ended', sessionState: 'ended', injector: { kind: 'none', usable: false } }, { queued: [], answering: [], ...extra });

  it('the header says O resume only when something is queued', () => {
    expect(channelHint({ channel: 'C', reason: 'session-ended', queuedCount: 1 }).text).toBe('session ended · O resume');
    expect(channelHint({ channel: 'C', reason: 'session-ended', queuedCount: 0 }).text).toBe('session ended');
    expect(channelHint({ channel: 'C', reason: 'no-session', queuedCount: 1 }).text).toBe('session not found');
    expect(channelHint({ channel: 'C', reason: 'headless-running', queuedCount: 1 })).toBeNull(); // the headless part says it
    expect(sum({ queued: [{ threadId: 't1' }, { threadId: 't1' }] }).queuedCount).toBe(2);
  });

  it('pending lines and the notice after sending', () => {
    const d = { channel: 'C', reason: 'session-ended', queuedIds: ['t1'], answeringIds: [] };
    expect(pendingLabelFor({ id: 't1' }, d)).toBe('sent · session ended · O resume');
    expect(pendingLabelFor({ id: 't1' }, { ...d, reason: 'headless-running' })).toContain('resuming in the background');
    expect(pendingLabelFor({ id: 't1' }, { ...d, headlessRunning: true })).toContain('resuming in the background'); // (our run is alive, the session record is not updated yet)
    expect(channelHint({ channel: 'C', reason: 'session-ended', queuedCount: 1, headlessRunning: true })).toBeNull();
    expect(deliveryNotice({ channel: 'C', reason: 'session-ended' }).text).toBe('sent · session ended · O resume');
    expect(deliveryNotice({ channel: 'C', reason: 'headless-running' }).text).toContain('resuming in the background');
    expect(deliveryNotice({ channel: 'C', reason: 'no-session' }).text).toContain('no matching session');
    for (const text of [channelHint({ channel: 'C', reason: 'session-ended', queuedCount: 1 }).text, deliveryNotice({ channel: 'C', reason: 'session-ended' }).text]) expect(text).not.toContain('M3');
  });
});

describe('channelC model', () => {
  beforeEach(() => resetAutoOpen());

  it('every startHeadless refusal has its own readable message (and unknown ones fall back to the raw text)', () => {
    const reasons = ['review-finished', 'no-session', 'invalid-session-id', 'nothing-waiting', 'session-alive', 'headless-running', 'cwd-missing', 'spawn-failed'];
    const seen = new Set();
    for (const reason of reasons) {
      const t = refusalText({ reason, message: 'english', cwd: '/gone', error: 'spawn ENOENT' });
      expect(t).toMatch(/[a-z]{3,} [a-z]{3,}/);
      expect(t).not.toContain('english');
      seen.add(t);
    }
    expect(seen.size).toBe(reasons.length);
    expect(refusalText({ reason: 'cwd-missing', cwd: '/gone' })).toContain('/gone');
    expect(refusalText({ reason: 'spawn-failed', error: 'spawn nope ENOENT' })).toContain('spawn nope ENOENT');
    expect(refusalText({ reason: 'brand-new', message: 'something odd' })).toContain('something odd');
  });

  it('headless status -> header part, dialog line, end notice', () => {
    const f = { state: 'failed', pid: 7, log: '/h/log', exitCode: 2, signal: null, pending: 1, unreceived: 0 };
    expect(headlessPart(null)).toBeNull();
    expect(headlessPart({ ...f, state: 'running' }).text).toBe('resuming in background (pid 7)');
    expect(headlessPart(f).text).toBe('background resume failed: see /h/log');
    expect(headlessPart({ ...f, state: 'finished', pending: 0 }).kind).toBe('dim');
    expect(headlessPart({ ...f, state: 'finished' }).text).toContain('1 still unanswered');
    expect(headlessLine(f)).toContain('exit code 2');
    expect(headlessLine({ ...f, exitCode: null, signal: 'SIGKILL' })).toContain('SIGKILL');
    expect(headlessLine({ ...f, exitCode: null })).toContain('did not take the feedback');
    expect(headlessLine({ ...f, state: 'running' })).toContain('running (pid 7)');
    expect(headlessEndNotice(f)).toMatchObject({ kind: 'err' });
    expect(headlessEndNotice({ ...f, state: 'finished', pending: 0 })).toMatchObject({ kind: 'info', text: 'Background resume finished' });
    expect(tildePath('/home/me/.review-desk/x.log', '/home/me')).toBe('~/.review-desk/x.log');
    expect(tildePath('/elsewhere/x', '/home/me')).toBe('/elsewhere/x');
  });

  it('the dialog is offered for a resumable channel C with something queued; one batch is announced once', () => {
    const plan = (channel, reason) => () => ({ channel, reason });
    const st = (at) => () => ({ queued: at.map((x) => ({ at: x })) });
    const offer = (channel, reason, at) => channelCOffer('doc-x', { planDelivery: plan(channel, reason), deliveryState: st(at) });
    expect(offer('C', 'session-ended', ['2026-01-01T00:00:02Z', '2026-01-01T00:00:01Z'])).toMatchObject({ offer: true, queued: 2, key: 'doc-x|2026-01-01T00:00:01Z' });
    expect(offer('C', 'process-gone', ['x']).offer).toBe(true);
    expect(offer('C', 'session-ended', []).offer).toBe(false);
    expect(offer('C', 'no-session', ['x']).offer).toBe(false);
    expect(offer('C', 'headless-running', ['x']).offer).toBe(false);
    expect(offer('A', 'idle-no-injector', ['x']).offer).toBe(false);
    expect([...RESUMABLE_REASONS].sort()).toEqual(['process-gone', 'session-ended']);

    const first = offer('C', 'session-ended', ['t1']);
    expect(takeAutoOpen(first)).toBe(true);
    expect(takeAutoOpen(offer('C', 'session-ended', ['t1']))).toBe(false); // the same batch (even with more messages joining it)
    expect(takeAutoOpen(offer('C', 'session-ended', ['t1', 't2']))).toBe(false);
    expect(takeAutoOpen(offer('C', 'session-ended', ['t3']))).toBe(true); // a new batch after the old one was taken
    expect(takeAutoOpen(offer('A', 'idle-no-injector', ['t9']))).toBe(false);
  });
});

describe('external change tracker', () => {
  const mk = () => {
    let t = 1000;
    const tracker = createExternalTracker({ now: () => t });
    return { tracker, advance: (ms) => (t += ms) };
  };

  it('reports a difference only after the same content has lasted 3 s; a new sha restarts the clock', () => {
    const { tracker, advance } = mk();
    expect(tracker.observe({ state: 'same', sha: 'a' }).state).toBe('same');
    const first = tracker.observe({ state: 'changed', sha: 'b' });
    expect(first).toMatchObject({ state: 'same', waitMs: 3000 });
    advance(2000);
    expect(tracker.observe({ state: 'changed', sha: 'b' })).toMatchObject({ state: 'same', waitMs: 1000 });
    advance(900);
    expect(tracker.observe({ state: 'changed', sha: 'c' }).waitMs).toBe(3000); // still being edited
    advance(2999);
    expect(tracker.observe({ state: 'changed', sha: 'c' }).state).toBe('same');
    advance(1);
    expect(tracker.observe({ state: 'changed', sha: 'c' })).toMatchObject({ state: 'changed', canAdopt: true, waitMs: 0 });
  });

  it('going back to the same content clears it; settling / skipped never report', () => {
    const { tracker, advance } = mk();
    tracker.observe({ state: 'changed', sha: 'b' });
    advance(5000);
    expect(tracker.observe({ state: 'changed', sha: 'b' }).state).toBe('changed');
    expect(tracker.observe({ state: 'same', sha: 'a' }).state).toBe('same');
    expect(tracker.observe({ state: 'same', settling: true, sha: 'x' })).toMatchObject({ state: 'same', waitMs: 0 });
    expect(tracker.observe({ state: 'same', skipped: true }).state).toBe('same');
    expect(tracker.observe(null).state).toBe('same');
  });

  it('too large and binary files are reported but cannot be adopted; a missing file follows the same rule', () => {
    const { tracker, advance } = mk();
    tracker.observe({ state: 'changed', tooLarge: true });
    advance(3000);
    expect(tracker.observe({ state: 'changed', tooLarge: true })).toMatchObject({ state: 'changed', canAdopt: false, tooLarge: true });
    tracker.observe({ state: 'changed', sha: 'z', binary: true });
    advance(3000);
    expect(tracker.observe({ state: 'changed', sha: 'z', binary: true })).toMatchObject({ canAdopt: false, binary: true });
    tracker.observe({ state: 'missing' });
    expect(tracker.observe({ state: 'missing' })).toMatchObject({ state: 'same', waitMs: 3000 });
    advance(3000);
    expect(tracker.observe({ state: 'missing' }).state).toBe('missing');
    expect(externalPart({ state: 'missing' }).text).toBe('file is missing (showing the snapshot)');
    expect(externalPart({ state: 'same' })).toBeNull();
  });
});

describe('session pick lists', () => {
  const meta = {
    sessionId: 's-current',
    cwd: '/work/b',
    writers: [
      { sessionId: 's-other', cwd: '/work/a', project: 'a', lastAt: '2026-01-01T00:00:00Z', firstPrompt: 'write a weekly report', source: 'writes' },
      { sessionId: 's-current', cwd: '/work/b', project: 'b', lastAt: '2026-01-02T00:00:00Z', firstPrompt: 'quick fix', source: 'transcript' },
    ],
  };

  it('choices: the bound session first and marked, then the other writers; a current session that is not listed is added', () => {
    const items = sessionChoices(meta);
    expect(items.map((i) => [i.sessionId, i.current])).toEqual([['s-current', true], ['s-other', false]]);
    expect(items[0].project).toBe('b');
    const lone = sessionChoices({ sessionId: 's9', cwd: '/w/x', writers: [] });
    expect(lone).toHaveLength(1);
    expect(lone[0]).toMatchObject({ sessionId: 's9', project: 'x', current: true });
    expect(sessionChoices({ writers: undefined })).toEqual([]);
  });

  it('a row shows project, session, first prompt and the current marker, exactly the width', () => {
    for (const w of [40, 80, 120]) {
      const line = candidateLine({ ...sessionChoices(meta)[0], firstPrompt: '一个很长的第一条提示'.repeat(20) }, w, true);
      expect(segsWidth(line)).toBe(w);
    }
    const text = segsText(candidateLine(sessionChoices(meta)[0], 80, false));
    expect(text).toContain('b ');
    expect(text).toContain('s-curren');
    expect(text).toContain('[current]');
    expect(text).toContain('quick fix');
    expect(ellipsize('abcdef', 4)).toBe('abc…');
  });

  it('selection and window maths', () => {
    expect(movePick(0, 3, 'up')).toBe(0);
    expect(movePick(1, 3, 'down')).toBe(2);
    expect(movePick(2, 3, 'down')).toBe(2);
    expect(movePick(1, 3, 'top')).toBe(0);
    expect(movePick(1, 3, 'bottom')).toBe(2);
    expect(movePick(0, 0, 'down')).toBe(0);
    expect(pickWindow(0, 10, 4)).toBe(0);
    expect(pickWindow(5, 10, 4, 0)).toBe(2);
    expect(pickWindow(1, 10, 4, 2)).toBe(1);
  });
});

describe('dialog layout', () => {
  const d = { reviewId: 'doc-x', queued: 2, sessionId: '12345678-aaaa', command: null, copied: false, error: null, busy: false };

  it('the channel C dialog: three pressable rows inside a box, centred in the body, every row exactly the body width', () => {
    for (const [w, h] of [[80, 20], [160, 30], [60, 12]]) {
      const r = channelCRows({ width: w, height: h, d });
      expect(r.rows).toHaveLength(h);
      for (const row of r.rows) expect(segsWidth(row)).toBe(w);
      expect([...new Set(r.hits.map((x) => x.action))]).toEqual(['dialog:show', 'dialog:headless', 'dialog:leave']); // a button whose description wraps owns every row of it
      for (const hit of r.hits) {
        expect(hit.x1).toBeGreaterThan(hit.x0);
        expect(hit.y).toBeGreaterThanOrEqual(0);
        expect(hit.y).toBeLessThan(h);
      }
    }
    const text = channelCRows({ width: 100, height: 24, d }).rows.map(segsText).join('\n');
    expect(text).toContain('2 comments queued');
    expect(text).toContain('[c] show resume command');
    expect(text).toContain('[h] resume in background and answer');
    expect(text).toContain('[l] leave for later');
  });

  it('the one-shot tip follows [l] when there is room and is left out in compact mode (little height)', () => {
    const roomy = channelCRows({ width: 100, height: 30, d }).rows.map(segsText);
    const yL = roomy.findIndex((r) => r.includes('[l] leave for later'));
    const yTip = roomy.findIndex((r) => r.includes('Tip:'));
    expect(yTip).toBeGreaterThan(yL);
    expect(roomy.slice(yTip).join('').replace(/[│\s]/g, '')).toContain('Tip:hisaone-shotstart;addinganothercommentmeansresumingagainandcostsmoretokens.Foraback-and-forth,usec');
    for (const [w, h] of [[80, 9], [60, 8], [60, 12]]) {
      const text = channelCRows({ width: w, height: h, d }).rows.map(segsText).join('').replace(/[│\s]/g, '');
      expect(text).not.toContain('Tip:');
      for (const k of ['[c]', '[h]resumeinbackgroundandanswer', '[l]', 'Esc']) expect(text).toContain(k);
    }
  });

  it('shows the command, the copy note, a refusal, the headless status and the busy state', () => {
    const r = channelCRows({
      width: 100,
      height: 30,
      d: { ...d, command: 'cd /work/b && claude --resume 12345678-aaaa', copied: true, error: 'the session is still running', busy: false },
      headless: { state: 'failed', pid: 9, log: '/l/h.log', exitCode: 1, pending: 1 },
    });
    const text = r.rows.map(segsText).join('\n');
    expect(text).toContain('cd /work/b && claude --resume 12345678-aaaa');
    expect(text).toContain('Tried to copy to the clipboard');
    expect(text).toContain('! the session is still running');
    expect(text).toContain('Last background resume failed (exit code 1)');
    expect(channelCRows({ width: 100, height: 24, d: { ...d, busy: true } }).rows.map(segsText).join('\n')).toContain('starting the background resume');
  });

  it('a long command wraps inside the box instead of running over the border', () => {
    const cmd = `cd /a/very/long/${'dir/'.repeat(30)} && claude --resume 12345678-aaaa-bbbb-cccc-1234567890ab`;
    const rows = channelCRows({ width: 80, height: 40, d: { ...d, command: cmd } }).rows.map(segsText);
    for (const row of rows) expect(stringWidth(row)).toBe(80);
    expect(rows.join('').replace(/[│\s]/g, '')).toContain(cmd.replace(/\s/g, ''));
  });

  it('the picker lists the choices with a press target per row and the selected one marked', () => {
    const items = sessionChoices({ sessionId: 'cur', cwd: '/w/c', writers: [{ sessionId: 'o1', cwd: '/w/o1', project: 'o1', firstPrompt: 'first one' }, { sessionId: 'o2', cwd: '/w/o2', project: 'o2', firstPrompt: 'second one' }] });
    const r = pickerRows({ width: 100, height: 20, picker: { items, index: 1, first: 0 }, title: 'bind to another session' });
    expect(r.hits.map((x) => x.action)).toEqual(['pick:0', 'pick:1', 'pick:2']);
    const text = r.rows.map(segsText).join('\n');
    expect(text).toContain('bind to another session');
    expect(text).toMatch(/▸ o1/);
    expect(text).toContain('dir /w/o1');
    const tiny = pickerRows({ width: 50, height: 8, picker: { items, index: 2, first: 0 }, title: 't' });
    expect(tiny.rows).toHaveLength(8);
    expect(tiny.hits.some((x) => x.action === 'pick:2')).toBe(true); // the window follows the selection
  });

  it('boxLayout never draws taller than the body', () => {
    const r = boxLayout({ width: 40, height: 5, title: 't', build: () => Array.from({ length: 20 }, () => ({ segs: [{ text: 'x', style: null }] })) });
    expect(r.rows).toHaveLength(5);
  });
});

describe('watch: newly answered, help text', () => {
  it('only a status change to answered counts, not a review that was answered all along or is new', () => {
    const prev = new Map([['a', 'delivered'], ['b', 'answered'], ['c', 'in_review']]);
    const now = [{ id: 'a', status: 'answered' }, { id: 'b', status: 'answered' }, { id: 'c', status: 'in_review' }, { id: 'd', status: 'answered' }];
    expect(newlyAnswered(prev, now)).toEqual(['a']);
    expect(newlyAnswered(new Map(), now)).toEqual([]);
  });

  it('help wraps long descriptions under the key column and scrolls', () => {
    const entries = [['Group', null], ['O', 'a long description '.repeat(30)], ['x', 'short']];
    const narrow = helpLines(entries, 50);
    expect(narrow.length).toBeGreaterThan(3);
    for (const r of narrow) expect(segsWidth(r)).toBe(50);
    expect(helpMaxTop(entries, 50, 3)).toBe(narrow.length - 2);
    const rows = helpRows(entries, 50, 4, 'Title', 1);
    expect(rows).toHaveLength(4);
    expect(segsText(rows[0])).toContain('Title');
    expect(segsText(rows[1])).not.toContain('Group'); // scrolled past the group header
    expect(helpMaxTop(entries, 50, 100)).toBe(0);
  });
});
