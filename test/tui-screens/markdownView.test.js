// The rendered / source document views and the places where display offsets meet source offsets:
// drawing, highlights, the cursor, selections, clicks, the comment box position, and switching views.
import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { buildReviewFrame } from '../../src/tui/lib/reviewFrame.js';
import { DocLayout } from '../../src/tui/lib/viewport.js';
import { buildThreadView } from '../../src/tui/lib/threadView.js';
import { initialState } from '../../src/tui/lib/reviewNav.js';
import * as nav from '../../src/tui/lib/reviewNav.js';
import { handleMouse } from '../../src/tui/lib/reviewMouse.js';
import { createDocViews, isMarkdownReview, makeSourceView, makeRenderedView, viewCovers } from '../../src/tui/lib/docView.js';
import { classifyLines, cellStyle, inlineCodeSpans } from '../../src/tui/lib/markdown.js';
import { spanOfAnchor } from '../../src/tui/lib/selection.js';
import { segsText } from '../../src/tui/lib/ansi.js';
import { locate } from '../../src/tui/mouse/layout.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { COLOR } from '../../src/tui/lib/theme.js';
import { thread, anchor, mouse } from './harness.js';

const SRC = [
  '# 周报 **总览**', // 1
  '', // 2
  '这是**加粗文字**和*斜体*，还有 `代码` 与 [链接](https://example.com/x)。', // 3
  '- 第一项', // 4
  '  - 嵌套', // 5
  '', // 6
  '| 名称 | 说明 |', // 7
  '|---|---|', // 8
  '| 苹果 | 水果，**红色** |', // 9
  '| banana | yellow |', // 10
  '', // 11
  '```js', // 12
  'const x = **raw**;', // 13
  '```', // 14
  '尾行', // 15
];
const content = SRC.join('\n');
const meta = { kind: 'doc', status: 'in_review', currentRevision: 1 };
const SIZE = { columns: 160, rows: 40 };

function frame({ md = 'rendered', state = {}, threads = [], size = SIZE, src = SRC } = {}) {
  const views = createDocViews(src, { markdown: true });
  const doc = new DocLayout(src);
  const view = buildThreadView(threads, src.length);
  const s = { ...initialState({ md }), ...state };
  const F = buildReviewFrame({ s, doc, views, view, meta, size });
  return { F, views, doc, view, s: F.state, ctx: F.ctx, rows: F.docRows.map(segsText) };
}

/** Terminal cell of display offset `d` of `line`. */
const cellOf = (F, line, d) => {
  const loc = locate(F.layout, line, d);
  return { x: loc.col, y: F.geo.bodyY + loc.row };
};

describe('isMarkdownReview', () => {
  it('plans and .md / .markdown / .mdx documents', () => {
    expect(isMarkdownReview({ kind: 'plan' })).toBe(true);
    expect(isMarkdownReview({ kind: 'doc', docPath: '/x/Notes.MD' })).toBe(true);
    expect(isMarkdownReview({ kind: 'doc', docPath: '/x/a.markdown' })).toBe(true);
    expect(isMarkdownReview({ kind: 'doc', docPath: '/x/a.mdx' })).toBe(true);
    expect(isMarkdownReview({ kind: 'doc', docPath: '/x/a.txt' })).toBe(false);
    expect(isMarkdownReview({ kind: 'doc', docPath: '/x/md' })).toBe(false);
    expect(isMarkdownReview({ kind: 'doc' })).toBe(false);
    expect(isMarkdownReview(null)).toBe(false);
  });
});

describe('document views', () => {
  it('the source view is the identity and styles cells like the Markdown classifier', () => {
    const v = makeSourceView(SRC);
    expect(v.lines).toBe(SRC);
    expect(v.toSrc(2, 7)).toBe(7);
    expect(v.toDisp(2, 7)).toBe(7);
    expect(v.synthetic(2, 7)).toBe(false);
    expect(v.rowStyle(12)).toBeNull();
    const info = classifyLines(SRC);
    const style = v.styler(2);
    const code = inlineCodeSpans(SRC[2]);
    for (let o = 0; o < SRC[2].length; o++) expect(style(o)).toBe(cellStyle(info[2], o, code));
    expect(v.styler(0)(0)).toMatchObject({ bold: true }); // heading
    expect(v.styler(12)(0)).toMatchObject({ dim: true }); // code line
  });

  it('createDocViews: non-Markdown documents only have the source view', () => {
    const v = createDocViews(SRC, { markdown: false });
    expect(v.markdown).toBe(false);
    expect(v.pick('rendered', 80)).toBe(v.source);
    expect(v.rendered(80)).toBe(v.source);
  });

  it('rendered views are cached by content and width', () => {
    const a = createDocViews([...SRC], { markdown: true });
    const b = createDocViews([...SRC], { markdown: true }); // same content, new array
    expect(a.rendered(70)).toBe(b.rendered(70));
    expect(a.rendered(70)).not.toBe(a.rendered(71));
    expect(createDocViews(['other'], { markdown: true }).rendered(70)).not.toBe(a.rendered(70));
    expect(a.pick('source', 70)).toBe(a.source);
    expect(a.pick('rendered', 70).kind).toBe('rendered');
  });

  it('viewCovers: a source span over display characters, hidden markers and all', () => {
    const v = makeRenderedView(['x **bold** y'], { maxWidth: 40 });
    const span = spanOfAnchor({ startLine: 1, endLine: 1, startCol: 2, endCol: 10 }); // **bold**
    expect(viewCovers(v, span, 0, 1)).toBe(false); // the space after x
    expect(viewCovers(v, span, 0, 2)).toBe(true); // b
    expect(viewCovers(v, span, 0, 5)).toBe(true); // d
    expect(viewCovers(v, span, 0, 6)).toBe(false);
    const whole = spanOfAnchor({ startLine: 1, endLine: 1, startCol: null, endCol: null });
    expect(viewCovers(v, whole, 0, 7)).toBe(true);
  });
});

describe('drawing', () => {
  it('rendered: no markers on screen, the line numbers stay the source lines', () => {
    const { rows } = frame();
    const text = rows.filter((_, i) => i !== 12).join('\n'); // line 13 is inside the code block: shown verbatim
    expect(rows[0]).toMatch(/^ 1 │ 周报 总览/);
    expect(text).not.toContain('# 周报');
    expect(text).not.toContain('**');
    expect(text).not.toContain('](');
    expect(rows[2]).toContain('这是加粗文字和斜体，还有 代码 与 链接。');
    expect(rows[3]).toContain('• 第一项');
    expect(rows[4]).toContain('◦ 嵌套');
    expect(rows[6]).toContain('│ 名称   │ 说明       │');
    expect(rows[7]).toContain('├────────┼────────────┤');
    expect(rows[11]).toContain(' js');
    expect(rows[12]).toContain('const x = **raw**;');
    // 15 source lines, 15 numbered rows (each fits on one row here)
    for (let i = 0; i < SRC.length; i++) expect(rows[i].trimStart().startsWith(String(i + 1))).toBe(true);
  });

  it('source: the lines verbatim, exactly like before', () => {
    const { rows } = frame({ md: 'source' });
    expect(rows[0]).toContain('# 周报 **总览**');
    expect(rows[3]).toContain('- 第一项');
    expect(rows[6]).toContain('| 名称 | 说明 |');
    expect(rows[11]).toContain('```js');
    expect(rows[8]).toContain('| 苹果 | 水果，**红色** |');
  });

  it('source mode through views and through the legacy lines + info arguments draw the same rows', () => {
    const doc = new DocLayout(SRC);
    const view = buildThreadView([thread('t1', anchor(3, 3, { startCol: 4, endCol: 12 }))], SRC.length);
    const common = { s: initialState({ md: 'source' }), doc, view, meta, size: SIZE };
    const a = buildReviewFrame({ ...common, views: createDocViews(SRC, { markdown: true }) });
    const b = buildReviewFrame({ ...common, doc: new DocLayout(SRC), lines: SRC, info: classifyLines(SRC) });
    expect(a.docRows).toEqual(b.docRows);
  });

  it('non-Markdown documents ignore the rendered mode', () => {
    const views = createDocViews(SRC, { markdown: false });
    const F = buildReviewFrame({ s: initialState({ md: 'rendered' }), doc: new DocLayout(SRC), views, view: buildThreadView([], SRC.length), meta, size: SIZE });
    expect(segsText(F.docRows[0])).toContain('# 周报 **总览**');
    expect(F.dv.kind).toBe('source');
  });

  it('a code block fills the whole row with its background', () => {
    const { F } = frame();
    const row = F.docRows[12]; // the code line
    const last = row[row.length - 1];
    expect(last.style).toMatchObject({ bg: COLOR.bgCode });
    expect(segsText(row).length).toBeGreaterThan(40);
    expect(F.docRows[13][F.docRows[13].length - 1].style).toMatchObject({ bg: COLOR.bgCode }); // closing fence row
  });

  it('rendered text wraps at the pane width and never changes the number of lines', () => {
    const long = ['# Head', `${'很长的一行'.repeat(20)} **bold**`, 'end'];
    const { F, rows } = frame({ src: long, size: { columns: 60, rows: 20 } });
    expect(F.dv.lines).toHaveLength(3);
    expect(rows.filter((r) => /^\d/.test(r.trimStart()))).toHaveLength(3);
    expect(rows.filter((r) => /^ +│/.test(r)).length).toBeGreaterThan(0); // continuation rows
  });
});

describe('highlights: source anchors on display characters', () => {
  const styleAtCol = (segs, col) => {
    let c = 0;
    for (const sg of segs) {
      for (const ch of sg.text) {
        const w = stringWidth(ch);
        if (col >= c && col < c + w) return sg.style;
        c += w;
      }
    }
    return null;
  };
  /** Background drawn behind the display character `d` of `line`. */
  const bgOf = (F, line, d) => {
    const loc = locate(F.layout, line, d);
    return styleAtCol(F.docRows[loc.row], loc.col)?.bg ?? null;
  };

  it('an anchor over **加粗文字** (markers included) highlights exactly the displayed characters', () => {
    const start = SRC[2].indexOf('**加粗');
    const end = SRC[2].indexOf('和*斜体');
    const t = thread('t1', anchor(3, 3, { startCol: start, endCol: end }));
    const { F } = frame({ threads: [t] });
    const line = F.dv.lines[2];
    const on = [];
    for (let d = 0; d < line.length; d++) if (bgOf(F, 2, d) === COLOR.bgAnchor) on.push(line[d]);
    expect(on.join('')).toBe('加粗文字');
  });

  it('an anchor on the displayed characters only (quote 加粗) highlights those', () => {
    const start = SRC[2].indexOf('加粗');
    const t = thread('t1', anchor(3, 3, { startCol: start, endCol: start + 2 }));
    const { F } = frame({ threads: [t] });
    const line = F.dv.lines[2];
    const on = [];
    for (let d = 0; d < line.length; d++) if (bgOf(F, 2, d) === COLOR.bgAnchor) on.push(line[d]);
    expect(on.join('')).toBe('加粗');
  });

  it('a whole-line anchor covers the whole row, including the blank rest', () => {
    const { F } = frame({ threads: [thread('t1', anchor(1))] });
    const row = F.docRows[0];
    expect(row[row.length - 1].style).toMatchObject({ bg: COLOR.bgAnchor });
  });

  it('the padding inside a table row is highlighted when both neighbours are, and not otherwise', () => {
    // line 9: "| 苹果 | 水果，**红色** |": from "苹果" through the inner pipe up to "水"
    const from = SRC[8].indexOf('苹果');
    const bar = SRC[8].indexOf('|', 3);
    const t = thread('t1', anchor(9, 9, { startCol: from, endCol: bar + 1 }));
    const { F } = frame({ threads: [t] });
    const line = F.dv.lines[8];
    const d0 = line.indexOf('苹');
    const d1 = line.indexOf('│', d0);
    const pad = d0 + 2; // first column after 果
    expect(F.dv.synthetic(8, pad)).toBe(true);
    expect(bgOf(F, 8, pad)).toBe(COLOR.bgAnchor);
    expect(bgOf(F, 8, d1)).toBe(COLOR.bgAnchor);
    // an anchor that stops at 果: the padding after it is not highlighted
    const t2 = thread('t2', anchor(9, 9, { startCol: from, endCol: from + 2 }));
    const { F: F2 } = frame({ threads: [t2] });
    expect(bgOf(F2, 8, d0 + 1)).toBe(COLOR.bgAnchor);
    expect(bgOf(F2, 8, pad)).toBeNull();
  });

  it('the character selection (v) is drawn on the characters that were moved over', () => {
    const d0 = frame().F.dv.lines[2].indexOf('加');
    const { F } = frame({ state: { cursor: 2, col: d0 + 1, mode: 'visual', visual: { kind: 'char', anchor: { line: 2, off: d0 } } } });
    const line = F.dv.lines[2];
    const on = [];
    for (let d = 0; d < line.length; d++) if (bgOf(F, 2, d) === COLOR.bgSelect) on.push(line[d]);
    expect(on.join('')).toBe('加粗');
  });
});

describe('selection: display characters -> source anchor', () => {
  const sel = (md, line, from, to) => {
    const { F, views } = frame({ md });
    const dv = views.pick(md, F.doc.textWidth);
    const d0 = dv.lines[line].indexOf(from);
    const s = { ...initialState({ md }), cursor: line, col: d0 + [...from].length * 0, visual: { kind: 'char', anchor: { line, off: d0 } } };
    const d1 = dv.lines[line].indexOf(to) + to.length - 1;
    return nav.selectionToSel({ ...s, col: d1, mode: 'visual' }, dv);
  };

  it('selecting the displayed text of **加粗文字** gives the source offsets of the text, quote without markers', () => {
    const s = sel('rendered', 2, '加粗文字', '加粗文字');
    expect(s).toEqual({ startLine: 3, endLine: 3, startCol: SRC[2].indexOf('加粗文字'), endCol: SRC[2].indexOf('加粗文字') + 4 });
    const a = makeAnchor(content, s, 1);
    expect(a.quote).toBe('加粗文字');
  });

  it('a selection that spans hidden markers includes them in the quote', () => {
    const s = sel('rendered', 2, '粗文字和斜', '粗文字和斜');
    const a = makeAnchor(content, s, 1);
    expect(a.quote).toBe('粗文字**和*斜');
  });

  it('in source mode nothing changes', () => {
    const s = sel('source', 2, '**加粗', '**加粗');
    expect(s.startCol).toBe(SRC[2].indexOf('**加粗'));
    expect(makeAnchor(content, s, 1).quote).toBe('**加粗');
  });

  it('a selection that starts or ends on table padding keeps only real characters', () => {
    const { F, views } = frame();
    const dv = views.pick('rendered', F.doc.textWidth);
    const line = dv.lines[8];
    const d0 = line.indexOf('苹');
    const pad = d0 + 2; // padding after 苹果
    const s1 = nav.selectionToSel({ ...initialState(), cursor: 8, col: line.indexOf('水'), mode: 'visual', visual: { kind: 'char', anchor: { line: 8, off: pad } } }, dv);
    expect(makeAnchor(content, s1, 1).quote).toBe('| 水'); // starts at the inner pipe (first real character after the padding)
    const s2 = nav.selectionToSel({ ...initialState(), cursor: 8, col: pad + 1, mode: 'visual', visual: { kind: 'char', anchor: { line: 8, off: d0 } } }, dv);
    expect(makeAnchor(content, s2, 1).quote).toBe('苹果'); // ends in padding: up to the last real character
  });

  it('a selection of padding only falls back to the cursor line', () => {
    const { F, views } = frame();
    const dv = views.pick('rendered', F.doc.textWidth);
    const pad = dv.lines[8].indexOf('苹') + 2;
    const s = nav.selectionToSel({ ...initialState(), cursor: 8, col: pad + 1, mode: 'visual', visual: { kind: 'char', anchor: { line: 8, off: pad } } }, dv);
    expect(s).toEqual({ startLine: 9, endLine: 9 });
  });

  it('V selects whole lines and a plain c the cursor line, in any view', () => {
    const { F, views } = frame();
    const dv = views.pick('rendered', F.doc.textWidth);
    expect(nav.selectionToSel({ ...initialState(), cursor: 3, visual: { kind: 'line', anchor: { line: 2, off: 0 } } }, dv)).toEqual({ startLine: 3, endLine: 4 });
    expect(nav.selectionToSel({ ...initialState(), cursor: 3 }, dv)).toEqual({ startLine: 4, endLine: 4 });
  });

  it('selectionToSel and visualSpan still take plain line arrays (the source view)', () => {
    const st = { ...initialState(), cursor: 0, col: 3, visual: { kind: 'char', anchor: { line: 0, off: 0 } } };
    expect(nav.selectionToSel(st, ['hello world'])).toEqual({ startLine: 1, endLine: 1, startCol: 0, endCol: 4 });
    expect(nav.visualSpan(st, ['hello world'])).toEqual({ l0: 0, l1: 0, c0: 0, c1: 4 });
  });
});

describe('cursor and anchors', () => {
  it('h / l move over display characters: the hidden ** are never cursor positions', () => {
    const { F } = frame();
    const line = F.dv.lines[2];
    let st = { ...F.state, cursor: 2, col: line.indexOf('这是') + 1 }; // 是
    st = nav.moveColumn(st, F.ctx, 'right');
    expect(line[st.col]).toBe('加');
    st = nav.moveColumn(st, F.ctx, 'left');
    expect(line[st.col]).toBe('是');
    expect(F.dv.toSrc(2, st.col)).toBe(SRC[2].indexOf('是'));
  });

  it('a heading starts at its first visible character; $ lands on the last one', () => {
    const { F } = frame();
    let st = nav.setCursor(F.state, F.ctx, 0);
    expect(F.dv.lines[0][st.col]).toBe('周');
    st = nav.moveColumn(st, F.ctx, 'lineEnd');
    expect(F.dv.lines[0][st.col]).toBe('览');
  });

  it('jumpToThread puts the cursor on the display character of the anchor start (a source offset)', () => {
    const start = SRC[2].indexOf('**加粗');
    const t = thread('t1', anchor(3, 3, { startCol: start, endCol: start + 8 }));
    const { F } = frame({ threads: [t] });
    const st = nav.jumpToThread(F.state, F.ctx, t);
    expect(st.cursor).toBe(2);
    expect(F.dv.lines[2][st.col]).toBe('加'); // the hidden ** are skipped
    expect(st.focusId).toBe('t1');
  });

  it('jumpToThread in source mode still uses the source column', () => {
    const start = SRC[2].indexOf('**加粗');
    const t = thread('t1', anchor(3, 3, { startCol: start, endCol: start + 8 }));
    const { F } = frame({ md: 'source', threads: [t] });
    expect(nav.jumpToThread(F.state, F.ctx, t).col).toBe(start);
  });
});

describe('mouse', () => {
  const click = (fr, line, d, extra = {}) => {
    const { x, y } = cellOf(fr.F, line, d);
    const f = { ...fr.F, box: null, statusButtons: [] };
    return handleMouse(mouse('press', x, y), fr.F.state, f, fr.F.ctx, extra);
  };

  it('a click puts the cursor on the display character; the source offset behind it skips hidden markers', () => {
    const fr = frame();
    const d = fr.F.dv.lines[2].indexOf('加');
    const out = click(fr, 2, d);
    expect(out.state.cursor).toBe(2);
    expect(out.state.col).toBe(d);
    expect(fr.F.dv.toSrc(2, out.state.col)).toBe(SRC[2].indexOf('加粗文字'));
  });

  it('a click on a table border / padding lands on a real neighbour', () => {
    const fr = frame();
    const line = fr.F.dv.lines[8];
    const pad = line.indexOf('苹') + 2;
    const out = click(fr, 8, pad);
    expect(out.state.col).toBe(pad);
    expect(fr.F.dv.synthetic(8, out.state.col)).toBe(true);
    expect(fr.F.dv.toSrc(8, out.state.col)).toBe(SRC[8].indexOf('果')); // nearest real character
  });

  it('a click on a character covered by two source anchors opens the picker; with one it focuses that thread', () => {
    const s1 = SRC[2].indexOf('**加粗');
    const e1 = SRC[2].indexOf('和*斜体');
    const t1 = thread('t1', anchor(3, 3, { startCol: s1, endCol: e1 }));
    const t2 = thread('t2', anchor(3, 3, { startCol: SRC[2].indexOf('粗文'), endCol: SRC[2].indexOf('粗文') + 2 }));
    const fr = frame({ threads: [t1, t2] });
    const line = fr.F.dv.lines[2];
    const both = click(fr, 2, line.indexOf('粗'));
    expect(both.state.mode).toBe('menu');
    expect(both.state.menu.ids.sort()).toEqual(['t1', 't2']);
    const one = click(fr, 2, line.indexOf('加'));
    expect(one.state.mode).toBe('normal');
    expect(one.state.focusId).toBe('t1');
    const none = click(fr, 2, line.indexOf('斜')); // on the thread line, but outside both anchors: no picker, the line's first thread is focused
    expect(none.state.mode).toBe('normal');
  });

  it('an end-of-line click does not break hidden-marker lines', () => {
    const fr = frame();
    const out = click(fr, 0, fr.F.dv.lines[0].length + 3);
    expect(out.state.cursor).toBe(0);
    expect(fr.F.dv.lines[0][out.state.col]).toBe('览');
  });
});

describe('the comment box next to a rendered selection', () => {
  it('sits under the row the selection is drawn on, left aligned with its first character', () => {
    // a long line that wraps when rendered: the selection is on the second row
    const long = ['# T', `${'一二三四五六七八九十'.repeat(8)}**末尾加粗**后面`, 'z'];
    const startCol = long[1].indexOf('末尾');
    const sel = { startLine: 2, endLine: 2, startCol, endCol: startCol + 2 };
    const fr = frame({ src: long, size: { columns: 160, rows: 30 }, state: { mode: 'input', input: { kind: 'comment', sel, text: '' } } });
    const { F } = fr;
    const d = F.dv.toDisp(1, startCol);
    const loc = locate(F.layout, 1, d);
    expect(loc.row).toBeGreaterThan(F.win.rowOf(1)); // wrapped
    expect(F.boxRect.y).toBe(F.geo.bodyY + loc.row + 1);
    expect(F.boxRect.x).toBeLessThanOrEqual(loc.col);
  });
});

describe('switching views (M) and any other change of the view', () => {
  it('the cursor stays on the same source character both ways', () => {
    const { F, views } = frame();
    const rendered = F.dv;
    const source = views.pick('source', F.doc.textWidth);
    const st = { ...F.state, cursor: 2, col: rendered.lines[2].indexOf('粗') };
    const toSource = nav.convertOffsets(st, rendered, source);
    expect(toSource.col).toBe(SRC[2].indexOf('粗'));
    const back = nav.convertOffsets(toSource, source, rendered);
    expect(back.col).toBe(st.col);
  });

  it('a cursor on a hidden marker (source mode) moves to the next visible character', () => {
    const { F, views } = frame({ md: 'source' });
    const rendered = views.pick('rendered', F.doc.textWidth);
    const st = { ...F.state, cursor: 2, col: SRC[2].indexOf('**加粗') };
    const out = nav.convertOffsets(st, F.dv, rendered);
    expect(rendered.lines[2][out.col]).toBe('加');
  });

  it('the Visual anchor is converted too, and the goal column follows ($ stays at the line end)', () => {
    const { F, views } = frame();
    const rendered = F.dv;
    const source = views.pick('source', F.doc.textWidth);
    const a = rendered.lines[2].indexOf('加');
    const st = { ...F.state, cursor: 2, col: a + 3, goalCol: 5, mode: 'visual', visual: { kind: 'char', anchor: { line: 2, off: a } } };
    const out = nav.convertOffsets(st, rendered, source);
    expect(out.visual.anchor).toEqual({ line: 2, off: SRC[2].indexOf('加') });
    expect(out.col).toBe(SRC[2].indexOf('加') + 3);
    expect(out.visual.kind).toBe('char');
    expect(nav.convertOffsets({ ...st, goalCol: Infinity }, rendered, source).goalCol).toBe(Infinity);
  });

  it('source <-> source and an unknown previous view leave the state alone', () => {
    const { F } = frame({ md: 'source' });
    expect(nav.convertOffsets(F.state, F.dv, makeSourceView(SRC))).toBe(F.state);
    expect(nav.convertOffsets(F.state, undefined, F.dv)).toBe(F.state);
  });

  it('the frame converts the offsets when the view under them changes (M, a resize, a new revision)', () => {
    const doc = new DocLayout(SRC);
    const views = createDocViews(SRC, { markdown: true });
    const view = buildThreadView([], SRC.length);
    const run = (s, size = SIZE) => buildReviewFrame({ s, doc, views, view, meta, size });
    const f1 = run(initialState({ md: 'rendered' }));
    const d = f1.dv.lines[2].indexOf('粗');
    const at = { ...f1.state, cursor: 2, col: d };
    // M: only the mode is flipped; the frame carries the cursor over to the source character
    const f2 = run(nav.switchView(at, 'source', null));
    expect(f2.dv.kind).toBe('source');
    expect(f2.state.col).toBe(SRC[2].indexOf('粗'));
    expect(f2.state.offView).toBe(f2.dv);
    const f3 = run(nav.switchView(f2.state, 'rendered', null));
    expect(f3.state.col).toBe(d);
    // a narrower pane renders the table without padding: a cursor on the table keeps pointing at the same source character
    const tableAt = { ...f3.state, cursor: 8, col: f3.dv.lines[8].indexOf('红') };
    const wide = run(tableAt);
    const srcOff = wide.dv.toSrc(8, wide.state.col);
    const narrow = run(wide.state, { columns: 44, rows: 20 });
    expect(narrow.dv).not.toBe(wide.dv);
    expect(narrow.dv.toSrc(8, narrow.state.col)).toBe(srcOff);
  });

  it('the frame puts the cursor line back on the screen row it had (keepRow)', () => {
    // scrolled so that line 40 of 80 is at row 7 in source mode; after the switch it is still at row 7
    const src = Array.from({ length: 80 }, (_, i) => (i % 3 === 0 ? `## Section ${i} with **bold** and a fairly long line that wraps in a narrow pane for sure ok ok ok` : `line ${i}`));
    const base = frame({ src, md: 'source', size: { columns: 60, rows: 24 } });
    const doc = base.doc;
    const views = base.views;
    let s = nav.setCursor(base.s, base.ctx, 40);
    s = { ...s, top: doc.advance({ line: 40, sub: 0 }, -7) };
    const before = buildReviewFrame({ s, doc, views, view: base.view, meta, size: { columns: 60, rows: 24 } });
    expect(before.win.rowOf(40)).toBe(7);
    const switched = nav.switchView(before.state, 'rendered', before.win.rowOf(40));
    const after = buildReviewFrame({ s: switched, doc, views, view: base.view, meta, size: { columns: 60, rows: 24 } });
    expect(after.dv.kind).toBe('rendered');
    expect(after.win.rowOf(40)).toBe(7);
    expect(after.state.keepRow).toBeNull();
  });
});

describe('robustness', () => {
  it('an empty document and one-line documents', () => {
    for (const src of [[''], ['# x'], ['---']]) {
      const { F } = frame({ src });
      expect(F.docRows.length).toBeGreaterThan(0);
    }
  });

  it('the cursor column is clamped when the content (and so the display text) changes under it', () => {
    const long = ['abcdefghij **bold**', 'x'];
    const { F } = frame({ src: long, state: { cursor: 0, col: 15 } });
    const shorter = frame({ src: ['abc'], state: { cursor: 0, col: 15 } });
    expect(F.state.col).toBe(14); // the last display character: the hidden ** are not cursor positions
    expect(shorter.F.state.col).toBeLessThanOrEqual(2);
  });
});
