import { describe, it, expect } from 'vitest';
import { sortMetas, visibleMetas, inboxCounts, buildRows, formatRow, inboxColumns, tierOf } from '../../src/tui/lib/inboxModel.js';
import { segsText, segsWidth } from '../../src/tui/lib/ansi.js';
import { findAutoOpen, autoOpenKey } from '../../src/tui/lib/watch.js';

const meta = (id, status, updatedAt, extra = {}) => ({ id, kind: 'doc', status, updatedAt, title: id, cwd: '/home/u/proj', currentRevision: 1, ...extra });

describe('inbox ordering', () => {
  const metas = [
    meta('d-delivered', 'delivered', '2026-01-01T10:00:00Z'),
    meta('d-answered', 'answered', '2026-01-01T09:00:00Z'),
    meta('d-await-old', 'awaiting_review', '2026-01-01T08:00:00Z'),
    meta('d-await-new', 'awaiting_review', '2026-01-01T11:00:00Z'),
    meta('d-inreview', 'in_review', '2026-01-01T07:00:00Z'),
    meta('d-pending', 'feedback_pending', '2026-01-01T12:00:00Z'),
    meta('d-approved', 'approved', '2026-01-01T13:00:00Z'),
    meta('d-closed', 'closed', '2026-01-01T14:00:00Z'),
  ];
  it('awaiting_review (and in_review) -> answered -> feedback_pending/delivered -> rest; newest first within a tier', () => {
    expect(sortMetas(metas).map((m) => m.id)).toEqual([
      'd-await-new',
      'd-await-old',
      'd-inreview',
      'd-answered',
      'd-pending',
      'd-delivered',
      'd-closed',
      'd-approved',
    ]);
  });
  it('hides approved and closed unless "show all"', () => {
    expect(visibleMetas(metas, false).map((m) => m.id)).not.toContain('d-approved');
    expect(visibleMetas(metas, false)).toHaveLength(6);
    expect(visibleMetas(metas, true)).toHaveLength(8);
  });
  it('counts open and answered reviews', () => {
    expect(inboxCounts(metas)).toEqual({ open: 5, answered: 1 });
  });
  it('tiers', () => {
    expect(tierOf(meta('x', 'awaiting_review'))).toBe(0);
    expect(tierOf(meta('x', 'answered'))).toBe(1);
    expect(tierOf(meta('x', 'approved'))).toBe(3);
  });
});

describe('inbox rows', () => {
  const m = meta('plan-1', 'answered', new Date(Date.now() - 10 * 60 * 1000).toISOString(), { kind: 'plan', title: '重构设备表格的执行计划' });
  const threads = new Map([['plan-1', [{ status: 'answered' }, { status: 'answered' }, { status: 'open' }]]]);
  const [row] = buildRows([m], { threads, hookAlive: new Map() });

  it('builds a row with project, answered count and a short age', () => {
    expect(row).toMatchObject({ kind: 'plan', project: 'proj', status: 'answered (2/3)', age: '10m ago' });
  });

  it('marks a plan nobody is waiting for', () => {
    const [r] = buildRows([meta('p', 'awaiting_review', new Date().toISOString(), { kind: 'plan' })], { threads: new Map(), hookAlive: new Map([['p', false]]) });
    expect(r.stale).toBe(true);
    const [alive] = buildRows([meta('p', 'awaiting_review', new Date().toISOString(), { kind: 'plan' })], { threads: new Map(), hookAlive: new Map([['p', true]]) });
    expect(alive.stale).toBe(false);
  });

  it('formats rows to exactly the terminal width at several widths', () => {
    for (const cols of [60, 80, 100, 160]) {
      expect(segsWidth(formatRow(row, cols, false))).toBe(cols);
      expect(segsWidth(formatRow(row, cols, true))).toBe(cols);
    }
    const wide = segsText(formatRow(row, 160, false));
    expect(wide).toContain('plan');
    expect(wide).toContain('proj');
    expect(wide).toContain('重构设备表格的执行计划');
    expect(wide).toContain('answered (2/3)');
    expect(wide).toContain('10m ago');
    expect(inboxColumns(60).project).toBe(0); // narrow terminals drop the project column
  });
});

describe('watch mode: findAutoOpen', () => {
  const plan = (id, extra = {}) => meta(id, 'awaiting_review', '2026-01-01T10:00:00Z', { kind: 'plan', hook: { pid: 1, since: 'S1' }, ...extra });
  const data = (metas, alive) => ({ metas, hookAlive: alive });

  it('opens a plan whose hook is waiting, once', () => {
    const seen = new Set();
    const d = data([plan('plan-a')], { 'plan-a': true });
    const c = findAutoOpen(d, seen);
    expect(c.id).toBe('plan-a');
    seen.add(c.key);
    expect(findAutoOpen(d, seen)).toBeNull();
  });

  it('opens again for a new revision or when the hook starts waiting again', () => {
    const seen = new Set([autoOpenKey(plan('plan-a'))]);
    expect(findAutoOpen(data([plan('plan-a', { currentRevision: 2 })], { 'plan-a': true }), seen)?.id).toBe('plan-a');
    expect(findAutoOpen(data([plan('plan-a', { hook: { pid: 1, since: 'S2' } })], { 'plan-a': true }), seen)?.id).toBe('plan-a');
  });

  it('ignores plans nobody is waiting for, and reviews that are not awaiting_review', () => {
    expect(findAutoOpen(data([plan('plan-a')], { 'plan-a': false }), new Set())).toBeNull();
    expect(findAutoOpen(data([plan('plan-a', { status: 'in_review' })], { 'plan-a': true }), new Set())).toBeNull();
    expect(findAutoOpen(data([plan('plan-a', { status: 'delivered' })], { 'plan-a': true }), new Set())).toBeNull();
  });

  it('docs open only with config.docs.autoOpen', () => {
    const d = data([meta('doc-a', 'awaiting_review', '2026-01-01T10:00:00Z')], {});
    expect(findAutoOpen(d, new Set())).toBeNull();
    expect(findAutoOpen(d, new Set(), { docsAutoOpen: true })?.id).toBe('doc-a');
  });

  it('oldest waiting review first', () => {
    const a = plan('plan-a', { updatedAt: '2026-01-01T12:00:00Z' });
    const b = plan('plan-b', { updatedAt: '2026-01-01T09:00:00Z' });
    expect(findAutoOpen(data([a, b], { 'plan-a': true, 'plan-b': true }), new Set()).id).toBe('plan-b');
  });
});
