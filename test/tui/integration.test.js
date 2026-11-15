import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { MultiLineInput } from '../../src/tui/input/MultiLineInput.js';
import { createFilteredStdin, createBus } from '../../src/tui/mouse/filteredStdin.js';

const h = React.createElement;
const ESC = '\x1b';
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Fake TTY stdin: bytes in, with the surface Ink needs. */
function fakeRealStdin() {
  const s = new EventEmitter();
  Object.assign(s, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn(), pause: vi.fn(), resume: vi.fn() });
  return s;
}
function fakeStdout() {
  const s = new EventEmitter();
  s.columns = 80;
  s.rows = 24;
  s.frames = [];
  s.write = (f) => {
    s.frames.push(f);
  };
  return s;
}

let live = [];
afterEach(() => {
  for (const fn of live.splice(0)) fn();
});

function boot(props = {}) {
  const real = fakeRealStdin();
  const bus = createBus();
  const stdin = createFilteredStdin(real, bus);
  const stdout = fakeStdout();
  const calls = { submit: [], change: [], cancel: [] };
  const mouse = [];
  bus.on('mouse', (e) => mouse.push(e));
  const app = render(
    h(MultiLineInput, {
      width: 30,
      bus,
      onSubmit: (t) => calls.submit.push(t),
      onChange: (t) => calls.change.push(t),
      onCancel: (c) => calls.cancel.push(c),
      ...props,
    }),
    { stdin, stdout, stderr: fakeStdout(), debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  live.push(() => {
    app.unmount();
    stdin.dispose();
  });
  const send = async (data) => {
    real.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
    await wait();
  };
  return { real, bus, stdin, calls, mouse, send, app };
}

describe('filtered stdin + Ink + MultiLineInput (end to end)', () => {
  it('puts the real stdin into raw mode through the filter and releases it on unmount', async () => {
    const { real, stdin, app } = boot();
    await wait();
    expect(real.setRawMode).toHaveBeenCalledWith(true);
    expect(real.listenerCount('data')).toBe(1);
    app.unmount();
    await wait();
    expect(real.setRawMode).toHaveBeenLastCalledWith(false);
    expect(real.unref).toHaveBeenCalled();
    expect(real.listenerCount('data')).toBe(0);
    stdin.dispose();
  });

  it('types, wheels and clicks (ignored by the editor), pastes and submits', async () => {
    const { calls, mouse, send } = boot();
    await send('hi ');
    await send(`${ESC}[<0;12;3M${ESC}[<0;12;3m${ESC}[<64;5;5M`); // click + release + wheel up
    await send('世界');
    await send(`${ESC}[200~line A\nline B${ESC}[201~`);
    await send('!');
    expect(calls.change.at(-1)).toBe('hi 世界line A\nline B!');
    expect(calls.submit).toEqual([]);
    expect(mouse.map((m) => [m.kind, m.x, m.y])).toEqual([['press', 11, 2], ['release', 11, 2], ['wheel', 4, 4]]);
    await send('\r');
    expect(calls.submit).toEqual(['hi 世界line A\nline B!']);
  });

  it('handles Alt+Enter split across two TCP segments, and a UTF-8 character split mid-byte', async () => {
    const { calls, send } = boot();
    await send('a');
    await send(ESC); // lone ESC held by the filter...
    await send('\r'); // ...then CR: Alt+Enter
    const euro = Buffer.from('你', 'utf8');
    await send(euro.subarray(0, 1));
    await send(euro.subarray(1));
    expect(calls.submit).toEqual([]);
    expect(calls.change.at(-1)).toBe('a\n你');
  });

  it('delivers Esc to the editor as a cancel', async () => {
    const { calls, send } = boot();
    await send('x');
    await send(ESC);
    await wait(80); // filter timeout + Ink pending-escape flush
    expect(calls.cancel).toEqual([true]);
  });

  it('a mouse report cut in the middle never leaks characters into the text', async () => {
    const { calls, send, mouse } = boot();
    await send('a');
    for (const part of [ESC, '[<0;1', '0;2', '0M']) await send(part);
    await send('b');
    expect(calls.change.at(-1)).toBe('ab');
    expect(mouse).toHaveLength(1);
    expect(mouse[0]).toMatchObject({ x: 9, y: 19 });
  });

  it('Ctrl+J newline; Ctrl+C is a cancel request, never text', async () => {
    const { calls, send } = boot();
    await send('a');
    await send('\n'); // Ctrl+J
    await send('b');
    expect(calls.submit).toEqual([]);
    expect(calls.change.at(-1)).toBe('a\nb');
    await send('\x03'); // exitOnCtrlC is false here (as in run.js): the editor asks its parent, it does not insert
    expect(calls.change.at(-1)).toBe('a\nb');
    expect(calls.cancel).toEqual([true]);
  });
});
