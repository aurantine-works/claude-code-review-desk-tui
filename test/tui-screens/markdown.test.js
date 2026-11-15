import { describe, it, expect } from 'vitest';
import { classifyLines, cellStyle, inlineCodeSpans } from '../../src/tui/lib/markdown.js';

describe('classifyLines', () => {
  it('recognises headings, lists, quotes, rules and plain text', () => {
    const k = classifyLines(['# T', '## S', 'text', '- item', '1. one', '> quote', '---', '  * nested', '#nospace']).map((i) => i.kind);
    expect(k).toEqual(['heading', 'heading', 'text', 'list', 'list', 'quote', 'hr', 'list', 'text']);
  });

  it('tracks fenced code blocks (state from the lines above)', () => {
    const info = classifyLines(['a', '```js', '# not a heading', '- not a list', '```', '# real heading']);
    expect(info.map((i) => i.kind)).toEqual(['text', 'fence', 'code', 'code', 'fence', 'heading']);
  });

  it('an unterminated fence runs to the end; ~~~ fences close only on ~~~', () => {
    expect(classifyLines(['```', 'x', 'y']).map((i) => i.kind)).toEqual(['fence', 'code', 'code']);
    expect(classifyLines(['~~~', '```', 'x', '~~~', 'z']).map((i) => i.kind)).toEqual(['fence', 'code', 'code', 'fence', 'text']);
  });

  it('records the bullet length of list items and the heading level', () => {
    expect(classifyLines(['  - item'])[0]).toEqual({ kind: 'list', marker: 3 });
    expect(classifyLines(['### h'])[0]).toEqual({ kind: 'heading', level: 3 });
  });
});

describe('cellStyle', () => {
  it('headings are bold, code is dim, bullets are coloured', () => {
    expect(cellStyle({ kind: 'heading', level: 1 }, 0, null)).toMatchObject({ bold: true });
    expect(cellStyle({ kind: 'code' }, 0, null)).toMatchObject({ dim: true });
    expect(cellStyle({ kind: 'list', marker: 2 }, 0, null)).toHaveProperty('fg');
    expect(cellStyle({ kind: 'list', marker: 2 }, 2, null)).toBeNull();
    expect(cellStyle({ kind: 'text' }, 0, null)).toBeNull();
  });
  it('inline code spans get their own colour', () => {
    const spans = inlineCodeSpans('see `x.y()` now');
    expect(spans).toEqual([[4, 11]]);
    expect(cellStyle({ kind: 'text' }, 5, spans)).toHaveProperty('fg');
    expect(cellStyle({ kind: 'text' }, 1, spans)).toBeNull();
    expect(inlineCodeSpans('plain')).toBeNull();
  });
});
