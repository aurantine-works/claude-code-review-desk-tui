import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import { renderMarkdown } from '../../src/tui/lib/mdRender.js';
import { buildLayout } from '../../src/tui/mouse/layout.js';
import { COLOR } from '../../src/tui/lib/theme.js';

const render = (lines, maxWidth = 80) => renderMarkdown(lines, { maxWidth });
const text = (lines, maxWidth) => render(lines, maxWidth).lines;
const one = (line, maxWidth) => text([line], maxWidth)[0];

/** Style of the display character at `at` (a substring of the display line). */
const styleOfText = (r, line, needle) => r.styleAt(line, r.lines[line].indexOf(needle));

describe('renderMarkdown: one source line = one display line', () => {
  it('never adds or removes lines', () => {
    const src = ['# T', '', '```js', 'x', '```', 'a', '===', '| a |', '|---|', '| b |', '---', '- x', '> q'];
    expect(render(src).lines).toHaveLength(src.length);
    expect(render([]).lines).toEqual([]);
    expect(render(['']).lines).toEqual(['']);
  });
});

describe('headings', () => {
  it('hides the # marks and the space after them, and the closing sequence', () => {
    expect(one('# Title')).toBe('Title');
    expect(one('###### Six')).toBe('Six');
    expect(one('## Title ##')).toBe('Title');
    expect(one('   ### Indented')).toBe('Indented');
    expect(one('#')).toBe('');
  });

  it('is not a heading without the space, or beyond six marks', () => {
    expect(one('#hashtag')).toBe('#hashtag');
    expect(one('####### seven')).toBe('####### seven');
  });

  it('colours by level; h1 is bold + underlined, h2 bold', () => {
    const r = render(['# One', '## Two', '### Three']);
    expect(r.styleAt(0, 0)).toMatchObject({ bold: true, underline: true, fg: COLOR.accent });
    expect(r.styleAt(1, 0)).toMatchObject({ bold: true, fg: COLOR.blue });
    expect(r.styleAt(1, 0).underline).toBeUndefined();
    expect(r.styleAt(2, 0)).toMatchObject({ bold: true, fg: COLOR.purple });
  });

  it('renders inline markup inside a heading', () => {
    const r = render(['## A **b** `c`']);
    expect(r.lines[0]).toBe('A b c');
    expect(r.styleAt(0, 2)).toMatchObject({ bold: true }); // b: heading style + strong
  });

  it('setext headings: the text line is the heading and the underline is drawn as a rule', () => {
    const r = render(['Title', '=====', '', 'Sub', '---']);
    expect(r.lines[0]).toBe('Title');
    expect(r.lines[1]).toMatch(/^═+$/);
    expect(r.lines[3]).toBe('Sub');
    expect(r.lines[4]).toMatch(/^─+$/);
    expect(r.styleAt(0, 0)).toMatchObject({ bold: true, underline: true });
  });

  it('a --- after a blank line is a rule, not a setext underline; a *** line is a rule too', () => {
    const r = render(['text', '', '---', '***'], 20);
    expect(r.lines[2]).toBe('─'.repeat(20));
    expect(r.lines[3]).toBe('─'.repeat(20));
    expect(r.lines[0]).toBe('text');
  });

  it('a --- directly below a list item or a quote stays a rule', () => {
    expect(text(['- item', '---'], 10)[1]).toBe('─'.repeat(10));
    expect(text(['> quote', '---'], 10)[1]).toBe('─'.repeat(10));
  });
});

describe('inline markup', () => {
  it('bold, italic, bold-italic, strikethrough', () => {
    const r = render(['**b** __b2__ *i* _i2_ ***bi*** ~~s~~']);
    expect(r.lines[0]).toBe('b b2 i i2 bi s');
    expect(styleOfText(r, 0, 'b ')).toMatchObject({ bold: true });
    expect(styleOfText(r, 0, 'b2')).toMatchObject({ bold: true });
    expect(styleOfText(r, 0, 'i ')).toMatchObject({ italic: true });
    expect(styleOfText(r, 0, 'i2')).toMatchObject({ italic: true });
    expect(styleOfText(r, 0, 'bi')).toMatchObject({ bold: true, italic: true });
    expect(styleOfText(r, 0, 's')).toMatchObject({ strike: true });
  });

  it('nested emphasis', () => {
    const r = render(['**bold *it* bold** and *a **b** a*']);
    expect(r.lines[0]).toBe('bold it bold and a b a');
    expect(styleOfText(r, 0, 'it')).toMatchObject({ bold: true, italic: true });
    expect(styleOfText(r, 0, 'bold ')).toMatchObject({ bold: true });
    expect(styleOfText(r, 0, 'bold ').italic).toBeUndefined();
    const b = r.lines[0].lastIndexOf('b');
    expect(r.styleAt(0, b - 2)).toMatchObject({ italic: true }); // "a" before the inner strong
    expect(r.styleAt(0, b)).toMatchObject({ bold: true, italic: true });
  });

  it('inline code in any backtick length: hidden ticks, no parsing inside, one padding space dropped', () => {
    const r = render(['`a **b**` and ``x`y`` and ` pad `']);
    expect(r.lines[0]).toBe('a **b** and x`y and pad');
    expect(styleOfText(r, 0, 'a **b**')).toMatchObject({ fg: COLOR.accent });
    expect(styleOfText(r, 0, '**b**')).toMatchObject({ fg: COLOR.accent });
    expect(styleOfText(r, 0, ' and')).toBeNull();
  });

  it('intra-word underscores are no emphasis; spaced stars are no emphasis', () => {
    expect(one('snake_case_name')).toBe('snake_case_name');
    expect(one('5 * 3 * 2')).toBe('5 * 3 * 2');
    expect(one('2 ** 3 ** 4')).toBe('2 ** 3 ** 4');
  });

  it('unmatched markers stay visible and emphasis never spans lines', () => {
    const r = render(['**unclosed and *also and `tick', 'next **line**']);
    expect(r.lines[0]).toBe('**unclosed and *also and `tick');
    expect(r.lines[1]).toBe('next line');
    expect(r.styleAt(0, 4)).toBeNull();
  });

  it('backslash escapes hide the backslash and keep the character literal', () => {
    expect(one('\\*not em\\* and \\_x\\_ \\# \\`')).toBe('*not em* and _x_ # `');
    expect(one('C:\\Users\\me')).toBe('C:\\Users\\me'); // \U is not an escape
    expect(one('\\\\ backslash')).toBe('\\ backslash');
  });

  it('links show the text (underlined, accent) and hide the target', () => {
    const r = render(['see [the docs](https://example.com/a(b)) now', '[ref one][ref] [two][]']);
    expect(r.lines[0]).toBe('see the docs now');
    expect(styleOfText(r, 0, 'the docs')).toMatchObject({ underline: true, fg: COLOR.accent });
    expect(styleOfText(r, 0, ' now')).toBeNull();
    expect(r.lines[1]).toBe('ref one two');
    expect(styleOfText(r, 1, 'ref one')).toMatchObject({ underline: true });
  });

  it('emphasis inside link text; brackets that are no link stay', () => {
    const r = render(['[**bold** text](u) and [not a link] and [x] (y)']);
    expect(r.lines[0]).toBe('bold text and [not a link] and [x] (y)');
    expect(styleOfText(r, 0, 'bold')).toMatchObject({ bold: true, underline: true });
  });

  it('images show the alt text, dim, behind a glyph that replaces the "!"', () => {
    const r = render(['![a diagram](img/a.png) end']);
    expect(r.lines[0]).toBe('▫a diagram end');
    expect(styleOfText(r, 0, 'a diagram')).toMatchObject({ dim: true });
    expect(r.synthetic(0, 0)).toBe(false);
    expect(r.toSrc(0, 0)).toBe(0); // ▫ stands for the "!"
  });

  it('autolinks lose their angle brackets; other angle brackets stay', () => {
    expect(one('<https://x.y/z> and <b> and <a@b.co>')).toBe('https://x.y/z and <b> and a@b.co');
  });

  it('CJK: emphasis next to Chinese text and full-width punctuation', () => {
    expect(one('这是**加粗**文字')).toBe('这是加粗文字');
    expect(one('**你好。**这是 *中文*强调')).toBe('你好。这是 中文强调');
    expect(one('说“**引号**”后')).toBe('说“引号”后');
  });

  it('astral characters pass through', () => {
    const r = render(['😀 **emoji** 😀']);
    expect(r.lines[0]).toBe('😀 emoji 😀');
    // the surrogate pair maps unit for unit
    expect(r.toSrc(0, 0)).toBe(0);
    expect(r.toSrc(0, 1)).toBe(1);
    expect(r.toSrc(0, 3)).toBe(5); // "e"
  });
});

describe('lists', () => {
  it('bullets become •, ◦, ▪ by depth; numbers stay and are coloured', () => {
    const r = render(['- a', '  - b', '    - c', '      - d', '- e', '* star', '+ plus', '1. one', '10) ten']);
    expect(r.lines).toEqual(['• a', '  ◦ b', '    ▪ c', '      ▪ d', '• e', '• star', '• plus', '1. one', '10) ten']);
    expect(r.styleAt(0, 0)).toMatchObject({ fg: COLOR.warn });
    expect(r.styleAt(7, 0)).toMatchObject({ fg: COLOR.warn });
    expect(r.styleAt(7, 3)).toBeNull();
  });

  it('the depth restarts after a paragraph', () => {
    expect(text(['- a', '  - b', 'para', '- c'])).toEqual(['• a', '  ◦ b', 'para', '• c']);
  });

  it('task lists keep their boxes; a finished item is dim', () => {
    const r = render(['- [ ] todo **b**', '- [x] done', '1. [X] also']);
    expect(r.lines).toEqual(['• [ ] todo b', '• [x] done', '1. [X] also']);
    expect(styleOfText(r, 0, '[ ]')).toMatchObject({ fg: COLOR.accent });
    expect(styleOfText(r, 1, '[x]')).toMatchObject({ dim: true });
    expect(styleOfText(r, 1, 'done')).toMatchObject({ dim: true });
  });

  it('a "-" without a following space and a bold at the start of a line are no list', () => {
    expect(one('-no')).toBe('-no');
    expect(one('**bold** start')).toBe('bold start');
  });
});

describe('quotes', () => {
  it('every > becomes ▎ and the rest is rendered inline in the quote colour', () => {
    const r = render(['> a *b*', '> > nested', '>tight', '> - item']);
    expect(r.lines).toEqual(['▎ a b', '▎ ▎ nested', '▎tight', '▎ • item']);
    expect(r.styleAt(0, 0)).toMatchObject({ fg: '#8fa58f' });
    expect(r.styleAt(0, 4)).toMatchObject({ fg: '#8fa58f', italic: true });
  });
});

describe('code blocks, fences, front matter', () => {
  it('hides the fences, shows the language dim, and never parses the inside', () => {
    const r = render(['```js title="x"', 'const a = **not bold** * 2;', '```', 'after **bold**']);
    expect(r.lines).toEqual(['js', 'const a = **not bold** * 2;', '', 'after bold']);
    expect(r.rowStyle.slice(0, 3)).toEqual([{ bg: COLOR.bgCode }, { bg: COLOR.bgCode }, { bg: COLOR.bgCode }]);
    expect(r.rowStyle[3]).toBeNull();
    expect(r.styleAt(0, 0)).toMatchObject({ dim: true, bg: COLOR.bgCode });
    expect(r.styleAt(1, 3)).toMatchObject({ bg: COLOR.bgCode });
  });

  it('~~~ fences, longer closers, an unclosed fence runs to the end, and indented fences inside lists', () => {
    const r = render(['~~~', '# not a heading', '~~~~', '- item', '  ```', '  code', '  ```', 'tail']);
    expect(r.lines[1]).toBe('# not a heading');
    expect(r.lines[3]).toBe('• item');
    expect(r.lines[5]).toBe('  code');
    expect(r.rowStyle[5]).toEqual({ bg: COLOR.bgCode });
    expect(r.lines[7]).toBe('tail');
    const open = render(['```', '# x', '- y']);
    expect(open.lines).toEqual(['', '# x', '- y']);
  });

  it('inline triple backticks on one line are no fence', () => {
    expect(one('```code``` inline')).toBe('code inline');
  });

  it('front matter is a code block; without a closing --- the first --- is a rule', () => {
    const r = render(['---', 'title: x', '---', '# H']);
    expect(r.lines).toEqual(['', 'title: x', '', 'H']);
    expect(r.rowStyle[1]).toEqual({ bg: COLOR.bgCode });
    expect(text(['---', 'no close'], 12)).toEqual(['─'.repeat(12), 'no close']);
  });
});

describe('rules', () => {
  it('draw ─ to the text width; the part beyond the source is synthetic', () => {
    const r = render(['---'], 30);
    expect(r.lines[0]).toBe('─'.repeat(30));
    expect(r.synthetic(0, 2)).toBe(false);
    expect(r.synthetic(0, 3)).toBe(true);
    expect(r.synthetic(0, 29)).toBe(true);
  });
});

describe('tables', () => {
  const widths = (lines) => lines.map((l) => stringWidth(l));

  it('aligns columns by display width (Chinese is double width), pads by alignment, draws borders', () => {
    const r = render(['| 名称 | 说明 | 数量 |', '|:---|:---:|---:|', '| 苹果 | 水果，**红色** | 3 |', '| banana | `yellow` | 12 |']);
    expect(r.lines).toEqual([
      '│ 名称   │    说明    │ 数量 │',
      '├────────┼────────────┼──────┤',
      '│ 苹果   │ 水果，红色 │    3 │',
      '│ banana │   yellow   │   12 │',
    ]);
    expect(new Set(widths(r.lines)).size).toBe(1);
  });

  it('padding is synthetic, the borders replace the pipes one for one', () => {
    const r = render(['| a | b |', '|---|---|', '| long cell | x |']);
    const row = r.lines[0];
    expect(row).toBe('│ a         │ b │');
    expect(r.toSrc(0, 0)).toBe(0); // │ is the first pipe
    expect(r.synthetic(0, 1)).toBe(true); // the space after │ is padding
    expect(r.toSrc(0, 2)).toBe(2); // a
    expect(r.synthetic(0, 3)).toBe(true);
    // inner and last pipe
    const bar = row.indexOf('│', 1);
    expect(r.toSrc(0, bar)).toBe(4);
    expect(r.toSrc(0, row.length - 1)).toBe(8);
  });

  it('tables without outer pipes work and the delimiter row uses ─ at the ends', () => {
    expect(text(['a | b', '--|--', '1 | 2'])).toEqual([' a │ b ', '───┼───', ' 1 │ 2 ']);
  });

  it('renders inline markup in cells and keeps escaped pipes in the cell', () => {
    const r = render(['| a | b |', '|---|---|', '| \\| x | **y** |']);
    expect(r.lines[2]).toBe('│ | x │ y │');
    expect(styleOfText(r, 2, 'y')).toMatchObject({ bold: true });
  });

  it('keeps escaped pipes in the cell, also inside code spans (the backslash is hidden)', () => {
    const r = render(['| a | b |', '|---|---|', '| `Write\\|Edit` | x\\|y |']);
    expect(r.lines[2]).toBe('│ Write|Edit │ x|y │');
    expect(r.styleAt(2, r.lines[2].indexOf('|Edit'))).toMatchObject({ bg: COLOR.bgCode });
    // every character of the source is still reachable: the backslash is hidden, not dropped
    expect(r.toDisp(2, '| `Write'.length)).toBe(r.lines[2].indexOf('|Edit')); // the backslash -> the next visible character
  });

  it('a table that fits maxWidth is aligned in one piece and has no breaks', () => {
    const r = render(['| a | b |', '|---|---|', '| c | d |'], 20);
    expect(r.breaks).toBeNull();
  });

  describe('wider than maxWidth: cells wrap inside their columns', () => {
    const LONG = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
    const SRC = ['| 名称 | 说明 | 数 |', '|:---|:---:|--:|', `| 苹果 | ${LONG} | 12 |`, '| 梨 | short | 3 |', '| 香蕉 | 很长很长很长很长很长的中文说明没有空格可以断开 | 4 |'];
    const W = 40;
    /** The display line cut at its breaks. */
    const segs = (r, l) => {
      const cuts = [0, ...(r.breaks?.get(l) ?? []), r.lines[l].length];
      return cuts.slice(1).map((c, k) => r.lines[l].slice(cuts[k], c));
    };
    const borderCols = (seg) => {
      const cols = [];
      let w = 0;
      for (const ch of seg) {
        if ('│├┼┤'.includes(ch)) cols.push(w);
        w += stringWidth(ch);
      }
      return cols;
    };

    it('every segment but the last of a row is exactly maxWidth wide, none is wider, and the borders line up', () => {
      const r = render(SRC, W);
      expect(r.lines).toHaveLength(SRC.length);
      let wrappedRows = 0;
      const ref = borderCols(segs(r, 0)[0]);
      expect(ref.length).toBe(4);
      for (let l = 0; l < SRC.length; l++) {
        const sg = segs(r, l);
        if (sg.length > 1) wrappedRows++;
        sg.forEach((seg, k) => {
          expect(stringWidth(seg)).toBeLessThanOrEqual(W);
          if (k < sg.length - 1) expect(stringWidth(seg)).toBe(W);
          expect(borderCols(seg)).toEqual(ref); // the same border columns in every segment of every row
        });
      }
      expect(wrappedRows).toBe(2);
      expect(r.lines[1]).toBe(segs(r, 1)[0]); // the delimiter row is a single piece
      expect(r.lines[1]).toMatch(/^├─+┼─+┼─+┤$/);
    });

    it('breaks after spaces, hard cuts what has none, and fits wide characters', () => {
      const r = render(SRC, W);
      const cell = (seg, k) => seg.split('│')[k + 1].trim();
      const sg = segs(r, 2);
      expect(sg.length).toBeGreaterThan(2);
      expect(cell(sg[0], 0)).toBe('苹果');
      for (const part of sg.slice(1)) expect(cell(part, 0)).toBe('');
      expect(sg.map((x) => cell(x, 1)).join(' ')).toBe(LONG); // words are not cut: pieces end after a space
      expect(cell(sg[0], 2)).toBe('12');
      // The Chinese cell has no space: it is cut between characters and no piece is wider than its column
      const cn = segs(r, 4);
      expect(cn.map((x) => cell(x, 1)).join('')).toBe('很长很长很长很长很长的中文说明没有空格可以断开');
      for (const part of cn) expect(stringWidth(cell(part, 1))).toBeLessThanOrEqual(stringWidth(cell(cn[0], 1)) + 1);
    });

    it('alignment (left / center / right) applies to every piece; the space a piece ends with is not aligned', () => {
      const r = render(['| l | c | r |', '|:--|:-:|--:|', '| aaa bbb ccc | aaa bbb ccc | aaa bbb ccc |', '| 1 | 2 | 3 |'], 40);
      expect(segs(r, 2)).toEqual(['│ aaa bbb    │  aaa bbb   │    aaa bbb │', '│ ccc        │    ccc     │        ccc │']);
      expect(segs(r, 3)).toEqual(['│ 1          │     2      │          3 │']);
      expect(segs(r, 0)).toEqual(['│ l          │     c      │          r │']);
    });

    it('every real character of a cell appears exactly once, the real pipes only in the first segment', () => {
      const r = render(SRC, W);
      for (let l = 0; l < SRC.length; l++) {
        const seen = new Map();
        const shown = [];
        for (let d = 0; d < r.lines[l].length; d++) {
          if (r.synthetic(l, d)) continue;
          seen.set(r.toSrc(l, d), (seen.get(r.toSrc(l, d)) ?? 0) + 1);
          shown.push(r.lines[l][d]);
        }
        for (const [s, n] of seen) expect(n, `line ${l} source ${s}`).toBe(1);
        // all the non-blank characters of the source row are on screen (the pipes as borders), none twice
        const want = [...SRC[l]].filter((c) => c !== ' ').map((c) => (c === '|' ? '│' : c));
        if (l !== 1) expect(shown.filter((c) => c !== ' ').sort()).toEqual(want.sort());
        // the real borders are in the first segment: 4 of them
        const first = segs(r, l)[0].length;
        const real = [];
        for (let d = 0; d < r.lines[l].length; d++) if ('│├┼┤'.includes(r.lines[l][d]) && !r.synthetic(l, d)) real.push(d);
        expect(real).toHaveLength(4);
        expect(Math.max(...real)).toBeLessThan(first);
      }
    });

    it('toDisp(toSrc(d)) is the identity on every real character, also where the source offsets jump back', () => {
      const r = render(SRC, W);
      let backwards = 0;
      for (let l = 0; l < SRC.length; l++) {
        let last = -1;
        for (let d = 0; d < r.lines[l].length; d++) {
          if (r.synthetic(l, d)) continue;
          const s = r.toSrc(l, d);
          expect(r.toDisp(l, s)).toBe(d);
          if (s < last) backwards++;
          last = s;
        }
      }
      expect(backwards).toBeGreaterThan(0); // the premise: the mapping is not monotonic here
      // a hidden source character (the pipe-less whitespace before a cell) snaps to the smallest later source offset
      const s1 = SRC[2].indexOf('alpha');
      expect(r.toDisp(2, s1 - 1)).toBe(r.toDisp(2, s1));
    });

    it('srcRange of a selection that crosses the segments takes the lowest and the highest source offset of the line', () => {
      const r = render(SRC, W);
      const sg = segs(r, 2);
      const l = 2;
      const brk = r.breaks.get(l);
      // from the second piece of the description to the third segment: in the source "说明" comes before the "12" cell
      const from = brk[0] + 1; // just inside segment 2
      const to = brk[1] + 5; // inside segment 3
      const sr = r.srcRange({ start: { line: l, off: from }, end: { line: l, off: to } });
      const srcs = [];
      for (let d = from; d < to; d++) if (!r.synthetic(l, d)) srcs.push(r.toSrc(l, d));
      expect(sr).toEqual({ start: { line: l, off: Math.min(...srcs) }, end: { line: l, off: Math.max(...srcs) + 1 } });
      // a selection from the first segment's first cell to the end of the second segment reaches the last cell ("12")
      const wide = r.srcRange({ start: { line: l, off: 0 }, end: { line: l, off: brk[1] } });
      expect(wide.start).toEqual({ line: l, off: 0 });
      expect(wide.end.off).toBe(SRC[l].length); // the closing pipe of the first segment is the highest offset
      expect(sg.length).toBeGreaterThan(2);
    });

    it('the pane wraps the line exactly at the segments (explicit breaks), where plain word wrap would not', () => {
      const r = render(SRC, W);
      for (const l of [0, 2, 3, 4]) {
        const sg = segs(r, l);
        const rows = buildLayout([r.lines[l]], { width: W, breaks: new Map([[0, r.breaks?.get(l) ?? []]]) });
        expect(rows.map((x) => x.text)).toEqual(sg);
        expect(rows.map((x) => x.first)).toEqual(sg.map((_, k) => k === 0));
      }
      // without the breaks the look-back of word wrap moves the cut before the last border
      const plain = buildLayout([r.lines[2]], { width: W });
      expect(plain.map((x) => x.text)).not.toEqual(segs(r, 2));
    });

    it('a CJK-only cell wraps at character boundaries; a space that would not fit hangs into the padding', () => {
      const r = render(['| 项 | 说明 |', '|---|---|', '| 一 | 汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字 |', '| 二 | abcdefghij klmnopqrst uvwxyz |'], 19);
      for (let l = 0; l < 4; l++) for (const seg of segs(r, l)) expect(stringWidth(seg)).toBeLessThanOrEqual(19);
      const cn = segs(r, 2).map((x) => x.split('│')[2]);
      expect(cn.join('').replace(/ /g, '')).toBe('汉字'.repeat(12));
      expect(cn.every((x) => stringWidth(x) === stringWidth(cn[0]))).toBe(true);
      // "abcdefghij" fills the column exactly: its closing space is in the padding, the next word starts the next piece
      const en = segs(r, 3).map((x) => x.split('│')[2]);
      expect(en.map((x) => x.trim())).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
      expect(en[0]).toBe(' abcdefghij ');
    });

    it('a tab in a cell is shown as a space (a tab would break the width of the segments)', () => {
      const r = render(['| a | b |', '|---|---|', `| x\ty | ${'w '.repeat(30)}|`], 24);
      expect(r.lines[2]).not.toContain('\t');
      expect(r.lines[2]).toContain('x y');
      for (const seg of segs(r, 2)) expect(stringWidth(seg)).toBeLessThanOrEqual(24);
    });

    it('tables without outer pipes wrap too', () => {
      const r = render(['a | b', '--|--', `1 | ${LONG}`], 30);
      const sg = segs(r, 2);
      expect(sg.length).toBeGreaterThan(1);
      for (const seg of sg.slice(0, -1)) expect(stringWidth(seg)).toBe(30);
      expect(sg.map((x) => x.split('│')[1].trim()).join(' ')).toBe(LONG);
      expect(r.lines[1]).toMatch(/^─+┼─+$/);
    });

    it('falls back to replacing only the pipes when even the narrowest columns do not fit', () => {
      const src = ['| aaaaaaaaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbbbbbbbbbb |', '|---|---|', '| c | **d** |'];
      const r = render(src, 12); // 3 pipes + 2 x 2 padding + 2 x 3 columns = 13
      expect(r.lines[0]).toBe('│ aaaaaaaaaaaaaaaaaaaaaaaaaa │ bbbbbbbbbbbbbbbbbbbbbbbbbbbb │');
      expect(r.lines[1]).toBe('├───┼───┤');
      expect(r.lines[2]).toBe('│ c │ d │');
      expect(r.breaks).toBeNull();
      for (let l = 0; l < 3; l++) for (let d = 0; d < r.lines[l].length; d++) expect(r.synthetic(l, d)).toBe(false);
      // the smallest width that still wraps
      const w = render(src, 13);
      expect(w.breaks).not.toBeNull();
    });
  });

  it('two lines that merely contain pipes are not a table; a delimiter row with another cell count is not either', () => {
    expect(text(['a | b', 'c | d'])).toEqual(['a | b', 'c | d']);
    expect(text(['| a | b |', '|---|', '| 1 | 2 |'])[1]).toBe('|---|');
  });
});

describe('other syntax is shown as written', () => {
  it('html, footnotes and reference definitions', () => {
    expect(text(['<div>', '</div>', '[^1]: a footnote', '[ref]: http://x "T"'])).toEqual(['<div>', '</div>', '[^1]: a footnote', '[ref]: http://x "T"']);
  });

  it('tabs and blank lines', () => {
    expect(text(['a\tb', '   ', ''])).toEqual(['a\tb', '   ', '']);
  });
});

describe('offset mapping', () => {
  const SAMPLE = [
    '---',
    'title: x',
    '---',
    '# 周报 **总览**',
    'Setext',
    '======',
    'a **b** `c` [d](u) ![e](i) <https://f> \\*g\\*',
    '- [ ] one',
    '  - two',
    '> quote *q*',
    '| 名称 | 说明 |',
    '|---|:-:|',
    '| 苹果 | **红** |',
    '```js',
    'raw **x**',
    '```',
    '---',
    '',
  ];

  it('toDisp(toSrc(d)) is the identity on every real character; synthetic ones map to a real neighbour', () => {
    const r = render(SAMPLE, 50);
    for (let l = 0; l < SAMPLE.length; l++) {
      for (let d = 0; d < r.lines[l].length; d++) {
        const s = r.toSrc(l, d);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(SAMPLE[l].length);
        if (!r.synthetic(l, d)) expect(r.toDisp(l, s)).toBe(d);
      }
    }
  });

  it('every real display character is a copy of its source character, or a 1:1 glyph', () => {
    const r = render(SAMPLE, 50);
    const glyphs = new Set(['•', '◦', '▪', '▎', '│', '├', '┤', '┼', '─', '═', '▫']);
    for (let l = 0; l < SAMPLE.length; l++) {
      for (let d = 0; d < r.lines[l].length; d++) {
        if (r.synthetic(l, d)) continue;
        const c = r.lines[l][d];
        const s = SAMPLE[l][r.toSrc(l, d)];
        expect(c === s || glyphs.has(c)).toBe(true);
      }
    }
  });

  it('hidden source characters snap to the next visible one', () => {
    const r = render(['a **b** c']);
    expect(r.lines[0]).toBe('a b c');
    expect(r.toDisp(0, 2)).toBe(2); // the first * -> b
    expect(r.toDisp(0, 3)).toBe(2);
    expect(r.toDisp(0, 4)).toBe(2); // b
    expect(r.toDisp(0, 5)).toBe(3); // the closing * -> the space after
    expect(r.toDisp(0, 99)).toBe(5); // beyond the line: its end
    expect(r.toSrc(0, 2)).toBe(4);
    expect(r.toSrc(0, 99)).toBe(9);
  });

  it('heading: the cursor at display 0 is the first character after "# "', () => {
    const r = render(['## Hello']);
    expect(r.toSrc(0, 0)).toBe(3);
    expect(r.toDisp(0, 0)).toBe(0);
    expect(r.toDisp(0, 3)).toBe(0);
  });

  it('srcRange: a display range becomes the source range of its real characters', () => {
    const r = render(['x **bold** y']);
    // display "bold" = [2, 6)
    expect(r.srcRange({ start: { line: 0, off: 2 }, end: { line: 0, off: 6 } })).toEqual({ start: { line: 0, off: 4 }, end: { line: 0, off: 8 } });
    // display "x bold y" fully: from the x to the y, including the hidden markers between them
    expect(r.srcRange({ start: { line: 0, off: 0 }, end: { line: 0, off: 8 } })).toEqual({ start: { line: 0, off: 0 }, end: { line: 0, off: 12 } });
  });

  it('srcRange skips synthetic edges and gives null for a range of padding only', () => {
    const r = render(['| a | b |', '|---|---|', '| long cell | x |']);
    // the padding after "a" up to the next border: [3, 11)
    const pad = r.srcRange({ start: { line: 0, off: 3 }, end: { line: 0, off: 11 } });
    expect(pad).toBeNull();
    const withB = r.srcRange({ start: { line: 0, off: 3 }, end: { line: 0, off: 15 } }); // ... up to and including b
    expect(withB.start).toEqual({ line: 0, off: 4 }); // the inner pipe
    expect(withB.end).toEqual({ line: 0, off: 7 });
  });

  it('srcRange across lines', () => {
    const r = render(['# Head', 'plain **two**']);
    expect(r.srcRange({ start: { line: 0, off: 2 }, end: { line: 1, off: 9 } })).toEqual({ start: { line: 0, off: 4 }, end: { line: 1, off: 11 } });
  });

  it('covered(): synthetic characters count when both real neighbours are inside', () => {
    const r = render(['| a | long |', '|---|---|', '| much longer | x |']);
    // line 0: "│ a" then padding then "│ long"
    const row = r.lines[0];
    const padAt = 3;
    expect(r.synthetic(0, padAt)).toBe(true);
    const aSrc = r.toSrc(0, 2);
    const nextBar = row.indexOf('│', 1);
    const barSrc = r.toSrc(0, nextBar);
    expect(r.covered(0, padAt, aSrc, barSrc + 1)).toBe(true);
    expect(r.covered(0, padAt, aSrc, barSrc)).toBe(false);
    expect(r.covered(0, padAt, aSrc + 1, barSrc + 1)).toBe(false);
  });
});

describe('performance', () => {
  it('renders a 2000 line document quickly', () => {
    const block = [
      '# Heading **bold** and `code`',
      'Some paragraph text with *emphasis*, **strong**, [a link](http://example.com/x) and 中文文本混排 snake_case.',
      '- list item one with `inline`',
      '  - nested item **b**',
      '> quote line with _em_',
      '| a | b | c |',
      '|---|:-:|--:|',
      '| 1 | **2** | 中文 |',
      '```js',
      'const x = 1 * 2 * 3;',
      '```',
      '1. numbered item',
      'text line',
      '---',
    ];
    const lines = [];
    while (lines.length < 2000) lines.push(...block);
    lines.length = 2000;
    renderMarkdown(lines, { maxWidth: 100 }); // warm up
    const t0 = performance.now();
    const r = renderMarkdown(lines, { maxWidth: 100 });
    const ms = performance.now() - t0;
    expect(r.lines).toHaveLength(2000);
    // ~20 ms warm on the dev host; the bound is generous so a loaded CI machine does not flake
    expect(ms).toBeLessThan(250);
  });
});
