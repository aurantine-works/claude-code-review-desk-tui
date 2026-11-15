import { describe, it, expect } from 'vitest';
import { buildReviewFrame } from '../../src/tui/lib/reviewFrame.js';
import { DocLayout } from '../../src/tui/lib/viewport.js';
import { classifyLines } from '../../src/tui/lib/markdown.js';
import { buildThreadView } from '../../src/tui/lib/threadView.js';
import { initialState } from '../../src/tui/lib/reviewNav.js';
import { segsText, segsWidth } from '../../src/tui/lib/ansi.js';
import { thread, anchor, msg } from './harness.js';

const lines = Array.from({ length: 80 }, (_, i) => (i === 3 ? '迁移旧 store 的风险较低，因为只影响两个 slice。' : `line ${i + 1}`));
const meta = { kind: 'doc', status: 'in_review', currentRevision: 1 };

function frame({ size = { columns: 160, rows: 40 }, state = {}, threads = [] } = {}) {
  const doc = new DocLayout(lines);
  const view = buildThreadView(threads, lines.length);
  return buildReviewFrame({ s: { ...initialState(), ...state }, doc, lines, info: classifyLines(lines), view, meta, size });
}

describe('buildReviewFrame', () => {
  it('draws exactly the viewport: body rows of the right width, panel rows of the right width', () => {
    const F = frame({ threads: [thread('t1', anchor(4))] });
    expect(F.docRows).toHaveLength(F.geo.bodyH);
    for (const r of F.docRows) expect(segsWidth(r)).toBe(F.geo.docW);
    expect(F.panelRows).toHaveLength(F.geo.bodyH);
    for (const r of F.panelRows) expect(segsWidth(r)).toBe(F.geo.panelW);
    expect(F.view.byLine.get(3)[0].id).toBe('t1');
  });

  it('normalises the scroll position to the cursor (resize, jumps)', () => {
    const F = frame({ state: { cursor: 70, top: { line: 0, sub: 0 } } });
    expect(F.state.top.line).toBeGreaterThan(0);
    expect(F.win.rowOf(70)).toBeGreaterThanOrEqual(0);
    const clamped = frame({ state: { cursor: 500 } });
    expect(clamped.state.cursor).toBe(79);
  });

  it('wide: the comment box sits below the selection, left aligned, and masks the rows under it', () => {
    const sel = { startLine: 4, endLine: 4, startCol: 11, endCol: 15 };
    const F = frame({ state: { mode: 'input', input: { kind: 'comment', sel, text: 'hi' } } });
    const { boxRect: b, boxModel: m, geo } = F;
    expect(b.y).toBe(geo.bodyY + F.win.rowOf(3) + 1); // directly under the selected row
    expect(b.x).toBe(F.layout.length ? b.x : 0);
    expect(b.w).toBe(72);
    expect(m.height).toBe(b.h);
    // rows under the box are blank to the right of the box's left edge, but keep their gutter and left part
    const masked = segsText(F.docRows[F.win.rowOf(3) + 2]);
    expect(masked.slice(0, 4).trim()).not.toBe('');
    expect(masked.slice(b.x).trim()).toBe('');
    // the selected row itself stays readable
    expect(segsText(F.docRows[F.win.rowOf(3)])).toContain('风险较低');
  });

  it('wide: the box flips above the selection near the bottom of the pane', () => {
    const sel = { startLine: 79, endLine: 79, startCol: null, endCol: null };
    const F = frame({ state: { cursor: 78, mode: 'input', input: { kind: 'comment', sel, text: '' } } });
    const rowOfSel = F.win.rowOf(78);
    expect(F.boxRect.y + F.boxRect.h).toBeLessThanOrEqual(F.geo.bodyY + rowOfSel);
  });

  it('narrow: the box floats at the bottom; the drawer and the document keep their size', () => {
    const sel = { startLine: 4, endLine: 4, startCol: null, endCol: null };
    const threads = [thread('t1', anchor(4))];
    const closed = frame({ size: { columns: 80, rows: 30 }, threads });
    const open = frame({ size: { columns: 80, rows: 30 }, threads, state: { mode: 'input', input: { kind: 'comment', sel, text: 'a\nb\nc\nd\ne\nf' } } });
    expect(closed.geo.drawerH).toBe(8);
    expect(open.geo).toEqual(closed.geo); // no reflow
    expect(open.boxRect).toMatchObject({ x: 0, w: 80, h: open.boxModel.height });
    expect(open.boxRect.y + open.boxRect.h).toBe(open.geo.statusY); // sits right above the status bar
    expect(open.drawer.rows).toHaveLength(8);
    expect(open.docRows).toHaveLength(closed.docRows.length);
    // the cursor stays above the box
    expect(open.ctx.bodyH).toBeLessThan(open.geo.bodyH);
    expect(open.win.rowOf(open.cursor)).toBeLessThan(open.ctx.bodyH);
  });

  it('narrow: scrolling keeps the cursor above the box', () => {
    const sel = { startLine: 70, endLine: 70, startCol: null, endCol: null };
    const F = frame({ size: { columns: 80, rows: 24 }, state: { cursor: 69, mode: 'input', input: { kind: 'comment', sel, text: Array(6).fill('x').join('\n') } } });
    const row = F.win.rowOf(69);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(F.geo.bodyY + row).toBeLessThan(F.boxRect.y);
  });

  it('reply: the box floats next to the thread card; the panel is not re-laid out', () => {
    const t = thread('t1', anchor(4), [msg('m1', 'user', 'q', { state: 'sent' }), msg('m2', 'claude', 'a')], 'answered');
    const plain = frame({ threads: [t, thread('t2', anchor(6), [msg('m1', 'user', 'q2', { state: 'sent' })], 'answered')], state: { focusId: 't1' } });
    const F = frame({ threads: [t, thread('t2', anchor(6), [msg('m1', 'user', 'q2', { state: 'sent' })], 'answered')], state: { focusId: 't1', mode: 'input', input: { kind: 'reply', threadId: 't1', text: '' } } });
    expect(F.boxRect.x).toBe(F.geo.panelX + 1);
    expect(F.boxRect.w).toBe(F.geo.panelW - 2);
    expect(F.boxRect.y).toBeGreaterThan(F.geo.bodyY);
    expect(F.panelRows.map((r) => segsText(r))).toEqual(plain.panelRows.map((r) => segsText(r))); // identical content under the box
    expect(F.docRows.map((r) => segsText(r))).toEqual(plain.docRows.map((r) => segsText(r)));
  });

  it('whatever the state, an open box is completely on screen', () => {
    const longText = Array(12).fill('第二行很长很长很长的中文内容很长很长很长').join('\n');
    const t = (id, line) => thread(id, anchor(line), [msg('m1', 'user', '一条很长的批注'.repeat(30), { state: 'sent' }), msg('m2', 'claude', '答复'.repeat(40))], 'answered');
    const threads = [t('t1', 4), t('t2', 5), t('t3', 70)];
    for (const size of [{ columns: 160, rows: 45 }, { columns: 160, rows: 14 }, { columns: 120, rows: 24 }, { columns: 80, rows: 30 }, { columns: 44, rows: 14 }]) {
      for (const text of ['', 'hi', longText]) {
        for (const input of [
          { kind: 'comment', sel: { startLine: 4, endLine: 4, startCol: 3, endCol: 9 }, text },
          { kind: 'comment', sel: { startLine: 79, endLine: 80, startCol: null, endCol: null }, text },
          { kind: 'reply', threadId: 't1', text },
          { kind: 'reply', threadId: 't3', text },
        ]) {
          for (const top of [{ line: 0, sub: 0 }, { line: 60, sub: 0 }]) {
            const F = frame({ size, threads, state: { top, cursor: top.line + 2, focusId: input.threadId ?? null, mode: 'input', input } });
            const b = F.boxRect;
            const label = `${size.columns}x${size.rows} ${input.kind} ${input.threadId ?? ''} text=${text.length}`;
            expect(b, label).toBeTruthy();
            expect(b.x, label).toBeGreaterThanOrEqual(0);
            expect(b.y, label).toBeGreaterThanOrEqual(F.geo.bodyY);
            expect(b.x + b.w, label).toBeLessThanOrEqual(size.columns);
            expect(b.y + b.h, label).toBeLessThanOrEqual(F.geo.statusY);
          }
        }
      }
    }
  });

  it('the overlap menu is drawn over the document', () => {
    const ts = [thread('t1', anchor(4)), thread('t2', anchor(4))];
    const F = frame({ threads: ts, state: { mode: 'menu', menu: { ids: ['t1', 't2'], index: 1, row: 3, col: 12 } } });
    const texts = F.docRows.map((r) => segsText(r));
    expect(texts.some((t) => t.includes('t1') && t.includes('open'))).toBe(true);
    expect(texts.some((t) => t.includes('› t2'))).toBe(true);
    expect(F.menu).toMatchObject({ height: 2 });
  });

  it('highlights: focused anchor background differs from the rest', () => {
    const t = thread('t1', anchor(4));
    const a = frame({ threads: [t], state: { focusId: 't1' } });
    const b = frame({ threads: [t], state: { focusId: null } });
    const bgs = (F) => new Set(F.docRows[F.win.rowOf(3)].map((s) => s.style?.bg).filter(Boolean));
    expect([...bgs(a)]).not.toEqual([...bgs(b)]);
  });
});
