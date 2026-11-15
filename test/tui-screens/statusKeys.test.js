import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { buildStatusBar } from '../../src/tui/lib/statusModel.js';
import { mapKey, mapConfirmKey, splitKeys } from '../../src/tui/lib/keymap.js';
import { buildHeader, sessionText, stateText } from '../../src/tui/lib/headerModel.js';
import { segsText, segsWidth } from '../../src/tui/lib/ansi.js';

const base = { mode: 'normal', sendMode: 'instant', readOnly: false, canReply: false, canResolve: false, resolved: false, drafts: 0, notice: null, confirm: null, mouseOn: true, cursorText: 'L3/10' };
const K = (o = {}) => ({ ctrl: false, meta: false, shift: false, escape: false, return: false, tab: false, ...o });

describe('status bar', () => {
  it('is exactly as wide as the terminal and reports button ranges', () => {
    for (const cols of [40, 80, 160]) {
      const { segs, buttons } = buildStatusBar({ ...base, canReply: true, canResolve: true }, cols);
      expect(segsWidth(segs)).toBe(cols);
      const text = segsText(segs);
      for (const b of buttons) {
        const label = [...text].slice(0, 0).join('') + sliceCols(text, b.x0, b.x1);
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });

  it('button ranges select the right text', () => {
    const { segs, buttons } = buildStatusBar({ ...base, canReply: true, canResolve: true }, 120);
    const text = segsText(segs);
    const get = (a) => {
      const b = buttons.find((x) => x.action === a);
      return sliceCols(text, b.x0, b.x1);
    };
    expect(get('comment')).toBe('c comment');
    expect(get('reply')).toBe('r reply');
    expect(get('resolve')).toBe('x resolve');
    expect(get('approve')).toBe('A approve');
    expect(get('help')).toBe('? help');
  });

  it('shows reopen for a resolved thread, submit n in batch mode, and nothing destructive when read-only', () => {
    const resolved = buildStatusBar({ ...base, canResolve: true, resolved: true }, 120);
    expect(segsText(resolved.segs)).toContain('x reopen');
    const batch = buildStatusBar({ ...base, sendMode: 'batch', drafts: 3 }, 120);
    expect(segsText(batch.segs)).toContain('s submit 3');
    expect(segsText(batch.segs)).toContain('batch');
    const ro = buildStatusBar({ ...base, readOnly: true }, 120);
    expect(ro.buttons.map((b) => b.action)).toEqual(['diff', 'help', 'back']); // the diff of a finished review can still be read
  });

  it('drops low-priority buttons first when narrow, keeps comment and approve', () => {
    const { buttons } = buildStatusBar({ ...base, sendMode: 'batch', canReply: true, canResolve: true }, 44);
    const actions = buttons.map((b) => b.action);
    expect(actions).toContain('comment');
    expect(actions).toContain('approve');
    expect(actions).not.toContain('back');
  });

  it('the essential buttons (comment / approve, comment / cancel in visual mode) win over the mode and mouse notes at 40 columns', () => {
    const wide = { ...base, cursorText: 'L123/456', mouseOn: false, mdMode: 'rendered' };
    for (const s of [{ sendMode: 'batch' }, { mode: 'visual', visualKind: 'char' }]) {
      const { segs, buttons } = buildStatusBar({ ...wide, ...s }, 40);
      expect(segsWidth(segs)).toBe(40);
      const actions = buttons.map((b) => b.action);
      expect(actions).toContain('comment');
      expect(actions).toContain(s.mode === 'visual' ? 'cancel' : 'approve');
    }
  });

  it('notice replaces the hints; confirm shows y / n buttons', () => {
    const n = buildStatusBar({ ...base, notice: { text: 'sent', kind: 'info' } }, 80);
    expect(segsText(n.segs)).toContain('sent');
    expect(n.buttons).toEqual([]);
    const c = buildStatusBar({ ...base, mode: 'confirm', confirm: { text: 'Approve this plan?', yes: 'approve', no: 'cancel' } }, 100);
    expect(c.buttons.map((b) => b.action)).toEqual(['confirmYes', 'confirmNo']);
    expect(segsText(c.segs)).toContain('CONFIRM');
  });

  it('mouse-off indicator', () => {
    expect(segsText(buildStatusBar({ ...base, mouseOn: false }, 80).segs)).toContain('mouse off');
  });

  it('says how a Markdown body is shown (md / src), and nothing for other files', () => {
    expect(segsText(buildStatusBar({ ...base, mdMode: 'rendered' }, 80).segs)).toContain('instant · md · L3/10');
    expect(segsText(buildStatusBar({ ...base, mdMode: 'source' }, 80).segs)).toContain('instant · src · L3/10');
    const plain = segsText(buildStatusBar({ ...base, mdMode: null }, 80).segs);
    expect(plain).not.toContain(' md ');
    expect(plain).not.toContain(' src ');
    expect(segsWidth(buildStatusBar({ ...base, mdMode: 'rendered', mouseOn: false }, 40).segs)).toBe(40);
  });
});

// Slice a string by display columns.
function sliceCols(text, x0, x1) {
  let out = '';
  let col = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (col >= x0 && col + w <= x1) out += ch;
    col += w;
  }
  return out;
}

describe('keymap', () => {
  const m = (input, key = K(), pending = null, mode = 'normal') => mapKey(input, key, pending, mode)?.action ?? null;
  it('movement', () => {
    expect(m('j')).toBe('down');
    expect(m('k')).toBe('up');
    expect(m('', K({ downArrow: true }))).toBe('down');
    expect(m('', K({ upArrow: true }))).toBe('up');
    expect(m('d', K({ ctrl: true }))).toBe('halfDown');
    expect(m('u', K({ ctrl: true }))).toBe('halfUp');
    expect(m('g')).toBe('top');
    expect(m('G')).toBe('bottom');
  });
  it(']c and [c are two-key sequences', () => {
    expect(mapKey(']', K(), null, 'normal')).toEqual({ action: 'pendingKey', pending: ']' });
    expect(m('c', K(), ']')).toBe('nextThread');
    expect(m('c', K(), '[')).toBe('prevThread');
    expect(m('c', K(), null)).toBe('comment');
    expect(m('j', K(), ']')).toBe('down'); // another key cancels the sequence and works normally
  });
  it('commands', () => {
    const table = { v: 'visualChar', V: 'visualLine', c: 'comment', C: 'commentExternal', r: 'reply', R: 'replyExternal', x: 'resolve', D: 'deleteDraft', d: 'diff', s: 'submit', B: 'toggleMode', A: 'approve', E: 'endQna', q: 'back', '?': 'help', m: 'toggleMouse', M: 'toggleMd', O: 'channelC', U: 'adoptExternal', S: 'rebind', h: 'left', l: 'right', w: 'wordNext', b: 'wordPrev', e: 'wordEnd', 0: 'lineStart', '^': 'firstNonBlank', $: 'lineEnd' };
    for (const [k, a] of Object.entries(table)) expect(m(k)).toBe(a);
    expect(m('', K({ escape: true }))).toBe('escape');
    expect(m('z')).toBeNull();
    expect(m('<')).toBeNull(); // < and > only mean something inside the diff view (mapDiffKey)
    expect(m('>')).toBeNull();
  });
  it('arrows are h / j / k / l; in visual mode q cancels', () => {
    expect(m('', K({ leftArrow: true }))).toBe('left');
    expect(m('', K({ rightArrow: true }))).toBe('right');
    expect(m('q', K(), null, 'visual')).toBe('escape');
  });
  it('Ctrl+C is q: back in normal mode, cancels a selection in visual mode, never a command', () => {
    expect(m('c', K({ ctrl: true }))).toBe('back');
    expect(m('c', K({ ctrl: true }), null, 'visual')).toBe('escape');
    expect(m('c', K({ ctrl: true }), ']')).toBe('back'); // even half-way through a two-key sequence
    expect(m('c', K())).toBe('comment'); // the plain key is unchanged
  });
  it('confirm keys', () => {
    expect(mapConfirmKey('c', K({ ctrl: true }))).toBe('no');
    expect(mapConfirmKey('c', K())).toBeNull();
    expect(mapConfirmKey('y', K())).toBe('yes');
    expect(mapConfirmKey('', K({ return: true }))).toBe('yes');
    expect(mapConfirmKey('n', K())).toBe('no');
    expect(mapConfirmKey('', K({ escape: true }))).toBe('no');
    expect(mapConfirmKey('x', K())).toBeNull();
  });
  it('splitKeys turns a coalesced chunk into separate key presses', () => {
    expect(splitKeys('jjk', K())).toEqual([['j', K()], ['j', K()], ['k', K()]]);
    expect(splitKeys('j', K())).toEqual([['j', K()]]);
    expect(splitKeys('j\r', K())).toEqual([['j', K()], ['', { ...K(), return: true }]]);
    expect(splitKeys('ab', K({ ctrl: true }))).toHaveLength(1);
    // control characters keep their meaning inside a chunk (two Ctrl-d in one write)
    expect(splitKeys('\x04\x04', K())).toEqual([['d', { ...K(), ctrl: true }], ['d', { ...K(), ctrl: true }]]);
    expect(splitKeys('j\x1b', K())[1]).toEqual(['', { ...K(), escape: true }]);
  });
});

describe('header', () => {
  const meta = { id: 'doc-1', kind: 'doc', title: 'Weekly report · Week 45', status: 'in_review', currentRevision: 2, revisions: [{}, {}] };
  const session = { state: 'idle', pid: 48213 };
  it('shows title, revision, session and mode; exactly cols wide', () => {
    for (const cols of [40, 60, 80, 160]) {
      const segs = buildHeader({ meta, session, sessionAlive: true, hookAlive: false, sendMode: 'instant', cols });
      expect(segsWidth(segs)).toBe(cols);
    }
    const text = segsText(buildHeader({ meta, session, sessionAlive: true, hookAlive: false, sendMode: 'instant', cols: 160 }));
    expect(text).toContain('Weekly report · Week 45');
    expect(text).toContain('rev 2/2');
    expect(text).toContain('session idle (pid 48213)');
    expect(text).toContain('instant mode');
    expect(text).toContain('[d] diff');
  });
  it('plan states', () => {
    const plan = { ...meta, kind: 'plan' };
    expect(stateText(plan, true).text).toBe('plan · waiting for your decision');
    expect(stateText(plan, false).text).toContain('not waiting');
    // delivered = Claude has the feedback; it no longer means "waiting for a resubmission"
    expect(stateText({ ...plan, status: 'delivered' }, false).text).toBe('Claude has it · answering');
    expect(stateText({ ...plan, status: 'answered' }, false).text).toBe('Claude answered');
    expect(stateText({ ...plan, status: 'feedback_pending' }, false).text).toContain('waiting for delivery');
    expect(stateText({ ...plan, status: 'approved' }, false).text).toBe('approved');
    expect(stateText({ ...plan, status: 'approved', approvedPendingExit: true }, false).text).toContain('passes once Claude submits the plan');
    // Claude waits in `rd await`: the Q&A part of the header says so, the state part stays quiet
    expect(stateText(plan, false, { awaitingAlive: true })).toBeNull();
    expect(stateText(meta, false)).toBeNull();
  });
  it('a long state gives way to its short wording before other parts are dropped (60 columns)', () => {
    const plan = { ...meta, kind: 'plan', title: 'Migration plan' };
    const text = segsText(buildHeader({ meta: plan, session, sessionAlive: true, hookAlive: false, sendMode: 'instant', cols: 60 }));
    expect(text).toContain('Claude not waiting');
    expect(text).not.toContain('Claude is not waiting for this plan');
    expect(text).toContain('[d] diff');
    const roomy = segsText(buildHeader({ meta: plan, session, sessionAlive: true, hookAlive: false, sendMode: 'instant', cols: 140 }));
    expect(roomy).toContain('Claude is not waiting for this plan');
  });
  it('short wordings are used before the revision or the session state is dropped', () => {
    const plan = { ...meta, kind: 'plan', title: 'Plan: refactor the device table', currentRevision: 1, revisions: [{}] };
    const at80 = segsText(buildHeader({ meta: plan, session, sessionAlive: true, hookAlive: false, sendMode: 'instant', cols: 80 }));
    expect(at80).toContain('rev 1/1');
    expect(at80).toContain('Claude not waiting');
    const delivery = { channel: 'A', reason: '', sessionState: 'idle', awaitingAlive: false, interrupted: false, instantEnded: false, wakeNeeded: false, queuedCount: 0 };
    const at160 = segsText(buildHeader({ meta, session, sessionAlive: true, hookAlive: false, sendMode: 'instant', cols: 160, delivery }));
    expect(at160).toContain('After you send: with your next message');
    expect(at160).not.toContain('/review-reply');
    expect(at160).toContain('session idle (pid 48213)');
    expect(at160).toContain('instant mode');
  });
  it('session text', () => {
    expect(sessionText(null, false)).toBe('session ?');
    expect(sessionText({ state: 'ended' }, false)).toBe('session ended');
    expect(sessionText({ state: 'busy', pid: 1 }, false)).toBe('session gone');
    expect(sessionText({ state: 'busy', pid: 7 }, true)).toBe('session busy (pid 7)');
  });
  it('drops optional parts before the title when narrow', () => {
    const text = segsText(buildHeader({ meta: { ...meta, title: '很长很长的标题'.repeat(8) }, session, sessionAlive: true, hookAlive: false, sendMode: 'batch', cols: 40 }));
    expect(stringWidth(text)).toBe(40);
    expect(text).toContain('…');
  });
  it('shows a new-plan hint', () => {
    const text = segsText(buildHeader({ meta, session, sessionAlive: true, hookAlive: false, sendMode: 'instant', cols: 120, incoming: 'another plan' }));
    expect(text).toContain('new plan: another plan');
  });
});
