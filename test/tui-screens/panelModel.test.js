import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { buildCard, wrapPlain } from '../../src/tui/lib/cards.js';
import { layoutPanel, layoutDrawer } from '../../src/tui/lib/panelModel.js';
import { buildThreadView, stepThread, threadFromCursor, reopenStatus, lastDraft, countDrafts } from '../../src/tui/lib/threadView.js';
import { segsText, segsWidth } from '../../src/tui/lib/ansi.js';

const anchor = (startLine, endLine = startLine, extra = {}) => ({ revision: 1, startLine, endLine, startCol: null, endCol: null, quote: `q${startLine}`, before: '', after: '', orphaned: false, ...extra });
const msg = (id, author, text, extra = {}) => ({ id, author, text, at: 't', revision: 1, ...extra });
const thread = (id, a, messages, status = 'open') => ({ id, status, anchor: a, messages });
const meta = { kind: 'doc', status: 'in_review', currentRevision: 1 };
const lines = (rows) => rows.map((r) => segsText(r));

describe('wrapPlain', () => {
  it('wraps CJK text by display width and keeps explicit newlines', () => {
    const out = wrapPlain('一二三四五六七八九十\n第二行', 8);
    expect(out).toEqual(['一二三四', '五六七八', '九十', '第二行']);
    for (const l of out) expect(stringWidth(l)).toBeLessThanOrEqual(8);
  });
});

describe('buildCard', () => {
  it('header, messages with authors, and the waiting line for a pending thread', () => {
    const t = thread('t1', anchor(14, 16), [msg('m1', 'user', 'What is this based on?', { state: 'sent' })]);
    const rows = lines(buildCard(t, 40));
    expect(rows[0]).toContain('t1 · L14-16 · open');
    expect(rows[1]).toContain('you: What is this based on?');
    expect(rows[rows.length - 1]).toContain('Claude is answering…');
    for (const r of buildCard(t, 40)) expect(segsWidth(r)).toBe(40);
  });

  it('answered thread: both authors, no waiting line', () => {
    const t = thread('t1', anchor(3), [msg('m1', 'user', 'why', { state: 'sent' }), msg('m2', 'claude', 'because')], 'answered');
    const rows = lines(buildCard(t, 40));
    expect(rows.some((r) => r.includes('Claude: because'))).toBe(true);
    expect(rows.some((r) => r.includes('is answering'))).toBe(false);
  });

  it('drafts are labelled and counted in the header', () => {
    const t = thread('t2', anchor(1), [msg('m1', 'user', 'maybe', { state: 'draft' })]);
    const rows = lines(buildCard(t, 40));
    expect(rows[0]).toContain('1 draft');
    expect(rows[1]).toContain('you·draft: maybe');
    expect(rows.some((r) => r.includes('is answering'))).toBe(false); // a draft is not waiting for Claude
  });

  it('resolved threads say so; orphaned threads keep a short quote', () => {
    const r = thread('t3', anchor(1), [msg('m1', 'user', 'x', { state: 'sent' }), msg('m2', 'claude', 'y')], 'resolved');
    expect(lines(buildCard(r, 40))[0]).toContain('resolved ✓');
    const o = thread('t4', anchor(2, 2, { orphaned: true, quote: '很长很长很长的引用文字'.repeat(6) }), [msg('m1', 'user', 'x', { state: 'sent' })]);
    const rows = lines(buildCard(o, 30));
    expect(rows[1].trim().startsWith('“')).toBe(true);
    expect(rows[2].includes('…')).toBe(true);
  });

  it('is memoised per thread object and width', () => {
    const t = thread('t1', anchor(1), [msg('m1', 'user', 'a', { state: 'draft' })]);
    expect(buildCard(t, 30)).toBe(buildCard(t, 30));
    expect(buildCard(t, 30)).not.toBe(buildCard(t, 31));
  });
});

describe('thread view', () => {
  const t1 = thread('t1', anchor(5, 6), [msg('m1', 'user', 'a', { state: 'sent' })]);
  const t2 = thread('t2', anchor(2), [msg('m1', 'user', 'a', { state: 'sent' }), msg('m2', 'claude', 'b')], 'answered');
  const t3 = thread('t3', anchor(9, 9, { orphaned: true }), [msg('m1', 'user', 'a', { state: 'sent' })]);
  const t4 = thread('t4', anchor(5), [msg('m1', 'user', 'a', { state: 'draft' })], 'resolved');

  it('sorts by position, separates orphans, indexes by 0-based line', () => {
    const v = buildThreadView([t1, t2, t3, t4], 20);
    expect(v.placed.map((t) => t.id)).toEqual(['t2', 't1', 't4']);
    expect(v.orphans.map((t) => t.id)).toEqual(['t3']);
    expect(v.byLine.get(4).map((t) => t.id)).toEqual(['t1', 't4']);
    expect(v.byLine.get(5).map((t) => t.id)).toEqual(['t1']);
    expect(v.byLine.has(8)).toBe(false); // orphans have no line
  });

  it('marker status: the strongest thread on the line wins', () => {
    const v = buildThreadView([t1, t2, t4], 20);
    expect(v.markers.get(1)).toBe('answered');
    expect(v.markers.get(4)).toBe('open');
  });

  it('navigation wraps around', () => {
    const v = buildThreadView([t1, t2], 20);
    expect(threadFromCursor(v.placed, 0, 1).id).toBe('t2');
    expect(threadFromCursor(v.placed, 1, 1).id).toBe('t1');
    expect(threadFromCursor(v.placed, 4, 1).id).toBe('t2'); // wraps
    expect(threadFromCursor(v.placed, 4, -1).id).toBe('t2');
    expect(threadFromCursor(v.placed, 0, -1).id).toBe('t1'); // wraps
    expect(stepThread([t1, t2], 't1', 1).id).toBe('t2');
    expect(stepThread([], null, 1)).toBeNull();
  });

  it('helpers', () => {
    expect(reopenStatus(t2)).toBe('answered');
    expect(reopenStatus(t1)).toBe('open');
    expect(lastDraft(t4).id).toBe('m1');
    expect(lastDraft(t1)).toBeNull();
    expect(countDrafts([t1, t2, t4])).toBe(1);
  });
});

describe('layoutPanel', () => {
  const t1 = thread('t1', anchor(3), [msg('m1', 'user', 'one', { state: 'sent' }), msg('m2', 'claude', 'ans')], 'answered');
  const t2 = thread('t2', anchor(8), [msg('m1', 'user', 'two', { state: 'sent' }), msg('m2', 'claude', 'ans')], 'answered');
  const t3 = thread('t3', anchor(40), [msg('m1', 'user', 'far', { state: 'sent' }), msg('m2', 'claude', 'ans')], 'answered');
  const orphan = thread('t9', anchor(1, 1, { orphaned: true }), [msg('m1', 'user', 'lost', { state: 'sent' }), msg('m2', 'claude', 'ans')], 'answered');
  const view = buildThreadView([t1, t2, t3, orphan], 100);
  const rowOfLine = (l) => (l >= 0 && l < 20 ? l : -1); // viewport shows lines 0..19, one row each
  const base = { view, focusId: null, width: 40, height: 20, rowOfLine, topLine: 0, scroll: null, meta };

  it('aligns cards with the rows of their anchors and groups orphans at the end', () => {
    const p = layoutPanel(base);
    const rows = lines(p.rows);
    expect(rows[2]).toContain('t1 · L3');
    expect(rows[7]).toContain('t2 · L8');
    expect(rows.some((r) => r.includes('anchor lost'))).toBe(true);
    expect(rows.some((r) => r.includes('t9'))).toBe(true);
    for (const r of p.rows) expect(segsWidth(r)).toBe(40);
  });

  it('cards whose anchors are below the viewport pack after the last aligned card', () => {
    const rows = lines(layoutPanel(base).rows);
    const i2 = rows.findIndex((r) => r.includes('t2 ·'));
    const i3 = rows.findIndex((r) => r.includes('t3 ·'));
    expect(i3).toBeGreaterThan(i2);
  });

  it('exposes card rectangles for hit testing', () => {
    const p = layoutPanel(base);
    const c1 = p.cards.find((c) => c.id === 't1');
    expect(c1.y0).toBe(2);
    expect(c1.y1).toBeGreaterThan(c1.y0);
  });

  it('manual scroll shifts the content and is clamped', () => {
    const a = layoutPanel(base);
    const b = layoutPanel({ ...base, scroll: 1 });
    const row = (p, id) => lines(p.rows).findIndex((r) => r.includes(`${id} ·`));
    expect(row(b, 't2')).toBe(row(a, 't2') - 1);
    expect(layoutPanel({ ...base, scroll: 9999 }).shift).toBe(a.clamp(9999));
  });

  it('a floating reply box reflows nothing: the rows are the same, only the scroll may change to show card and box', () => {
    const plain = layoutPanel({ ...base, focusId: 't1' });
    const reply = layoutPanel({ ...base, focusId: 't1', reveal: { threadId: 't1', extra: 6 } });
    expect(lines(reply.rows)).toEqual(lines(plain.rows)); // everything fits: no scroll needed
    const ext = reply.cardExtent('t1');
    expect(ext.top).toBe(2);
    expect(ext.bottom).toBe(2 + buildCard(t1, 38, { focused: true }).length);
  });

  it('scrolls the panel so the card and the box below it are visible together', () => {
    // the card sits at the bottom of a short pane: without help the box would have no room below it
    const view2 = buildThreadView([t3], 100);
    const rowOf = (l) => (l === 39 ? 17 : -1);
    const p0 = layoutPanel({ ...base, view: view2, focusId: 't3', rowOfLine: rowOf, height: 20 });
    const p1 = layoutPanel({ ...base, view: view2, focusId: 't3', rowOfLine: rowOf, height: 20, reveal: { threadId: 't3', extra: 6 } });
    const h = buildCard(t3, 38, { focused: true }).length;
    expect(p0.cardExtent('t3').bottom + 6).toBeGreaterThan(20); // would not fit
    expect(p1.cardExtent('t3').bottom + 6).toBeLessThanOrEqual(20); // scrolled up to make room
    expect(p1.cardExtent('t3').top).toBeGreaterThanOrEqual(0);
    expect(h).toBeGreaterThan(0);
  });

  it('shows a hint when there are no threads', () => {
    const p = layoutPanel({ ...base, view: buildThreadView([], 10) });
    expect(p.empty).toBe(true);
    expect(lines(p.rows)[0]).toContain('No comments yet');
    // The mouse selection is gone: the hint names the keyboard selection, not dragging.
    const text = lines(p.rows).join('\n');
    expect(text).not.toContain('drag');
    expect(text).toContain('v selects text');
    expect(text).toContain('V selects whole lines');
  });

  it('a focused card off screen is brought into view', () => {
    const far = thread('t5', anchor(60), [msg('m1', 'user', 'x', { state: 'sent' }), msg('m2', 'claude', 'y')], 'answered');
    const v = buildThreadView([far], 100);
    const p = layoutPanel({ ...base, view: v, focusId: 't5', rowOfLine: () => -1, topLine: 0 });
    expect(lines(p.rows).some((r) => r.includes('t5 ·'))).toBe(true);
  });
});

describe('layoutDrawer', () => {
  const t = thread('t1', anchor(3), [msg('m1', 'user', '一二三四五六七八九十'.repeat(5), { state: 'sent' })]);
  it('stacks cards and scrolls within bounds', () => {
    const d = layoutDrawer({ threads: [t], focusId: 't1', width: 30, height: 4, scroll: 0, meta });
    expect(lines(d.rows)[0]).toContain('t1 · L3');
    expect(d.total).toBeGreaterThan(4);
    const s = layoutDrawer({ threads: [t], focusId: 't1', width: 30, height: 4, scroll: 99, meta });
    expect(s.scroll).toBe(d.total - 4);
    expect(s.rows).toHaveLength(4);
  });
});
