// CJK coverage beyond Han: Japanese (hiragana, katakana, kanji mixed, full-width punctuation)
// and Korean (hangul syllables, mixed with ASCII). Mirrors the Chinese fixtures in layout / editor /
// MultiLineInput / motions / mdRender tests: wide characters take 2 columns and are never split.
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import stringWidth from 'string-width';
import { render, cleanup } from 'ink-testing-library';
import { MultiLineInput } from '../../src/tui/input/MultiLineInput.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';
import { textWidth, graphemeWidth, splitGraphemes } from '../../src/tui/input/text.js';
import { buildLayout, hitTest, locate } from '../../src/tui/mouse/layout.js';
import {
  createEditor,
  insert,
  backspace,
  deleteForward,
  left,
  right,
  up,
  down,
  visualRows,
} from '../../src/tui/input/editor.js';
import { colOf, offsetAtCol, moveLeft, moveRight, lastOff } from '../../src/tui/lib/motions.js';
import { renderMarkdown } from '../../src/tui/lib/mdRender.js';

const h = React.createElement;
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const frameLines = (frame) =>
  // eslint-disable-next-line no-control-regex
  frame.replace(/\x1b\[7m([^\x1b]*)\x1b\[27m/g, '[$1]').split('\n').map(strip);

const ed = (text, cursor) => createEditor(text, cursor);

// Each sample: text, its display width, and the number of characters (all BMP, one UTF-16 unit each).
const SAMPLES = {
  hiragana: { text: 'こんにちは', cols: 10, len: 5 },
  katakana: { text: 'カタカナ', cols: 8, len: 4 },
  'kanji + kana': { text: '日本語のテキスト', cols: 16, len: 8 },
  'full-width punctuation': { text: '日本語、です。「はい」', cols: 22, len: 11 },
  hangul: { text: '안녕하세요', cols: 10, len: 5 },
  'hangul + ASCII': { text: 'abc한국어def', cols: 12, len: 9 },
  'kana + ASCII': { text: 'Node.jsで動く', cols: 13, len: 10 },
};
const entries = Object.entries(SAMPLES);

describe('CJK scripts: display width', () => {
  it.each(entries)('%s: wide characters take 2 columns', (_n, { text, cols, len }) => {
    expect(textWidth(text)).toBe(cols);
    expect(stringWidth(text)).toBe(cols);
    expect(splitGraphemes(text)).toHaveLength(len);
  });

  it('single characters', () => {
    for (const c of ['あ', 'ア', '漢', '、', '。', '「', '」', '！', 'ー', '가', '힣', '한']) {
      expect(graphemeWidth(c)).toBe(2);
    }
    for (const c of ['a', ' ', '1']) expect(graphemeWidth(c)).toBe(1);
  });

  it('half-width katakana stays one column', () => {
    expect(graphemeWidth('ｱ')).toBe(1);
    expect(textWidth('ｶﾀｶﾅ')).toBe(4);
  });

  it('a voiced kana typed as base + combining mark is one grapheme (width 2)', () => {
    const g = 'が'; // か + combining dakuten
    expect(splitGraphemes(g)).toHaveLength(1);
    expect(textWidth(g)).toBe(2);
  });

  it('a hangul syllable written as conjoining jamo is one grapheme (width 2)', () => {
    const g = '한'; // ᄒ + ᅡ + ᆫ = 한
    expect(splitGraphemes(g)).toHaveLength(1);
    expect(textWidth(g)).toBe(2);
  });
});

describe('CJK scripts: wrapping (buildLayout)', () => {
  it.each(entries)('%s: no row exceeds the width, no wide character is split, text is preserved', (_n, { text }) => {
    for (const width of [1, 2, 3, 4, 5, 6, 7, 9, 20]) {
      const rows = buildLayout([text], { width });
      expect(rows.map((r) => r.text).join('')).toBe(text);
      let at = 0;
      for (const r of rows) {
        expect(r.s ?? r.startOffset).toBe(at);
        at = r.e ?? r.endOffset;
        // a single character wider than the row is allowed to overflow (width 1), nothing else is
        if (splitGraphemes(r.text).length > 1) expect(stringWidth(r.text)).toBeLessThanOrEqual(width);
        expect(r.text).not.toMatch(/[\ud800-\udfff]/);
      }
      expect(at).toBe(text.length);
    }
  });

  it('breaks between kana at the width boundary', () => {
    const l = buildLayout(['こんにちはさようなら'], { width: 6 });
    expect(l.map((r) => r.text)).toEqual(['こんに', 'ちはさ', 'ような', 'ら']);
  });

  it('keeps a wide character that does not fit the last column for the next row', () => {
    const l = buildLayout(['a한국'], { width: 4 });
    expect(l.map((r) => r.text)).toEqual(['a한', '국']);
    const m = buildLayout(['abc한국'], { width: 4 });
    expect(m.map((r) => r.text)).toEqual(['abc', '한국']);
  });

  it('Japanese with full-width punctuation wraps by width', () => {
    const l = buildLayout(['日本語、です。'], { width: 8 });
    expect(l.map((r) => r.text)).toEqual(['日本語、', 'です。']);
  });

  it('a one-column view puts one wide character per row', () => {
    expect(buildLayout(['한국'], { width: 1 }).map((r) => r.text)).toEqual(['한', '국']);
    expect(buildLayout(['日本'], { width: 1 }).map((r) => r.text)).toEqual(['日', '本']);
  });

  it('Korean words separated by spaces wrap at the space when they fit', () => {
    const l = buildLayout(['안녕 하세요 여러분'], { width: 12 });
    for (const r of l) expect(stringWidth(r.text)).toBeLessThanOrEqual(12);
    expect(l.map((r) => r.text).join('')).toBe('안녕 하세요 여러분');
  });
});

describe('CJK scripts: hit testing and locate', () => {
  it('either half of a wide kana / hangul selects that character', () => {
    const l = buildLayout(['aあ한b'], { width: 20 }); // a=0, あ=1-2, 한=3-4, b=5
    expect(hitTest(l, 0, 1).offset).toBe(1);
    expect(hitTest(l, 0, 2).offset).toBe(1);
    expect(hitTest(l, 0, 3).offset).toBe(2);
    expect(hitTest(l, 0, 4).offset).toBe(2);
    expect(hitTest(l, 0, 5).offset).toBe(3);
    expect(hitTest(l, 0, 6)).toMatchObject({ offset: 4, region: 'eol' });
  });

  it('wrapped Japanese / Korean text: offsets continue across rows', () => {
    for (const t of ['こんにちはさようなら', '안녕하세요여러분입니다']) {
      const l = buildLayout([t], { width: 6 });
      expect(hitTest(l, 0, 5).offset).toBe(2);
      expect(hitTest(l, 1, 0).offset).toBe(3);
      expect(hitTest(l, 1, 1).offset).toBe(3);
      expect(hitTest(l, 1, 4).offset).toBe(5);
    }
  });

  it('gutter + wide characters', () => {
    const l = buildLayout(['カタ'], { width: 20, gutterWidth: 5 });
    expect(hitTest(l, 0, 5).offset).toBe(0);
    expect(hitTest(l, 0, 6).offset).toBe(0);
    expect(hitTest(l, 0, 7).offset).toBe(1);
    expect(hitTest(l, 0, 8).offset).toBe(1);
  });

  it('locate is the inverse of hitTest on every character start', () => {
    for (const { text } of Object.values(SAMPLES)) {
      const l = buildLayout([text], { width: 7 });
      for (let off = 0; off < text.length; off++) {
        const at = locate(l, 0, off);
        expect(at).not.toBeNull();
        expect(hitTest(l, at.row, at.col).offset).toBe(off);
      }
    }
  });
});

describe('CJK scripts: motions', () => {
  it.each(entries)('%s: colOf / offsetAtCol agree on wide columns', (_n, { text, len }) => {
    for (let off = 0; off < len; off++) {
      const col = colOf(text, off);
      expect(col).toBe(stringWidth(text.slice(0, off)));
      expect(offsetAtCol(text, col)).toBe(off);
    }
    expect(lastOff(text)).toBe(len - 1);
  });

  it('the right half of a wide character belongs to that character', () => {
    expect(offsetAtCol('aあb', 2)).toBe(1);
    expect(offsetAtCol('a한b', 2)).toBe(1);
    expect(offsetAtCol('a한b', 3)).toBe(2);
    expect(offsetAtCol('aあb', 99)).toBe(2);
  });

  it('moveLeft / moveRight step over whole characters', () => {
    expect(moveRight('aあb', 0)).toBe(1);
    expect(moveRight('aあb', 1)).toBe(2);
    expect(moveRight('aあb', 2)).toBe(2);
    expect(moveLeft('a한b', 2)).toBe(1);
    expect(moveLeft('a한b', 0)).toBe(0);
  });
});

describe('CJK scripts: editor model', () => {
  it.each(entries)('%s: insert / backspace / delete work on whole characters', (_n, { text, len }) => {
    let s = insert(ed('xy', 1), text);
    expect(s).toEqual({ text: `x${text}y`, cursor: 1 + text.length });
    s = backspace(s);
    expect(s.text).toBe(`x${text.slice(0, -1)}y`);
    s = ed(`x${text}y`, 1);
    s = deleteForward(s);
    expect(s.text).toBe(`x${text.slice(1)}y`);
    expect(len).toBeGreaterThan(0);
  });

  it('left / right move one character over kana and hangul', () => {
    let s = ed('あ한ア', 0);
    s = right(s);
    expect(s.cursor).toBe(1);
    s = right(right(s));
    expect(s.cursor).toBe(3);
    s = left(s);
    expect(s.cursor).toBe(2);
  });

  it('the cursor never lands inside a combining sequence', () => {
    const t = 'がa'; // か + dakuten, then a
    expect(right(ed(t, 0)).cursor).toBe(2);
    expect(backspace(ed(t, 2))).toEqual({ text: 'a', cursor: 0 });
    const hangul = '한';
    expect(backspace(ed(`${hangul}x`, hangul.length))).toEqual({ text: 'x', cursor: 0 });
  });

  it('positions the cursor in wrapped Japanese / Korean text by display width', () => {
    for (const t of ['こんにちはさ', '안녕하세요여']) {
      expect(visualRows(ed(t, 0), 6).cursor).toEqual({ row: 0, col: 0, cell: 0 });
      expect(visualRows(ed(t, 2), 6).cursor).toEqual({ row: 0, col: 4, cell: 2 });
      expect(visualRows(ed(t, 3), 6).cursor).toEqual({ row: 1, col: 0, cell: 0 });
      expect(visualRows(ed(t, 5), 6).cursor).toEqual({ row: 1, col: 4, cell: 2 });
      expect(visualRows(ed(t, 6), 6).cursor).toEqual({ row: 1, col: 6, cell: -1 });
    }
  });

  it('visualRows rows carry correct global offsets over several lines', () => {
    const t = 'あいう\nハングル한글\nx';
    const v = visualRows(ed(t, t.length), 6);
    expect(v.rows.map((r) => [r.text, r.start, r.end])).toEqual([
      ['あいう', 0, 3],
      ['ハング', 4, 7],
      ['ル한글', 7, 10],
      ['x', 11, 12],
    ]);
    for (const r of v.rows) expect(r.width).toBeLessThanOrEqual(6);
  });

  it('up / down keep the display column across mixed ASCII, kana and hangul lines', () => {
    // line 1: "ab日" (a=0 b=1 日=2-3); line 2: "한国x" (한=0-1 国=2-3 x=4)
    let s = ed('ab日\n한国x', 2);
    s = down(s, 20);
    expect(s.cursor).toBe(4 + 1); // col 2 is the start of 国
    s = up(s, 20);
    expect(s.cursor).toBe(2);
    // col 3 is the right half of 日 / 国 -> same character
    s = { ...ed('ab日\n한国x', 2), goalCol: 3 };
    s = down(s, 20);
    expect(s.cursor).toBe(5);
  });

  it('up / down move between wrapped rows of Japanese text', () => {
    let s = ed('こんにちはさようなら', 1); // col 2, 3 chars per row at width 6
    s = down(s, 6);
    expect(s.cursor).toBe(4);
    s = down(s, 6);
    expect(s.cursor).toBe(7);
    s = up(up(s, 6), 6);
    expect(s.cursor).toBe(1);
  });
});

describe('CJK scripts: MultiLineInput component', () => {
  afterEach(() => cleanup());

  function setup(props = {}) {
    const calls = { change: [] };
    const bus = createBus();
    const app = render(h(MultiLineInput, { width: 20, bus, onChange: (t) => calls.change.push(t), ...props }));
    const press = async (s) => {
      app.stdin.write(s);
      await wait();
    };
    return { calls, press, frame: () => frameLines(app.lastFrame()) };
  }

  it('inserts Japanese delivered as one chunk and shows the caret after it', async () => {
    const { calls, press, frame } = setup();
    await press('こんにちは、世界');
    expect(calls.change.at(-1)).toBe('こんにちは、世界');
    expect(frame()).toEqual(['こんにちは、世界[ ]']);
  });

  it('inserts Korean mixed with ASCII', async () => {
    const { calls, press, frame } = setup();
    await press('abc한국어');
    expect(calls.change.at(-1)).toBe('abc한국어');
    expect(frame()).toEqual(['abc한국어[ ]']);
  });

  it('wraps Japanese by display width', async () => {
    const { press, frame } = setup({ width: 7 }); // 6 text columns = 3 chars
    await press('ひらがなカ');
    expect(frame()).toEqual(['ひらが', 'なカ[ ]']);
  });

  it('wraps Korean by display width', async () => {
    const { press, frame } = setup({ width: 7 });
    await press('안녕하세요');
    expect(frame()).toEqual(['안녕하', '세요[ ]']);
  });

  it('backspace removes one kana / hangul character at a time', async () => {
    const { calls, press } = setup();
    await press('あ');
    await press('한');
    await press('\x7f');
    expect(calls.change.at(-1)).toBe('あ');
    await press('\x7f');
    expect(calls.change.at(-1)).toBe('');
  });

  it('arrow keys move the caret over wide characters', async () => {
    const { press, frame } = setup();
    await press('日本한');
    await press('\x1b[D');
    expect(frame()).toEqual(['日本[한]']);
    await press('\x1b[D');
    expect(frame()).toEqual(['日[本]한']);
  });
});

describe('CJK scripts: markdown semi-rendering (display <-> source offsets)', () => {
  const SRC = [
    '# 日本語の**見出し**',
    'これは**太字**と*斜体*です。',
    '이것은 **굵은** 글씨와 `코드` 입니다.',
    '- [ ] カタカナ **テスト**',
    '| 名前 | 설명 |',
    '|---|---|',
    '| りんご | **사과** |',
    '',
  ];
  const r = renderMarkdown(SRC, { maxWidth: 40 });

  it('hides markup and keeps Japanese / Korean text and punctuation', () => {
    expect(r.lines[0]).toBe('日本語の見出し');
    expect(r.lines[1]).toBe('これは太字と斜体です。');
    expect(r.lines[2]).toBe('이것은 굵은 글씨와 코드 입니다.');
    expect(r.lines).toHaveLength(SRC.length);
  });

  it('emphasis next to kana / hangul and full-width punctuation still resolves', () => {
    const one = (l) => renderMarkdown([l], { maxWidth: 80 }).lines[0];
    expect(one('これは**太字**です')).toBe('これは太字です');
    expect(one('**日本語。**これは*強調*です')).toBe('日本語。これは強調です');
    // Korean is space-separated and uses ASCII punctuation, so plain CommonMark flanking rules apply
    expect(one('**한국어.** 그리고 *강조*입니다')).toBe('한국어. 그리고 강조입니다');
    expect(one('「**引用**」と言った')).toBe('「引用」と言った');
  });

  it('toSrc points at the same character in the source (text lines; list bullets are glyphs)', () => {
    for (const l of [0, 1, 2]) {
      for (let d = 0; d < r.lines[l].length; d++) {
        if (r.synthetic(l, d)) continue;
        expect(SRC[l][r.toSrc(l, d)]).toBe(r.lines[l][d]);
      }
    }
  });

  it('toDisp(toSrc(d)) is the identity on every real character, toSrc stays inside the line', () => {
    for (let l = 0; l < SRC.length; l++) {
      for (let d = 0; d < r.lines[l].length; d++) {
        const s = r.toSrc(l, d);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(SRC[l].length);
        if (!r.synthetic(l, d)) expect(r.toDisp(l, s)).toBe(d);
      }
    }
  });

  it('source offsets of hidden markup map to the next visible character', () => {
    // "これは**太字**と..." : the ** at 3-4 is hidden, 太 is at source 5
    expect(r.toDisp(1, 3)).toBe(r.lines[1].indexOf('太'));
    expect(r.toSrc(1, r.lines[1].indexOf('太'))).toBe(5);
    expect(r.toSrc(1, r.lines[1].indexOf('と'))).toBe(SRC[1].indexOf('と'));
    // Korean: "이것은 **굵은**"
    expect(r.toSrc(2, r.lines[2].indexOf('굵'))).toBe(SRC[2].indexOf('굵'));
    expect(r.toDisp(2, SRC[2].indexOf('굵'))).toBe(r.lines[2].indexOf('굵'));
  });

  it('srcRange maps a display selection of JP / KR text to the source range', () => {
    const a = r.lines[1].indexOf('太');
    const range = r.srcRange({ start: { line: 1, off: a }, end: { line: 1, off: a + 2 } });
    expect(range).not.toBeNull();
    expect(SRC[1].slice(range.start.off, range.end.off)).toContain('太字');
  });

  it('the display line keeps its width, so wrapping it never splits a wide character', () => {
    for (const l of [0, 1, 2, 3]) {
      const lay = buildLayout([r.lines[l]], { width: 7 });
      expect(lay.map((x) => x.text).join('')).toBe(r.lines[l]);
      for (const row of lay) expect(stringWidth(row.text)).toBeLessThanOrEqual(7);
    }
  });

  it('table cells with Japanese / Korean text are padded to the same display width', () => {
    const t = renderMarkdown(SRC.slice(4, 7), { maxWidth: 40 });
    const widths = t.lines.map((x) => stringWidth(x));
    expect(new Set(widths).size).toBe(1);
    expect(t.lines[2]).toContain('りんご');
    expect(t.lines[2]).toContain('사과');
  });
});
