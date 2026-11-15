// Line / word diff between two revisions (feedback/diff.js).
import { describe, it, expect } from 'vitest';
import { diffRevisions, splitLines, MAX_CHANGED_LINES, MAX_WORD_DIFF_CHARS } from '../src/feedback/diff.js';

const doc = (...lines) => lines.join('\n');
const kinds = (h) => h.lines.map((l) => l.kind[0]).join('');

describe('splitLines', () => {
  it('is the review screen\'s model: CRLF -> LF, split on \\n, a trailing newline leaves an empty last line', () => {
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b', '']);
    expect(splitLines('')).toEqual(['']);
    expect(splitLines(undefined)).toEqual(['']);
  });
});

describe('diffRevisions', () => {
  it('identical documents: no hunks', () => {
    expect(diffRevisions('a\nb', 'a\nb')).toEqual({ identical: true, tooLarge: false, summary: { added: 0, removed: 0 }, hunks: [] });
    expect(diffRevisions('a\r\nb', 'a\nb').identical).toBe(true);
  });

  it('numbers lines on both sides: ctx has both, del the old number, add the new one', () => {
    const r = diffRevisions(doc('# T', 'one', 'two', 'three', 'four', 'five', 'six'), doc('# T', 'one', 'TWO', 'three', 'four', 'five', 'six', 'seven'), { context: 1 });
    expect(r.summary).toEqual({ added: 2, removed: 1 });
    expect(r.hunks).toHaveLength(2);
    const [h1, h2] = r.hunks;
    expect(h1).toMatchObject({ oldStart: 2, oldCount: 3, newStart: 2, newCount: 3 });
    expect(h1.lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ['ctx', 2, 2, 'one'],
      ['del', 3, undefined, 'two'],
      ['add', undefined, 3, 'TWO'],
      ['ctx', 4, 4, 'three'],
    ]);
    expect(h2).toMatchObject({ oldStart: 7, oldCount: 1, newStart: 7, newCount: 2 });
    expect(kinds(h2)).toBe('ca'); // six (ctx), seven (add)
    // changes at distance <= 2 * context + 1 are one hunk
    expect(diffRevisions(doc('a', 'b', 'c', 'd'), doc('A', 'b', 'c', 'D'), { context: 1 }).hunks).toHaveLength(1);
  });

  it('every new line number points at the same text in the new document', () => {
    const a = doc('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', '');
    const b = doc('a', 'X', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'Y', 'Z', '');
    const r = diffRevisions(a, b, { context: Infinity });
    const aL = splitLines(a);
    const bL = splitLines(b);
    expect(r.hunks).toHaveLength(1);
    for (const l of r.hunks[0].lines) {
      if (l.newLine) expect(bL[l.newLine - 1]).toBe(l.text);
      if (l.oldLine) expect(aL[l.oldLine - 1]).toBe(l.text);
      if (l.kind === 'del') expect(l.newLine).toBeUndefined();
      if (l.kind === 'add') expect(l.oldLine).toBeUndefined();
    }
    // the whole new document is covered: ctx + add lines are exactly the new lines
    expect(r.hunks[0].lines.filter((l) => l.kind !== 'del').map((l) => l.text)).toEqual(bL);
    expect(r.hunks[0].lines.filter((l) => l.kind !== 'add').map((l) => l.text)).toEqual(aL);
  });

  it('context: nearby changes merge into one hunk; far ones stay apart; 0 shows only the changes', () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const edited = base.map((l, i) => (i === 4 || i === 8 || i === 25 ? `${l} edited` : l));
    expect(diffRevisions(base.join('\n'), edited.join('\n'), { context: 3 }).hunks).toHaveLength(2); // 5 and 9 merge, 26 apart
    expect(diffRevisions(base.join('\n'), edited.join('\n'), { context: 1 }).hunks).toHaveLength(3);
    const none = diffRevisions(base.join('\n'), edited.join('\n'), { context: 0 });
    expect(none.hunks).toHaveLength(3);
    expect(none.hunks.every((h) => h.lines.every((l) => l.kind !== 'ctx'))).toBe(true);
    const full = diffRevisions(base.join('\n'), edited.join('\n'), { context: Infinity });
    expect(full.hunks).toHaveLength(1);
    expect(full.hunks[0].lines).toHaveLength(30 + 3);
  });

  it('pure insertion / deletion hunks have consistent starts', () => {
    const ins = diffRevisions('a\nb', 'a\nNEW\nb', { context: 0 });
    expect(ins.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 });
    const del = diffRevisions('a\nOLD\nb', 'a\nb', { context: 0 });
    expect(del.hunks[0]).toMatchObject({ oldStart: 2, oldCount: 1, newStart: 1, newCount: 0 });
    const fromEmpty = diffRevisions('', 'x\ny');
    expect(fromEmpty.summary).toEqual({ added: 2, removed: 1 }); // the empty first line was replaced
  });

  it('word marks: only on paired del/add lines, as UTF-16 ranges of the line text', () => {
    const r = diffRevisions('the risk is low\nunchanged', 'the risk is very low now\nunchanged', { context: 0 });
    const [del, add] = r.hunks[0].lines;
    expect(del).toMatchObject({ kind: 'del', text: 'the risk is low' });
    expect(add).toMatchObject({ kind: 'add', text: 'the risk is very low now' });
    expect(add.words.map(([a, b]) => add.text.slice(a, b)).join('|')).toBe('very |' + ' now');
    expect(del.words).toBeUndefined(); // nothing was removed within the line
    const swap = diffRevisions('风险很低', '风险较高', { words: true, context: 0 });
    const [d2, a2] = swap.hunks[0].lines;
    expect(d2.words.map(([a, b]) => d2.text.slice(a, b)).join('')).toContain('很低');
    expect(a2.words.map(([a, b]) => a2.text.slice(a, b)).join('')).toContain('较高');
  });

  it('word marks pair the i-th removed line with the i-th added line of a change block; extra lines get none', () => {
    const r = diffRevisions('a one\nb two\nc three', 'a ONE\nb TWO', { context: 0 });
    const lines = r.hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(['del', 'del', 'del', 'add', 'add']);
    expect(lines[0].words).toBeDefined();
    expect(lines[1].words).toBeDefined();
    expect(lines[2].words).toBeUndefined(); // unpaired
    expect(lines[3].words).toBeDefined();
  });

  it('long lines (> 500 chars) and words:false skip the word level', () => {
    const long = 'x'.repeat(MAX_WORD_DIFF_CHARS + 1);
    const r = diffRevisions(`a ${long}`, `b ${long}`, { context: 0 });
    expect(r.hunks[0].lines.every((l) => l.words === undefined)).toBe(true);
    const ok = diffRevisions('a b', 'a c', { context: 0 });
    expect(ok.hunks[0].lines[0].words).toBeDefined();
    expect(diffRevisions('a b', 'a c', { context: 0, words: false }).hunks[0].lines[0].words).toBeUndefined();
  });

  it('more than 2000 changed lines: statistics only', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 1500 }, (_, i) => `new ${i}`).join('\n');
    const r = diffRevisions(a, b);
    expect(r).toMatchObject({ tooLarge: true, identical: false, hunks: [], summary: { added: 1500, removed: 1500 } });
    // exactly at the limit is still diffed
    const c = Array.from({ length: MAX_CHANGED_LINES / 2 }, (_, i) => `a${i}`).join('\n');
    const d = Array.from({ length: MAX_CHANGED_LINES / 2 }, (_, i) => `b${i}`).join('\n');
    const at = diffRevisions(c, d);
    expect(at.tooLarge).toBe(false);
    expect(at.summary).toEqual({ added: 1000, removed: 1000 });
  });

  it('a huge rewrite is summarised without running the full diff (approximate, quick)', () => {
    const a = Array.from({ length: 6000 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 6000 }, (_, i) => (i < 100 ? `old ${i}` : `new ${i}`)).join('\n');
    const t = Date.now();
    const r = diffRevisions(a, b);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.tooLarge).toBe(true);
    expect(r.approximate).toBe(true);
    expect(r.summary).toEqual({ added: 5900, removed: 5900 });
  });
});
