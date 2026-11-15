import { describe, it, expect } from 'vitest';
import { lastOff, firstNonBlank, colOf, offsetAtCol, clampOff, moveLeft, moveRight, nextWord, prevWord, wordEnd } from '../../src/tui/lib/motions.js';

const P = (line, off) => ({ line, off });

describe('character motions', () => {
  it('lastOff, firstNonBlank', () => {
    expect(lastOff('')).toBe(0);
    expect(lastOff('abc')).toBe(2);
    expect(lastOff('你好')).toBe(1);
    expect(lastOff('a👨‍👩‍👧')).toBe(1); // a ZWJ family is one grapheme
    expect(firstNonBlank('   x y')).toBe(3);
    expect(firstNonBlank('\t你')).toBe(1);
    expect(firstNonBlank('   ')).toBe(2);
  });

  it('h / l move by grapheme and stop at the line ends', () => {
    expect(moveRight('a你b', 0)).toBe(1);
    expect(moveRight('a你b', 1)).toBe(2);
    expect(moveRight('a你b', 2)).toBe(2);
    expect(moveLeft('a你b', 2)).toBe(1);
    expect(moveLeft('a你b', 0)).toBe(0);
    const fam = 'x👨‍👩‍👧y';
    expect(moveRight(fam, 1)).toBe(fam.length - 1);
    expect(moveLeft(fam, fam.length - 1)).toBe(1);
    expect(moveRight('é', 0)).toBe(0); // e + combining accent is one grapheme
    expect(moveRight('', 0)).toBe(0);
  });

  it('display columns and the goal column (wide characters, tabs)', () => {
    expect(colOf('a你b', 0)).toBe(0);
    expect(colOf('a你b', 1)).toBe(1);
    expect(colOf('a你b', 2)).toBe(3);
    expect(colOf('\tx', 1)).toBe(4);
    expect(offsetAtCol('a你b', 0)).toBe(0);
    expect(offsetAtCol('a你b', 1)).toBe(1);
    expect(offsetAtCol('a你b', 2)).toBe(1); // the right half of 你 belongs to 你
    expect(offsetAtCol('a你b', 3)).toBe(2);
    expect(offsetAtCol('a你b', 99)).toBe(2); // beyond the end: the last character
    expect(offsetAtCol('', 5)).toBe(0);
  });

  it('clampOff snaps into the line', () => {
    expect(clampOff('abc', 9)).toBe(2);
    expect(clampOff('', 3)).toBe(0);
    expect(clampOff('你好', 1)).toBe(1);
    expect(clampOff('éx', 1)).toBe(0); // inside a grapheme -> its start
  });
});

describe('word motions', () => {
  const lines = ['hello world, foo', '', '你好世界 abc', 'last'];

  it('w goes to the next word start, treating punctuation as words and empty lines as stops', () => {
    expect(nextWord(lines, P(0, 0))).toEqual(P(0, 6));
    expect(nextWord(lines, P(0, 6))).toEqual(P(0, 11)); // the comma
    expect(nextWord(lines, P(0, 11))).toEqual(P(0, 13));
    expect(nextWord(lines, P(0, 13))).toEqual(P(1, 0)); // empty line
    expect(nextWord(lines, P(1, 0))).toEqual(P(2, 0));
    expect(nextWord(lines, P(3, 0))).toEqual(P(3, 3)); // end of the document
  });

  it('w understands Chinese word boundaries', () => {
    const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
    const words = [...seg.segment('你好世界 abc')].filter((s) => s.segment.trim());
    // whatever the ICU dictionary says, w visits exactly its word starts in order
    let pos = P(2, 0);
    const seen = [0];
    for (let i = 0; i < words.length - 1; i++) {
      pos = nextWord(lines, pos);
      seen.push(pos.off);
    }
    expect(seen).toEqual(words.map((w) => w.index));
    expect(words.length).toBeGreaterThan(1);
  });

  it('b goes back', () => {
    expect(prevWord(lines, P(0, 6))).toEqual(P(0, 0));
    expect(prevWord(lines, P(0, 8))).toEqual(P(0, 6));
    expect(prevWord(lines, P(2, 0))).toEqual(P(1, 0));
    expect(prevWord(lines, P(1, 0))).toEqual(P(0, 13));
    expect(prevWord(lines, P(0, 0))).toEqual(P(0, 0));
  });

  it('e goes to the end of the word', () => {
    expect(wordEnd(lines, P(0, 0))).toEqual(P(0, 4));
    expect(wordEnd(lines, P(0, 4))).toEqual(P(0, 10));
    expect(wordEnd(lines, P(0, 10))).toEqual(P(0, 11)); // the comma is a word of one character
    const first = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(lines[2])][0];
    expect(wordEnd(lines, P(0, 15))).toEqual(P(2, first.segment.length - 1)); // skips the empty line to the end of the next word
    expect(wordEnd(lines, P(3, 3))).toEqual(P(3, 3));
  });
});
