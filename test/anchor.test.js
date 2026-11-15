import { describe, it, expect } from 'vitest';
import { makeAnchor, locate, reanchor } from '../src/anchor/index.js';

const doc = (lines) => lines.join('\n');

describe('makeAnchor', () => {
  it('captures quote and context for whole lines', () => {
    const c = doc(['a', 'b', 'c', 'd']);
    const a = makeAnchor(c, { startLine: 2, endLine: 3 }, 1);
    expect(a).toMatchObject({ quote: 'b\nc', before: 'a', after: 'd', startCol: null, orphaned: false });
  });
  it('captures an exact character range across lines', () => {
    const c = doc(['hello world', 'second line']);
    const a = makeAnchor(c, { startLine: 1, endLine: 2, startCol: 6, endCol: 6 }, 1);
    expect(a.quote).toBe('world\nsecond');
  });
  it('rejects invalid ranges', () => {
    expect(() => makeAnchor('a\nb', { startLine: 3, endLine: 3 }, 1)).toThrow();
  });
});

describe('locate', () => {
  it('1. exact unique hit follows the text to its new line', () => {
    const a = makeAnchor(doc(['x', 'Migrating the old store is low risk', 'y']), { startLine: 2, endLine: 2 }, 1);
    const r = locate(a, doc(['new', 'new2', 'x', 'Migrating the old store is low risk', 'y']));
    expect(r).toMatchObject({ found: true, method: 'exact', startLine: 4, endLine: 4 });
  });
  it('2. multiple hits are disambiguated by before/after context', () => {
    const old = doc(['## A', 'TODO', 'end A', '## B', 'TODO', 'end B']);
    const a = makeAnchor(old, { startLine: 5, endLine: 5 }, 1);
    const next = doc(['intro', '## A', 'TODO', 'end A', '## B', 'TODO', 'end B']);
    const r = locate(a, next);
    expect(r).toMatchObject({ found: true, method: 'context', startLine: 6 });
  });
  it('2b. with equal context the hit closest to the old line wins', () => {
    const old = doc(['p', 'same', 'q', 'p', 'same', 'q']);
    const a = makeAnchor(old, { startLine: 5, endLine: 5 }, 1);
    expect(locate(a, old).startLine).toBe(5);
  });
  it('3. fuzzy match survives a small edit', () => {
    const a = makeAnchor(doc(['intro', 'The migration risk is low because only two slices are affected.', 'outro']), { startLine: 2, endLine: 2 }, 1);
    const next = doc(['intro', 'extra line', 'The migration risk is low, because only two slices are affected.', 'outro']);
    const r = locate(a, next);
    expect(r.found).toBe(true);
    expect(r.method).toBe('fuzzy');
    expect(r.startLine).toBe(3);
    expect(r.endLine).toBe(3);
  });
  it('4. unrelated content is orphaned', () => {
    const a = makeAnchor(doc(['intro', 'The migration risk is low because only two slices are affected.']), { startLine: 2, endLine: 2 }, 1);
    expect(locate(a, doc(['completely', 'different', 'text about pizza'])).found).toBe(false);
  });
  it('keeps column ranges for character selections (CJK, UTF-16 offsets)', () => {
    const old = doc(['前言', '预计两周完成，包含测试。']);
    const a = makeAnchor(old, { startLine: 2, endLine: 2, startCol: 2, endCol: 4 }, 1);
    expect(a.quote).toBe('两周');
    const r = locate(a, doc(['新增一行', '前言', '预计两周完成，包含测试。']));
    expect(r).toMatchObject({ found: true, startLine: 3, endLine: 3, startCol: 2, endCol: 4, quote: '两周' });
  });
  it('prefers whole-line aligned hits for line anchors', () => {
    const a = makeAnchor(doc(['foo', 'bar']), { startLine: 1, endLine: 1 }, 1);
    const r = locate(a, doc(['a foo b', 'foo', 'z']));
    expect(r.startLine).toBe(2);
  });
  it('handles CRLF content', () => {
    const a = makeAnchor('a\nb\nc', { startLine: 2, endLine: 2 }, 1);
    expect(locate(a, 'a\r\nb\r\nc').startLine).toBe(2);
  });
});

describe('reanchor', () => {
  it('updates moved threads, orphans lost ones, skips resolved', () => {
    const old = doc(['one', 'alpha beta gamma delta', 'two', 'a unique sentence about orchards', 'three']);
    const mk = (id, line, status = 'open') => ({ id, status, anchor: makeAnchor(old, { startLine: line, endLine: line }, 1), messages: [] });
    const threads = [mk('t1', 2), mk('t2', 4), mk('t3', 2, 'resolved')];
    const next = doc(['zero', 'one', 'alpha beta gamma delta', 'two', 'three']);
    reanchor(threads, next, 2);
    expect(threads[0].anchor).toMatchObject({ revision: 2, startLine: 3, orphaned: false, before: 'one', after: 'two' });
    expect(threads[1].anchor).toMatchObject({ orphaned: true, startLine: 4, quote: 'a unique sentence about orchards' });
    expect(threads[2].anchor).toMatchObject({ revision: 1, startLine: 2 });
  });
});
