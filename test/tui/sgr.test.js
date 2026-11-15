import { describe, it, expect } from 'vitest';
import { createInputParser, decodeSgrMouse } from '../../src/tui/mouse/sgr.js';

const ESC = '\x1b';
const sgr = (cb, x, y, final = 'M') => `${ESC}[<${cb};${x};${y}${final}`;

/** Merge adjacent text events so different chunkings compare equal. */
function normalize(events) {
  const out = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (e.type === 'text' && prev?.type === 'text') prev.data += e.data;
    else out.push({ ...e });
  }
  return out;
}

/** Feed `chunks` one by one and flush at the end (like the Esc timer would). */
function run(chunks) {
  const p = createInputParser();
  const events = [];
  for (const c of chunks) events.push(...p.feed(c));
  events.push(...p.flush());
  return normalize(events);
}

const mouse = (over) => ({
  type: 'mouse',
  button: 'left',
  x: 0,
  y: 0,
  kind: 'press',
  shift: false,
  meta: false,
  ctrl: false,
  ...over,
});

describe('createInputParser: mouse', () => {
  it('decodes press / release with 0-based coordinates', () => {
    expect(run([sgr(0, 10, 5)])).toEqual([mouse({ x: 9, y: 4 })]);
    expect(run([sgr(0, 1, 1, 'm')])).toEqual([mouse({ kind: 'release' })]);
    expect(run([sgr(2, 3, 4)])).toEqual([mouse({ button: 'right', x: 2, y: 3 })]);
    expect(run([sgr(1, 3, 4)])).toEqual([mouse({ button: 'middle', x: 2, y: 3 })]);
  });

  it('decodes wheel up/down/left/right', () => {
    expect(run([sgr(64, 5, 5)])[0]).toMatchObject({ kind: 'wheel', button: 'wheelUp' });
    expect(run([sgr(65, 5, 5)])[0]).toMatchObject({ kind: 'wheel', button: 'wheelDown' });
    expect(run([sgr(66, 5, 5)])[0]).toMatchObject({ kind: 'wheel', button: 'wheelLeft' });
    expect(run([sgr(67, 5, 5)])[0]).toMatchObject({ kind: 'wheel', button: 'wheelRight' });
  });

  it('decodes drag (motion bit) with the held button', () => {
    expect(run([sgr(32, 7, 2)])).toEqual([mouse({ kind: 'drag', x: 6, y: 1 })]);
    expect(run([sgr(34, 7, 2)])[0]).toMatchObject({ kind: 'drag', button: 'right' });
    expect(run([sgr(35, 7, 2)])[0]).toMatchObject({ kind: 'move', button: 'none' });
  });

  it('decodes modifier bits (shift 4, meta 8, ctrl 16), also on wheel', () => {
    expect(run([sgr(4, 1, 1)])[0]).toMatchObject({ shift: true, meta: false, ctrl: false });
    expect(run([sgr(8, 1, 1)])[0]).toMatchObject({ shift: false, meta: true, ctrl: false });
    expect(run([sgr(16, 1, 1)])[0]).toMatchObject({ shift: false, meta: false, ctrl: true });
    expect(run([sgr(64 + 4 + 16, 1, 1)])[0]).toMatchObject({ kind: 'wheel', shift: true, ctrl: true, meta: false });
  });

  it('keeps large coordinates and clamps zero to 0', () => {
    expect(run([sgr(0, 250, 120)])[0]).toMatchObject({ x: 249, y: 119 });
    expect(decodeSgrMouse(0, 0, 0, 'M')).toMatchObject({ x: 0, y: 0 });
  });

  it('handles several events and interleaved text in one chunk, in order', () => {
    const input = `ab${sgr(0, 2, 2)}cd${sgr(0, 3, 2, 'm')}${sgr(64, 1, 1)}ef`;
    expect(run([input])).toEqual([
      { type: 'text', data: 'ab' },
      mouse({ x: 1, y: 1 }),
      { type: 'text', data: 'cd' },
      mouse({ x: 2, y: 1, kind: 'release' }),
      mouse({ kind: 'wheel', button: 'wheelUp' }),
      { type: 'text', data: 'ef' },
    ]);
  });

  it('survives being cut at ANY position', () => {
    const input = `x${sgr(0, 12, 34)}y${sgr(65, 100, 7)}${sgr(32, 5, 5)}z${sgr(0, 12, 34, 'm')}`;
    const expected = run([input]);
    expect(expected.filter((e) => e.type === 'mouse')).toHaveLength(4);
    for (let i = 0; i <= input.length; i++) {
      expect(run([input.slice(0, i), input.slice(i)])).toEqual(expected);
    }
  });

  it('survives every three-way split and character-by-character delivery', () => {
    const input = `a${sgr(0, 12, 34)}${ESC}[200~p${ESC}[<0;1;1M${ESC}[201~${sgr(64, 3, 3)}b`;
    const expected = run([input]);
    expect(run([...input])).toEqual(expected);
    for (let i = 0; i <= input.length; i++) {
      for (let j = i; j <= input.length; j++) {
        expect(run([input.slice(0, i), input.slice(i, j), input.slice(j)])).toEqual(expected);
      }
    }
  });

  it('does not treat a non-mouse CSI-< sequence as a mouse report', () => {
    expect(run([`${ESC}[<abc`])).toEqual([{ type: 'text', data: `${ESC}[<abc` }]);
  });
});

describe('createInputParser: pass-through and Esc', () => {
  it('passes plain text and other escape sequences through verbatim', () => {
    const arrows = `${ESC}[A${ESC}[1;5C${ESC}OP${ESC}[3~`;
    expect(run([`hello ${arrows} world`])).toEqual([{ type: 'text', data: `hello ${arrows} world` }]);
  });

  it('passes Alt+Enter (ESC CR), Ctrl+J, CR, Ctrl+C, Alt+letter and CJK text unchanged', () => {
    const s = `${ESC}\r\n\r\x03${ESC}x你好`;
    expect(run([s])).toEqual([{ type: 'text', data: s }]);
  });

  it('does not delay ESC followed by a non-sequence byte (Alt+Enter in one chunk)', () => {
    const p = createInputParser();
    expect(p.feed(`${ESC}\r`)).toEqual([{ type: 'text', data: `${ESC}\r` }]);
    expect(p.hasPendingEscape()).toBe(false);
  });

  it('holds a lone ESC and releases it on flush() (the Esc key)', () => {
    const p = createInputParser();
    expect(p.feed(ESC)).toEqual([]);
    expect(p.hasPendingEscape()).toBe(true);
    expect(p.flush()).toEqual([{ type: 'text', data: ESC }]);
    expect(p.hasPendingEscape()).toBe(false);
    expect(p.flush()).toEqual([]);
  });

  it('holds "ESC [" and a half mouse report, and flush() releases them as text', () => {
    const p = createInputParser();
    expect(p.feed(`${ESC}[`)).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'text', data: `${ESC}[` }]);
    expect(p.feed(`${ESC}[<0;1`)).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'text', data: `${ESC}[<0;1` }]);
  });

  it('joins a held ESC with the next chunk (Alt+Enter split by SSH)', () => {
    const p = createInputParser();
    expect(p.feed(ESC)).toEqual([]);
    expect(p.feed('\r')).toEqual([{ type: 'text', data: `${ESC}\r` }]);
  });

  it('emits text before a held escape immediately', () => {
    const p = createInputParser();
    expect(p.feed(`ab${ESC}`)).toEqual([{ type: 'text', data: 'ab' }]);
    expect(p.hasPendingEscape()).toBe(true);
  });

  it('reset() drops buffered state', () => {
    const p = createInputParser();
    p.feed(`${ESC}[200~abc`);
    p.reset();
    expect(p.isPasting()).toBe(false);
    expect(p.feed('x')).toEqual([{ type: 'text', data: 'x' }]);
  });
});

describe('createInputParser: bracketed paste', () => {
  it('emits one paste event for ESC[200~ ... ESC[201~', () => {
    expect(run([`a${ESC}[200~hello\nworld${ESC}[201~b`])).toEqual([
      { type: 'text', data: 'a' },
      { type: 'paste', text: 'hello\nworld' },
      { type: 'text', data: 'b' },
    ]);
  });

  it('keeps CR/CRLF/tab/ESC and mouse-looking bytes inside the paste untouched', () => {
    const body = `l1\r\nl2\r\tx${sgr(0, 5, 5)}${ESC}[A`;
    expect(run([`${ESC}[200~${body}${ESC}[201~`])).toEqual([{ type: 'paste', text: body }]);
  });

  it('assembles a paste delivered over many chunks, even with a split end marker', () => {
    const input = `${ESC}[200~first line\nsecond ${sgr(0, 1, 1)} line${ESC}[201~tail`;
    const expected = [
      { type: 'paste', text: `first line\nsecond ${sgr(0, 1, 1)} line` },
      { type: 'text', data: 'tail' },
    ];
    expect(run([...input])).toEqual(expected);
    for (let i = 0; i <= input.length; i++) {
      expect(run([input.slice(0, i), input.slice(i)])).toEqual(expected);
    }
  });

  it('supports an empty paste and back-to-back pastes', () => {
    expect(run([`${ESC}[200~${ESC}[201~${ESC}[200~x${ESC}[201~`])).toEqual([
      { type: 'paste', text: '' },
      { type: 'paste', text: 'x' },
    ]);
  });

  it('flush() leaves an open paste alone, flush({force}) emits what was collected', () => {
    const p = createInputParser();
    expect(p.feed(`${ESC}[200~partial`)).toEqual([]);
    expect(p.isPasting()).toBe(true);
    expect(p.hasPendingEscape()).toBe(false);
    expect(p.flush()).toEqual([]);
    expect(p.isPasting()).toBe(true);
    expect(p.flush({ force: true })).toEqual([{ type: 'paste', text: 'partial' }]);
    expect(p.isPasting()).toBe(false);
    expect(p.feed('after')).toEqual([{ type: 'text', data: 'after' }]);
  });

  it('drops a stray paste-end marker', () => {
    expect(run([`a${ESC}[201~b`])).toEqual([{ type: 'text', data: 'ab' }]);
  });
});
