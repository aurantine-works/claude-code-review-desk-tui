import { vi } from 'vitest';

// Make chalk emit ANSI so the inverse-video caret is visible in frames.
vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});

import { describe, it, expect, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, cleanup } from 'ink-testing-library';
import { MultiLineInput, inputHeight } from '../../src/tui/input/MultiLineInput.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';

const h = React.createElement;
const ESC = '\x1b';
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** Show the caret as [x] and drop other styling; returns the frame's lines. */
function lines(frame) {
  // eslint-disable-next-line no-control-regex
  return frame.replace(/\x1b\[7m([^\x1b]*)\x1b\[27m/g, '[$1]').split('\n').map(strip);
}

function setup(props = {}) {
  const calls = { submit: [], cancel: [], change: [], edit: [] };
  const bus = createBus();
  const el = (extra = {}) =>
    h(MultiLineInput, {
      width: 20,
      bus,
      onSubmit: (t) => calls.submit.push(t),
      onCancel: (c) => calls.cancel.push(c),
      onChange: (t) => calls.change.push(t),
      onEditExternal: (t) => calls.edit.push(t),
      ...props,
      ...extra,
    });
  const app = render(el());
  const press = async (s) => {
    app.stdin.write(s);
    await wait();
  };
  return { app, calls, bus, press, el, frame: () => lines(app.lastFrame()) };
}

afterEach(() => cleanup());

describe('MultiLineInput: keys', () => {
  it('Enter submits the text (CR)', async () => {
    const { calls, press } = setup();
    await press('hello');
    await press('\r');
    expect(calls.submit).toEqual(['hello']);
    expect(calls.change.at(-1)).toBe('hello');
  });

  it('Enter on blank text does not submit', async () => {
    const { calls, press } = setup();
    await press('\r');
    await press('  ');
    await press('\r');
    expect(calls.submit).toEqual([]);
  });

  it('Alt+Enter (ESC CR) inserts a newline instead of submitting', async () => {
    const { calls, press, frame } = setup();
    await press('ab');
    await press(`${ESC}\r`);
    await press('cd');
    expect(calls.submit).toEqual([]);
    expect(calls.change.at(-1)).toBe('ab\ncd');
    expect(frame()).toEqual(['ab', 'cd[ ]']);
  });

  it('Ctrl+J (LF) inserts a newline', async () => {
    const { calls, press } = setup();
    await press('ab');
    await press('\n');
    await press('cd');
    expect(calls.submit).toEqual([]);
    expect(calls.change.at(-1)).toBe('ab\ncd');
    await press('\r');
    expect(calls.submit).toEqual(['ab\ncd']);
  });

  it('Esc reports whether there is content (after Ink flushes the lone ESC)', async () => {
    const { calls, press } = setup();
    await press(ESC);
    await wait(60);
    expect(calls.cancel).toEqual([false]);
    await press('x');
    await press(ESC);
    await wait(60);
    expect(calls.cancel).toEqual([false, true]);
  });

  it('Ctrl+C cancels like Esc and inserts nothing (Ink no longer quits on it)', async () => {
    const { calls, press } = setup();
    await press('\x03');
    expect(calls.cancel).toEqual([false]);
    await press('keep me');
    await press('\x03');
    expect(calls.cancel).toEqual([false, true]);
    expect(calls.change.at(-1)).toBe('keep me');
  });

  it('Ctrl+E asks the parent for the external editor with the current text', async () => {
    const { calls, press } = setup();
    await press('draft');
    await press('\x05');
    expect(calls.edit).toEqual(['draft']);
    expect(calls.change.at(-1)).toBe('draft'); // Ctrl+E must not insert anything
  });

  it('ignores other control keys', async () => {
    const { calls, press } = setup();
    await press('a');
    await press('\x01'); // Ctrl+A
    await press('\x18'); // Ctrl+X
    await press(`${ESC}x`); // Alt+x
    await press('\t');
    expect(calls.change.at(-1)).toBe('a');
  });
});

describe('MultiLineInput: editing', () => {
  it('inserts Chinese text delivered as one chunk (IME commit) and shows the caret after it', async () => {
    const { calls, press, frame } = setup();
    await press('你好，世界');
    expect(calls.change.at(-1)).toBe('你好，世界');
    expect(frame()).toEqual(['你好，世界[ ]']);
  });

  it('backspace removes whole graphemes (emoji ZWJ, combining) and CJK chars', async () => {
    const { calls, press } = setup();
    await press('a👨‍👩‍👧');
    await press('é');
    await press('你');
    await press('\x7f');
    expect(calls.change.at(-1)).toBe('a👨‍👩‍👧é');
    await press('\x7f');
    expect(calls.change.at(-1)).toBe('a👨‍👩‍👧');
    await press('\x7f');
    expect(calls.change.at(-1)).toBe('a');
    await press('\b'); // Ctrl+H style backspace
    expect(calls.change.at(-1)).toBe('');
  });

  it('arrow keys, Home/End and Delete work', async () => {
    const { calls, press, frame } = setup();
    await press('abcd');
    await press(`${ESC}[D`);
    await press(`${ESC}[D`);
    await press('X');
    expect(calls.change.at(-1)).toBe('abXcd');
    await press(`${ESC}[3~`); // Delete removes 'c'
    expect(calls.change.at(-1)).toBe('abXd');
    await press(`${ESC}[H`);
    expect(frame()).toEqual(['[a]bXd']);
    await press(`${ESC}[F`);
    expect(frame()).toEqual(['abXd[ ]']);
  });

  it('Up / Down move between rows keeping the column', async () => {
    const { calls, press, frame } = setup();
    await press('hello');
    await press('\n');
    await press('hi');
    await press(`${ESC}[A`);
    expect(frame()).toEqual(['he[l]lo', 'hi']);
    await press('Z');
    expect(calls.change.at(-1)).toBe('heZllo\nhi');
    await press(`${ESC}[B`);
    await press(`${ESC}[B`); // already on the last row: no-op
    await press('!');
    expect(calls.change.at(-1)).toBe('heZllo\nhi!');
  });

  it('treats a multi-character chunk containing CR/LF (unbracketed paste) as text with newlines, never submit', async () => {
    const { calls, press } = setup();
    await press('line1\rline2\r\nline3');
    expect(calls.submit).toEqual([]);
    expect(calls.change.at(-1)).toBe('line1\nline2\nline3');
  });

  it('wraps long text at width-1 columns and keeps a free column for the caret', async () => {
    const { press, frame } = setup({ width: 6 });
    await press('abcdefghij');
    expect(frame()).toEqual(['abcde', 'fghij[ ]']);
  });

  it('wraps Chinese text by display width', async () => {
    const { press, frame } = setup({ width: 7 }); // 6 text columns = 3 chars
    await press('你好世界再');
    expect(frame()).toEqual(['你好世', '界再[ ]']);
  });
});

describe('MultiLineInput: paste via the bus', () => {
  it('inserts pasted text with newlines as newlines and does not submit', async () => {
    const { calls, press, bus, frame } = setup();
    await press('A');
    bus.emit('paste', 'one\r\ntwo\nthree\r');
    await wait();
    expect(calls.submit).toEqual([]);
    expect(calls.change.at(-1)).toBe('Aone\ntwo\nthree\n');
    expect(frame()).toEqual(['Aone', 'two', 'three', '[ ]']);
    await press('\r');
    expect(calls.submit).toEqual(['Aone\ntwo\nthree\n']);
  });

  it('pasted hotkey-looking text is just text; escape sequences and control bytes are stripped', async () => {
    const { calls, bus } = setup();
    bus.emit('paste', 'q\x1b[A\x03jk');
    await wait();
    expect(calls.change.at(-1)).toBe('qjk');
    expect(calls.submit).toEqual([]);
    expect(calls.cancel).toEqual([]);
  });

  it('ignores paste while inactive', async () => {
    const { calls, bus } = setup({ isActive: false });
    bus.emit('paste', 'nope');
    await wait();
    expect(calls.change).toEqual([]);
  });

  it('stops listening after unmount', async () => {
    const { app, bus } = setup();
    expect(bus.listenerCount('paste')).toBe(1);
    app.unmount();
    expect(bus.listenerCount('paste')).toBe(0);
  });
});

describe('MultiLineInput: value prop', () => {
  it('starts from the initial value with the caret at the end', async () => {
    const { calls, press, frame } = setup({ value: 'seed' });
    expect(frame()).toEqual(['seed[ ]']);
    await press('!');
    expect(calls.change.at(-1)).toBe('seed!');
  });

  it('replaces the text when the parent changes value (result of $EDITOR)', async () => {
    const { app, el, calls, press, frame } = setup({ value: 'old' });
    await press('x');
    app.rerender(el({ value: 'edited\nin editor' }));
    await wait();
    expect(frame()).toEqual(['edited', 'in editor[ ]']);
    await press('!');
    expect(calls.change.at(-1)).toBe('edited\nin editor!');
  });

  it('does not reset on echoes of its own onChange, even for fast typing', async () => {
    let seen = [];
    function Controlled() {
      const [v, setV] = useState('');
      return h(MultiLineInput, {
        width: 20,
        value: v,
        onChange: (t) => {
          seen.push(t);
          setV(t);
        },
      });
    }
    const app = render(h(Controlled));
    app.stdin.write('a');
    app.stdin.write('b');
    app.stdin.write('c');
    await wait(30);
    app.stdin.write('d');
    await wait(30);
    expect(seen).toEqual(['a', 'ab', 'abc', 'abcd']);
    expect(lines(app.lastFrame())).toEqual(['abcd[ ]']);
  });

  it('shows a placeholder while empty', () => {
    const { frame } = setup({ placeholder: 'Write a comment' });
    expect(frame()).toEqual(['[ ]Write a comment']);
  });
});

describe('MultiLineInput: height and scrolling', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');

  it('grows with content up to maxRows, then scrolls to keep the caret visible', async () => {
    const { press, frame } = setup({ maxRows: 3 });
    await press('a');
    expect(frame()).toHaveLength(1);
    await press('\n');
    await press('b');
    await press('\n');
    await press('c');
    expect(frame()).toEqual(['a', 'b', 'c[ ]']);
    await press('\n');
    await press('d');
    expect(frame()).toEqual(['b', 'c', 'd[ ]']);
  });

  it('scrolls back up when the caret moves above the window', async () => {
    const { press, frame } = setup({ value: twelve, maxRows: 3 });
    expect(frame()).toEqual(['line10', 'line11', 'line12[ ]']);
    for (let i = 0; i < 3; i++) await press(`${ESC}[A`);
    expect(frame().map((l) => l.replace(/\[|\]/g, '').trim())).toEqual(['line9', 'line10', 'line11']);
    for (let i = 0; i < 8; i++) await press(`${ESC}[A`);
    expect(frame().map((l) => l.replace(/\[|\]/g, '').trim())).toEqual(['line1', 'line2', 'line3']);
  });

  it('inputHeight mirrors the rendered height', () => {
    expect(inputHeight('', 20)).toBe(1);
    expect(inputHeight('a\nb', 20)).toBe(2);
    expect(inputHeight(twelve, 20)).toBe(8);
    expect(inputHeight(twelve, 20, 5)).toBe(5);
    expect(inputHeight('abcdefghij', 6)).toBe(2);
  });
});

describe('MultiLineInput: inactive', () => {
  it('ignores keys and hides the caret when isActive is false', async () => {
    const { calls, press, frame } = setup({ isActive: false, value: 'frozen' });
    await press('x');
    await press('\r');
    expect(calls.change).toEqual([]);
    expect(calls.submit).toEqual([]);
    expect(frame()).toEqual(['frozen']);
  });
});
