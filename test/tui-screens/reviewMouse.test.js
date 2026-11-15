import { describe, it, expect } from 'vitest';
import { handleMouse, menuRect } from '../../src/tui/lib/reviewMouse.js';
import { makeFrame, mouse, thread, anchor } from './harness.js';
import { segsText } from '../../src/tui/lib/ansi.js';
import { buildReviewFrame } from '../../src/tui/lib/reviewFrame.js';
import { classifyLines } from '../../src/tui/lib/markdown.js';
import { DocLayout } from '../../src/tui/lib/viewport.js';
import { buildThreadView } from '../../src/tui/lib/threadView.js';
import { initialState } from '../../src/tui/lib/reviewNav.js';

const lines = ['# Title', '', 'hello world and more text', '迁移旧 store 的风险较低', 'last line here', ...Array.from({ length: 100 }, (_, i) => `row ${i}`)];

function run(events, init = {}) {
  let { s, frame, ctx, geo } = makeFrame({ lines, cols: 160, rows: 40, ...init });
  const effects = [];
  for (const ev of events) {
    const out = handleMouse(ev, s, frame, ctx);
    s = out.state;
    if (out.effect) effects.push(out.effect);
  }
  return { s, effects, geo, frame, ctx };
}

// Screen cell of (line, text column): gutter is numWidth(3) + 3 = 6 wide for 105 lines.
const gutter = 6;
const cell = (geo, row, col) => [geo.docX + gutter + col, geo.bodyY + row];

describe('mouse: document pane', () => {
  it('a click puts the cursor on the clicked character and leaves visual mode', () => {
    const { geo } = makeFrame({ lines });
    const [x, y] = cell(geo, 2, 6); // the 'w' of world
    const { s } = run([mouse('press', x, y), mouse('release', x, y)], { state: { mode: 'visual', visual: { kind: 'char', anchor: { line: 0, off: 0 } } } });
    expect(s.cursor).toBe(2);
    expect(s.col).toBe(6);
    expect(s.goalCol).toBe(6);
    expect(s.mode).toBe('normal');
    expect(s.visual).toBeNull();
  });

  it('pressing the right half of a wide character selects that character; past the end the last one', () => {
    const { geo } = makeFrame({ lines });
    const [x, y] = cell(geo, 3, 1); // right half of 迁 (cols 0-1)
    expect(run([mouse('press', x, y)]).s.col).toBe(0);
    const [x2, y2] = cell(geo, 3, 40);
    expect(run([mouse('press', x2, y2)]).s.col).toBe(lines[3].length - 1);
  });

  it('dragging does nothing special: no selection state exists any more', () => {
    const { geo } = makeFrame({ lines });
    const [x, y] = cell(geo, 2, 3);
    const { s } = run([mouse('press', x, y), mouse('drag', x + 5, y), mouse('release', x + 5, y)]);
    expect(s.visual).toBeNull();
    expect(s.col).toBe(3); // the cursor stays where the button went down
    expect('sel' in s || 'drag' in s).toBe(false);
  });

  it('the wheel scrolls the document three rows', () => {
    const { geo } = makeFrame({ lines });
    const [x, y] = cell(geo, 5, 1);
    const { s } = run([mouse('wheel', x, y, 'wheelDown')]);
    expect(s.top.line).toBe(3);
    const up = run([mouse('wheel', x, y, 'wheelUp')], { state: { top: { line: 10, sub: 0 }, cursor: 12 } });
    expect(up.s.top.line).toBe(7);
  });

  it('clicking on a thread anchor focuses the thread', () => {
    const t = thread('t1', anchor(3, 3, { startCol: 6, endCol: 11 }));
    const { geo } = makeFrame({ lines });
    const [x, y] = cell(geo, 2, 7);
    const { s } = run([mouse('press', x, y)], { threads: [t] });
    expect(s.focusId).toBe('t1');
    expect(s.mode).toBe('normal');
  });

  it('clicking an overlap of several threads opens a menu at once (on press)', () => {
    const ts = [thread('t1', anchor(3, 3, { startCol: 0, endCol: 11 })), thread('t2', anchor(3, 3, { startCol: 6, endCol: 20 }))];
    const { geo } = makeFrame({ lines });
    const [x, y] = cell(geo, 2, 8);
    const { s, geo: g } = run([mouse('press', x, y)], { threads: ts });
    expect(s.mode).toBe('menu');
    expect(s.menu.ids).toEqual(['t1', 't2']);
    // picking the second entry focuses it
    const r = menuRect(s.menu, g, 6);
    const f = makeFrame({ lines, threads: ts });
    const out = handleMouse(mouse('press', g.docX + r.col + 2, g.bodyY + r.row + 1), s, f.frame, f.ctx);
    expect(out.state.focusId).toBe('t2');
    expect(out.state.mode).toBe('normal');
    // a click elsewhere just closes it
    const out2 = handleMouse(mouse('press', 1, 1), s, f.frame, f.ctx);
    expect(out2.state.mode).toBe('normal');
    expect(out2.state.menu).toBeNull();
  });

  it('non-left buttons and releases are ignored', () => {
    const { geo } = makeFrame({ lines });
    const [x, y] = cell(geo, 2, 3);
    expect(run([mouse('press', x, y, 'right')]).s.cursor).toBe(0);
    expect(run([mouse('release', x, y)]).s.cursor).toBe(0);
  });
});

describe('mouse: panel, status bar and modes', () => {
  const t1 = thread('t1', anchor(4));
  const t2 = thread('t2', anchor(80));

  it('clicking a thread card focuses it and scrolls the document to its anchor', () => {
    const f = makeFrame({ lines, threads: [t1, t2] });
    const card = f.frame.panel.cards.find((c) => c.id === 't2');
    expect(card).toBeTruthy();
    const out = handleMouse(mouse('press', f.geo.panelX + 3, f.geo.bodyY + card.y0), f.s, f.frame, f.ctx);
    expect(out.state.focusId).toBe('t2');
    expect(out.state.cursor).toBe(79);
    expect(out.state.top.line).toBeGreaterThan(40);
  });

  it('the wheel over the panel scrolls it independently', () => {
    const f = makeFrame({ lines, threads: [t1, t2] });
    const out = handleMouse(mouse('wheel', f.geo.panelX + 3, f.geo.bodyY + 4, 'wheelDown'), f.s, f.frame, f.ctx);
    expect(out.state.top).toEqual(f.s.top); // the document did not move
    expect(out.state.panelScroll).not.toBeNull();
  });

  it('status bar buttons dispatch actions', () => {
    const f = makeFrame({ lines, statusButtons: [{ x0: 9, x1: 15, action: 'comment' }, { x0: 17, x1: 23, action: 'approve' }] });
    const out = handleMouse(mouse('press', 18, f.geo.statusY), f.s, f.frame, f.ctx);
    expect(out.effect).toEqual({ type: 'action', name: 'approve' });
    expect(handleMouse(mouse('press', 40, f.geo.statusY), f.s, f.frame, f.ctx).effect).toBeNull();
  });

  it('confirm mode only reacts to its buttons', () => {
    const f = makeFrame({ lines, state: { mode: 'confirm' }, statusButtons: [{ x0: 30, x1: 36, action: 'confirmYes' }] });
    expect(handleMouse(mouse('press', 31, f.geo.statusY), f.s, f.frame, f.ctx).effect).toEqual({ type: 'action', name: 'confirmYes' });
    const doc = handleMouse(mouse('press', 10, 5), f.s, f.frame, f.ctx);
    expect(doc.state).toBe(f.s);
  });

  it('input mode: clicks in the document are ignored, the box buttons work, and the wheel still scrolls underneath', () => {
    const f = makeFrame({ lines, threads: [t1, t2], state: { mode: 'input' } });
    f.frame.box = { y: 20, send: [50, 56], cancel: [57, 63] };
    expect(handleMouse(mouse('press', 10, 5), f.s, f.frame, f.ctx).state).toBe(f.s);
    expect(handleMouse(mouse('press', 52, 20), f.s, f.frame, f.ctx).effect).toEqual({ type: 'boxSend' });
    expect(handleMouse(mouse('press', 60, 20), f.s, f.frame, f.ctx).effect).toEqual({ type: 'boxCancel' });
    // wheel over the body scrolls it; the keyboard stays with the box (mode unchanged)
    const body = handleMouse(mouse('wheel', 10, 5, 'wheelDown'), f.s, f.frame, f.ctx);
    expect(body.state.top.line).toBe(3);
    expect(body.state.mode).toBe('input');
    // wheel over the panel scrolls the panel
    const panel = handleMouse(mouse('wheel', f.geo.panelX + 3, 6, 'wheelDown'), f.s, f.frame, f.ctx);
    expect(panel.state.panelScroll).not.toBeNull();
    expect(panel.state.mode).toBe('input');
  });

  it('help mode: a click closes it', () => {
    const f = makeFrame({ lines, state: { mode: 'help' } });
    expect(handleMouse(mouse('press', 5, 5), f.s, f.frame, f.ctx).effect).toEqual({ type: 'closeHelp' });
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Regression: clicks must land on the row that is drawn there. The geometry used for drawing and for hit-testing
// is the same object; these tests make sure the two stay in step across wrapping, scrolling and both layouts.
// ------------------------------------------------------------------------------------------------------------------
describe('click hit-testing matches what is drawn', () => {
  const longCjk = '一二三四五六七八九十'.repeat(6); // wraps into several rows at any width used here
  const content = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? `${i + 1}: ${longCjk}` : i % 7 === 0 ? `\t${i + 1}: tab and 中文 mixed with English words that wrap around the pane edge for sure ok` : `L${i + 1}`));

  function drawn(cols, rows, state = {}, threads = []) {
    const doc = new DocLayout(content);
    const view = buildThreadView(threads, content.length);
    const F = buildReviewFrame({ s: { ...initialState(), ...state }, doc, lines: content, info: classifyLines(content), view, meta: { kind: 'doc', status: 'in_review', currentRevision: 1 }, size: { columns: cols, rows } });
    return F;
  }

  // The number printed in the gutter of the nearest first row at or above screen row y.
  function lineShownAt(F, y) {
    const rowsText = F.docRows.map((r) => segsText(r));
    for (let i = y - F.geo.bodyY; i >= 0; i--) {
      const m = /^\s*(\d+)[▌ ]│/.exec(rowsText[i]);
      if (m) return Number(m[1]) - 1;
    }
    return -1;
  }

  for (const [cols, rows] of [[160, 45], [100, 24], [80, 30], [44, 14]]) {
    for (const top of [{ line: 0, sub: 0 }, { line: 4, sub: 2 }, { line: 17, sub: 1 }, { line: 40, sub: 0 }]) {
      it(`every drawn row ${cols}x${rows}, top ${top.line}.${top.sub}: clicking it selects the line shown there`, () => {
        const threads = cols < 110 ? [thread('t1', anchor(3))] : [thread('t1', anchor(3)), thread('t2', anchor(20))];
        const F = drawn(cols, rows, { top }, threads);
        const g = F.geo;
        let checked = 0;
        for (let y = g.bodyY; y < g.bodyY + g.bodyH; y++) {
          const expected = lineShownAt(F, y);
          if (expected < 0) continue; // a row of the line above the first fully shown one (scrolled mid-line)
          const rowText = segsText(F.docRows[y - g.bodyY]);
          if (rowText.startsWith('~')) continue;
          // click inside the text area of that screen row (first column of text)
          const frame = { geo: g, doc: F.doc, lines: content, view: F.view, layout: F.layout, panel: F.panel, box: null, statusButtons: [] };
          const out = handleMouse(mouse('press', F.gutterWidth, y), F.state, frame, F.ctx);
          expect(out.state.cursor, `row y=${y} shows line ${expected + 1}: ${rowText.slice(0, 30)}`).toBe(expected);
          checked++;
        }
        expect(checked).toBeGreaterThan(Math.min(6, g.bodyH - 3));
      });
    }
  }

  it('the 0-based cell of an SGR report (1-based on the wire) hits the same cell it was drawn on', () => {
    // decodeSgrMouse subtracts 1; the body starts on screen row 2 (header, rule), i.e. SGR row 3
    const F = drawn(160, 45);
    const y = F.geo.bodyY + 1; // second body row, 0-based
    const sgrRow = y + 1; // what the terminal sends
    expect(sgrRow - 1).toBe(y);
    const frame = { geo: F.geo, doc: F.doc, lines: content, view: F.view, layout: F.layout, panel: F.panel, box: null, statusButtons: [] };
    expect(handleMouse(mouse('press', F.gutterWidth, sgrRow - 1), F.state, frame, F.ctx).state.cursor).toBe(F.win.rows[1].line);
  });

  it('the header, the rules and the status row are not part of the document', () => {
    const F = drawn(160, 45);
    const frame = { geo: F.geo, doc: F.doc, lines: content, view: F.view, layout: F.layout, panel: F.panel, box: null, statusButtons: [] };
    for (const y of [0, 1, F.geo.bottomRuleY, F.geo.statusY]) {
      expect(handleMouse(mouse('press', 10, y), { ...F.state, cursor: 5 }, frame, F.ctx).state.cursor).toBe(5);
    }
  });
});
