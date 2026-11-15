import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { DocLayout } from '../../src/tui/lib/viewport.js';
import { renderDocRow, gutterWidthFor } from '../../src/tui/lib/rowRender.js';
import { classifyLines } from '../../src/tui/lib/markdown.js';
import { segsText, segsWidth } from '../../src/tui/lib/ansi.js';
import { spanOfAnchor, spanOfRange } from '../../src/tui/lib/selection.js';
import { COLOR } from '../../src/tui/lib/theme.js';

function setup(lines, width = 40) {
  const gutter = gutterWidthFor(lines.length);
  const doc = new DocLayout(lines).configure({ width, gutterWidth: gutter });
  const ctx = {
    lines,
    info: classifyLines(lines),
    numWidth: gutter - 3,
    textWidth: doc.textWidth,
    cursorLine: 0,
    covers: [],
    markers: new Map(),
  };
  return { doc, ctx, render: (line, sub = 0, inserts = []) => renderDocRow(doc.rows(line)[sub], ctx, inserts) };
}

describe('renderDocRow', () => {
  it('every row is exactly gutter + text width wide, also with CJK and wrapping', () => {
    const lines = ['plain', '', '迁移旧 store 的风险较低，因为只影响两个 slice，请再确认一遍是否有遗漏的地方。', 'tab\there'];
    const { doc, ctx, render } = setup(lines, 30);
    for (let i = 0; i < lines.length; i++) {
      for (let r = 0; r < doc.rowCount(i); r++) {
        expect(segsWidth(render(i, r))).toBe(doc.width);
      }
    }
    expect(ctx.textWidth).toBe(doc.textWidth);
  });

  it('draws the line number only on the first row, with the thread marker beside it', () => {
    const lines = ['一二三四五六七八九十一二三四五六七八九十'];
    const { render, ctx } = setup(lines, 20);
    ctx.markers.set(0, 'open');
    expect(segsText(render(0, 0)).startsWith('1▌│ ')).toBe(true);
    expect(segsText(render(0, 1)).startsWith(' ▌│ ')).toBe(true);
  });

  it('the cursor line number is inverse', () => {
    const { render, ctx } = setup(['a', 'b']);
    ctx.cursorLine = 1;
    expect(render(1)[0].style).toMatchObject({ inverse: true });
    expect(render(0)[0].style).toMatchObject({ dim: true });
  });

  it('applies anchor, overlap and selection backgrounds per character', () => {
    const { render, ctx } = setup(['abcdefghij']);
    ctx.covers = [
      { span: spanOfAnchor({ startLine: 1, endLine: 1, startCol: 2, endCol: 6 }), kind: 'anchor' },
      { span: spanOfAnchor({ startLine: 1, endLine: 1, startCol: 4, endCol: 8 }), kind: 'anchor' },
      { span: spanOfRange({ start: { line: 0, off: 9 }, end: { line: 0, off: 10 } }), kind: 'sel' },
    ];
    const segs = render(0);
    const by = (text) => segs.find((s) => s.text === text)?.style?.bg;
    expect(by('ab')).toBeUndefined();
    expect(by('cd')).toBe(COLOR.bgAnchor);
    expect(by('ef')).toBe(COLOR.bgOverlap);
    expect(by('gh')).toBe(COLOR.bgAnchor);
    expect(by('j')).toBe(COLOR.bgSelect);
  });

  it('whole-line coverage extends over the blank rest of the row', () => {
    const { render, ctx } = setup(['ab']);
    ctx.covers = [{ span: spanOfAnchor({ startLine: 1, endLine: 1, startCol: null, endCol: null }), kind: 'anchor' }];
    const segs = render(0);
    const body = segs[segs.length - 1]; // text and padding share one style, so they merge
    expect(body.style.bg).toBe(COLOR.bgAnchor);
    expect(body.text.trimEnd()).toBe('ab');
    expect(stringWidth(body.text)).toBe(40 - 4);
    expect(segsWidth(segs)).toBe(40);
  });

  it('a focused anchor is drawn brighter', () => {
    const { render, ctx } = setup(['abc']);
    ctx.covers = [{ span: spanOfAnchor({ startLine: 1, endLine: 1, startCol: 0, endCol: 3 }), kind: 'anchor', focused: true }];
    expect(render(0).find((s) => s.text.startsWith('abc')).style.bg).toBe(COLOR.bgFocus);
  });

  it('inserts replace cells; a double-width cell cut by the insert leaves blanks, never half a glyph', () => {
    const { render } = setup(['一二三四五六']); // each CJK char is 2 columns
    const segs = render(0, 0, [{ col: 3, width: 4, text: 'XXXX', style: null }]);
    const text = segsText(segs).slice(4); // drop the gutter (1 digit + marker + rule + space)
    expect(stringWidth(text)).toBe(40 - 4);
        expect(text).not.toContain('二');
    expect(text.startsWith('一 XXXX 五六')).toBe(true); // 四 (cols 6-7) is cut at col 6 too
  });

  it('a mask insert blanks everything from its column on', () => {
    const { render } = setup(['hello world, this is long']);
    const segs = render(0, 0, [{ col: 5, width: 30, text: ' '.repeat(30), style: null }]);
    expect(segsText(segs).slice(4).trimEnd()).toBe('hello');
  });

  it('styles Markdown: heading bold, code dim, inline code coloured', () => {
    const { render } = setup(['# Title', '```', 'code', '```', 'see `x` ok']);
    expect(render(0).find((s) => s.text === '# Title').style).toMatchObject({ bold: true });
    expect(render(2).find((s) => s.text === 'code').style).toMatchObject({ dim: true });
    const inline = render(4).find((s) => s.text === '`x`');
    expect(inline.style).toHaveProperty('fg');
  });

  it('control characters never reach the output', () => {
    const { render } = setup(['a\x1b[31mb']);
    expect(segsText(render(0))).not.toContain('\x1b');
  });
});
