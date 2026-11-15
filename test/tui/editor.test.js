import { describe, it, expect } from 'vitest';
import {
  createEditor,
  insert,
  newline,
  backspace,
  deleteForward,
  left,
  right,
  up,
  down,
  home,
  end,
  setCursor,
  visualRows,
  countRows,
} from '../../src/tui/input/editor.js';
import { splitGraphemes } from '../../src/tui/input/text.js';

const FAMILY = '👨‍👩‍👧';
const E_ACUTE = 'é';

const ed = (text, cursor) => createEditor(text, cursor);
const boundariesOf = (text) => new Set([0, ...splitGraphemes(text).map((g) => g.end)]);

describe('editor: insert', () => {
  it('inserts at the cursor and advances it', () => {
    let s = ed('');
    s = insert(s, 'ab');
    s = insert(s, 'c');
    expect(s).toEqual({ text: 'abc', cursor: 3 });
    s = left(left(s));
    s = insert(s, 'X');
    expect(s).toEqual({ text: 'aXbc', cursor: 2 });
  });

  it('inserts a whole IME commit / paste in one operation', () => {
    const s = insert(ed('ab', 1), '你好，世界');
    expect(s).toEqual({ text: 'a你好，世界b', cursor: 6 });
  });

  it('keeps astral characters intact (cursor counts UTF-16 units)', () => {
    const s = insert(ed(''), '😀');
    expect(s).toEqual({ text: '😀', cursor: 2 });
  });

  it('normalises CRLF / CR to LF and strips ANSI + control characters, keeping TAB', () => {
    expect(insert(ed(''), 'a\r\nb\rc\x1b[31mred\x1b[0m\x07\x00\td').text).toBe('a\nb\ncredd'.replace('credd', 'cred\td'));
    expect(insert(ed(''), '\x1b]0;title\x07x').text).toBe('x');
  });

  it('returns the same state for empty / fully-stripped input', () => {
    const s = ed('abc');
    expect(insert(s, '')).toBe(s);
    expect(insert(s, '\x07\x00')).toBe(s);
  });

  it('newline() inserts LF', () => {
    expect(newline(ed('ab', 1))).toEqual({ text: 'a\nb', cursor: 2 });
  });

  it('keeps the cursor on a grapheme boundary when an insertion merges into a cluster', () => {
    // Typing a combining accent right before an existing combining accent's base.
    const s = insert(ed('ab', 1), '́');
    expect(boundariesOf(s.text).has(s.cursor)).toBe(true);
  });
});

describe('editor: backspace / delete / left / right (grapheme aware)', () => {
  it('backspace removes a whole ZWJ family emoji', () => {
    const s = backspace(ed(`a${FAMILY}`));
    expect(s).toEqual({ text: 'a', cursor: 1 });
  });

  it('backspace removes base + combining mark as one', () => {
    expect(backspace(ed(`x${E_ACUTE}`))).toEqual({ text: 'x', cursor: 1 });
  });

  it('backspace removes one CJK char, one flag, one astral emoji', () => {
    expect(backspace(ed('你好'))).toEqual({ text: '你', cursor: 1 });
    expect(backspace(ed('a🇨🇳'))).toEqual({ text: 'a', cursor: 1 });
    expect(backspace(ed('a😀'))).toEqual({ text: 'a', cursor: 1 });
  });

  it('backspace in the middle and at a line start (joins lines)', () => {
    expect(backspace(ed('abc', 2))).toEqual({ text: 'ac', cursor: 1 });
    expect(backspace(ed('ab\ncd', 3))).toEqual({ text: 'abcd', cursor: 2 });
    const s = ed('abc', 0);
    expect(backspace(s)).toBe(s);
  });

  it('delete removes the grapheme after the cursor', () => {
    expect(deleteForward(ed(`${FAMILY}b`, 0))).toEqual({ text: 'b', cursor: 0 });
    expect(deleteForward(ed(`${E_ACUTE}b`, 0))).toEqual({ text: 'b', cursor: 0 });
    const s = ed('ab');
    expect(deleteForward(s)).toBe(s);
  });

  it('left / right move over whole graphemes and across newlines', () => {
    const text = `a${FAMILY}${E_ACUTE}你\nz`;
    let s = ed(text, 0);
    const seen = [0];
    for (let i = 0; i < 10; i++) {
      const n = right(s);
      if (n === s) break;
      s = n;
      seen.push(s.cursor);
    }
    expect(seen).toEqual([0, 1, 1 + FAMILY.length, 1 + FAMILY.length + 2, 1 + FAMILY.length + 3, 1 + FAMILY.length + 4, text.length]);
    const back = [s.cursor];
    for (let i = 0; i < 10; i++) {
      const n = left(s);
      if (n === s) break;
      s = n;
      back.push(s.cursor);
    }
    expect(back).toEqual([...seen].reverse());
  });

  it('cursor is always on a grapheme boundary after any sequence of operations', () => {
    const text = `a${FAMILY}${E_ACUTE}你好\n🇨🇳x😀`;
    const ops = [left, right, backspace, deleteForward, (s) => insert(s, FAMILY), (s) => insert(s, '́'), (s) => up(s, 4), (s) => down(s, 4), home, end];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let s = ed(text, 3);
    for (let i = 0; i < 400; i++) {
      s = ops[Math.floor(rnd() * ops.length)](s);
      expect(boundariesOf(s.text).has(s.cursor)).toBe(true);
    }
  });

  it('setCursor snaps to a boundary and clamps', () => {
    const t = `a${FAMILY}b`;
    expect(setCursor(ed(t, 0), 3).cursor).toBe(1 + FAMILY.length);
    expect(setCursor(ed(t, 0), 999).cursor).toBe(t.length);
    expect(setCursor(ed(t, 2), -5).cursor).toBe(0);
  });
});

describe('editor: home / end', () => {
  it('move within the logical line', () => {
    const s = ed('one\ntwo three\nfour', 8);
    expect(home(s).cursor).toBe(4);
    expect(end(s).cursor).toBe(13);
    expect(home(ed('abc', 0))).toEqual({ text: 'abc', cursor: 0 });
    expect(end(ed('abc\n', 4)).cursor).toBe(4);
  });
});

describe('editor: visualRows', () => {
  it('wraps and locates the cursor', () => {
    const v = visualRows(ed('abcdefghij', 6), 4);
    expect(v.rows.map((r) => r.text)).toEqual(['abcd', 'efgh', 'ij']);
    expect(v.rows.map((r) => [r.start, r.end])).toEqual([[0, 4], [4, 8], [8, 10]]);
    expect(v.cursor).toEqual({ row: 1, col: 2, cell: 2 });
  });

  it('places the cursor at the end of text and on empty lines', () => {
    expect(visualRows(ed('ab'), 10).cursor).toEqual({ row: 0, col: 2, cell: -1 });
    const v = visualRows(ed('ab\n\ncd', 3), 10);
    expect(v.rows).toHaveLength(3);
    expect(v.cursor).toEqual({ row: 1, col: 0, cell: -1 });
  });

  it('positions the cursor in wrapped Chinese text by display width', () => {
    const t = '你好世界再见'; // 6 chars, width 12; text width 6 -> 3 chars per row
    expect(visualRows(ed(t, 0), 6).cursor).toEqual({ row: 0, col: 0, cell: 0 });
    expect(visualRows(ed(t, 2), 6).cursor).toEqual({ row: 0, col: 4, cell: 2 });
    expect(visualRows(ed(t, 3), 6).cursor).toEqual({ row: 1, col: 0, cell: 0 });
    expect(visualRows(ed(t, 5), 6).cursor).toEqual({ row: 1, col: 4, cell: 2 });
    expect(visualRows(ed(t, 6), 6).cursor).toEqual({ row: 1, col: 6, cell: -1 });
  });

  it('global offsets stay correct across several logical lines', () => {
    const v = visualRows(ed('ab\ncdefgh\ni', 8), 4);
    expect(v.rows.map((r) => [r.text, r.start, r.end])).toEqual([
      ['ab', 0, 2],
      ['cdef', 3, 7],
      ['gh', 7, 9],
      ['i', 10, 11],
    ]);
    expect(v.cursor).toMatchObject({ row: 2, col: 1 });
  });

  it('countRows counts wrapped rows', () => {
    expect(countRows('', 10)).toBe(1);
    expect(countRows('a\nb\nc', 10)).toBe(3);
    expect(countRows('abcdefgh', 3)).toBe(3);
  });
});

describe('editor: up / down', () => {
  it('moves between logical lines keeping the column and remembers the goal column', () => {
    let s = ed('hello world\nhi\nabcdefghijk', 8);
    s = down(s, 40);
    expect(s.cursor).toBe(14); // end of "hi" (short line)
    s = down(s, 40);
    expect(s.cursor).toBe(15 + 8); // back to column 8 thanks to goalCol
    s = up(s, 40);
    s = up(s, 40);
    expect(s.cursor).toBe(8);
    expect(up(s, 40)).toBe(s); // first row: no-op
  });

  it('goalCol is dropped by other operations', () => {
    let s = down(ed('abcdef\nxy', 4), 40);
    expect(s.goalCol).toBe(4);
    s = left(s);
    expect(s.goalCol).toBeUndefined();
  });

  it('down on the last row is a no-op', () => {
    const s = ed('a\nb', 3);
    expect(down(s, 10)).toBe(s);
  });

  it('moves across soft-wrapped rows of one logical line', () => {
    let s = ed('abcdefghij', 2);
    s = down(s, 4);
    expect(s.cursor).toBe(6);
    s = down(s, 4);
    expect(s.cursor).toBe(10); // third row "ij" is shorter: end of text (column 2)
    s = up(s, 4);
    expect(s.cursor).toBe(6);
  });

  it('uses display columns with double-width characters', () => {
    // Line 1: "ab你" (cols a=0 b=1 你=2-3); line 2: "你好x" (你=0-1 好=2-3 x=4)
    let s = ed('ab你\n你好x', 2); // cursor before 你 on line 1, col 2
    s = down(s, 40);
    expect(s.cursor).toBe(4 + 1); // 好 starts at col 2
    // A goal column inside the right half of a wide char resolves to that char.
    s = { ...ed('ab你\n你好x', 2), goalCol: 3 };
    s = down(s, 40);
    expect(s.text.slice(s.cursor, s.cursor + 1)).toBe('好');
  });

  it('moves between wrapped Chinese rows', () => {
    let s = ed('你好世界再见', 1); // col 2 on row 0 (width 6 => 3 chars/row)
    s = down(s, 6);
    expect(s.cursor).toBe(4); // 再 is at col 2 of row 1
    s = up(s, 6);
    expect(s.cursor).toBe(1);
  });
});
