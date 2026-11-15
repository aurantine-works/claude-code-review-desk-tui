import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createFilteredStdin, createBus } from '../../src/tui/mouse/filteredStdin.js';

const ESC = '\x1b';

/** A stand-in for process.stdin. */
function fakeReal({ isTTY = true } = {}) {
  const real = new EventEmitter();
  real.isTTY = isTTY;
  real.setRawMode = vi.fn();
  real.ref = vi.fn();
  real.unref = vi.fn();
  real.pause = vi.fn();
  real.resume = vi.fn();
  return real;
}

/** Collect everything the filtered stream yields, reading the way Ink does ('readable' + read()). */
function inkReader(stdin) {
  const chunks = [];
  const onReadable = () => {
    let c;
    while ((c = stdin.read()) !== null) chunks.push(c);
  };
  stdin.setEncoding('utf8');
  stdin.addListener('readable', onReadable);
  return {
    chunks,
    text: () => chunks.join(''),
    stop: () => stdin.removeListener('readable', onReadable),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

let toDispose = [];
function make(opts) {
  const real = fakeReal();
  const bus = createBus();
  const events = [];
  bus.on('mouse', (e) => events.push(['mouse', e]));
  bus.on('paste', (t) => events.push(['paste', t]));
  const stdin = createFilteredStdin(real, bus, opts);
  toDispose.push(stdin);
  return { real, bus, events, stdin };
}
afterEach(() => {
  vi.useRealTimers();
  toDispose.forEach((s) => s.dispose());
  toDispose = [];
});

describe('createFilteredStdin: Ink-facing interface', () => {
  it('forwards isTTY and the raw-mode / ref / unref calls', () => {
    const { real, stdin } = make();
    expect(stdin.isTTY).toBe(true);
    expect(typeof stdin.setRawMode).toBe('function');
    stdin.setRawMode(true);
    stdin.ref();
    stdin.unref();
    stdin.setRawMode(false);
    expect(real.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(real.ref).toHaveBeenCalledTimes(1);
    expect(real.unref).toHaveBeenCalledTimes(1);
    const nonTty = createFilteredStdin(fakeReal({ isTTY: false }), createBus());
    expect(nonTty.isTTY).toBe(false);
    nonTty.dispose();
  });

  it('only reads the real stdin while somebody listens (Ink attaches / detaches a readable listener)', () => {
    const { real, stdin } = make();
    expect(real.listenerCount('data')).toBe(0);
    const reader = inkReader(stdin);
    expect(real.listenerCount('data')).toBe(1);
    expect(real.resume).toHaveBeenCalled();
    reader.stop();
    expect(real.listenerCount('data')).toBe(0);
    expect(real.pause).toHaveBeenCalled();
    inkReader(stdin);
    expect(real.listenerCount('data')).toBe(1);
  });

  it('delivers text as strings through read() and supports a plain data listener', async () => {
    const { real, stdin } = make();
    const got = [];
    stdin.on('data', (d) => got.push(d));
    real.emit('data', Buffer.from('hello'));
    await tick();
    expect(got.join('')).toBe('hello');
    expect(typeof got[0]).toBe('string');
  });

  it('dispose() detaches from the real stdin without touching it', () => {
    const { real, stdin } = make();
    inkReader(stdin);
    stdin.dispose();
    expect(real.listenerCount('data')).toBe(0);
    expect(real.destroy).toBeUndefined();
    expect(stdin.destroyed).toBe(true);
  });
});

describe('createFilteredStdin: routing', () => {
  it('sends text to the stream and mouse / paste events to the bus, in order', async () => {
    const { real, stdin, events } = make();
    const r = inkReader(stdin);
    real.emit('data', Buffer.from(`ab${ESC}[<0;10;5Mcd${ESC}[200~x\ny${ESC}[201~ef${ESC}[<65;1;1M`));
    await tick();
    expect(r.text()).toBe('abcdef');
    expect(events).toEqual([
      ['mouse', expect.objectContaining({ kind: 'press', button: 'left', x: 9, y: 4 })],
      ['paste', 'x\ny'],
      ['mouse', expect.objectContaining({ kind: 'wheel', button: 'wheelDown' })],
    ]);
  });

  it('works without a bus (events are dropped)', async () => {
    const real = fakeReal();
    const stdin = createFilteredStdin(real);
    const r = inkReader(stdin);
    real.emit('data', Buffer.from(`a${ESC}[<0;1;1Mb`));
    await tick();
    expect(r.text()).toBe('ab');
    stdin.dispose();
  });

  it('reassembles a mouse report split across data events', async () => {
    const { real, stdin, events } = make();
    const r = inkReader(stdin);
    for (const part of [`x${ESC}`, '[<', '0;3', ';4M', 'y']) {
      real.emit('data', Buffer.from(part));
      await tick();
    }
    expect(r.text()).toBe('xy');
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({ x: 2, y: 3 });
  });

  it('passes escape sequences meant for Ink (arrows, Alt+Enter) through unchanged', async () => {
    const { real, stdin } = make();
    const r = inkReader(stdin);
    real.emit('data', Buffer.from(`${ESC}[A${ESC}\r\n\x7f`));
    await tick();
    expect(r.text()).toBe(`${ESC}[A${ESC}\r\n\x7f`);
  });
});

describe('createFilteredStdin: UTF-8 decoding', () => {
  const text = 'a你好b😀c';
  const bytes = Buffer.from(text, 'utf8');

  it('never garbles a multi-byte character split at any byte boundary', async () => {
    for (let i = 0; i <= bytes.length; i++) {
      const { real, stdin } = make();
      const r = inkReader(stdin);
      real.emit('data', bytes.subarray(0, i));
      real.emit('data', bytes.subarray(i));
      await tick();
      expect(r.text()).toBe(text);
      stdin.dispose();
    }
  });

  it('survives byte-by-byte delivery and a paste whose text is split mid-character', async () => {
    const { real, stdin, events } = make();
    const r = inkReader(stdin);
    const all = Buffer.from(`${ESC}[200~粘贴😀内容${ESC}[201~尾`, 'utf8');
    for (const b of all) real.emit('data', Buffer.from([b]));
    await tick();
    expect(events).toEqual([['paste', '粘贴😀内容']]);
    expect(r.text()).toBe('尾');
  });

  it('accepts string chunks if someone set an encoding on the real stdin', async () => {
    const { real, stdin } = make();
    const r = inkReader(stdin);
    real.emit('data', '你好');
    await tick();
    expect(r.text()).toBe('你好');
  });
});

describe('createFilteredStdin: Esc handling and timers', () => {
  it('releases a lone ESC after the timeout, not before', async () => {
    vi.useFakeTimers();
    const { real, stdin } = make({ escTimeoutMs: 25 });
    const r = inkReader(stdin);
    real.emit('data', Buffer.from(ESC));
    await vi.advanceTimersByTimeAsync(20);
    expect(r.text()).toBe('');
    await vi.advanceTimersByTimeAsync(10);
    expect(r.text()).toBe(ESC);
  });

  it('joins ESC and CR arriving in separate chunks within the timeout (Alt+Enter)', async () => {
    vi.useFakeTimers();
    const { real, stdin } = make({ escTimeoutMs: 25 });
    const r = inkReader(stdin);
    real.emit('data', Buffer.from(ESC));
    await vi.advanceTimersByTimeAsync(10);
    real.emit('data', Buffer.from('\r'));
    await vi.advanceTimersByTimeAsync(50);
    expect(r.chunks).toEqual([`${ESC}\r`]);
  });

  it('does not release an open paste on the Esc timer, but forces it after the paste timeout', async () => {
    vi.useFakeTimers();
    const { real, stdin, events } = make({ escTimeoutMs: 25, pasteTimeoutMs: 1000 });
    inkReader(stdin);
    real.emit('data', Buffer.from(`${ESC}[200~partial`));
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual([]);
    real.emit('data', Buffer.from(' more'));
    await vi.advanceTimersByTimeAsync(900);
    expect(events).toEqual([]); // the idle timer restarted with the second chunk
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual([['paste', 'partial more']]);
  });

  it('its timers are unref()ed so they never keep the process alive', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const { real, stdin } = make();
      inkReader(stdin);
      real.emit('data', Buffer.from(ESC));
      const timers = spy.mock.results.map((r) => r.value).filter((t) => t && typeof t.hasRef === 'function');
      expect(timers.length).toBeGreaterThan(0);
      expect(timers.every((t) => t.hasRef() === false)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createFilteredStdin: suspendInput (external editor without Ink)', () => {
  it('detaches, leaves raw mode and re-attaches on resume', () => {
    const { real, stdin } = make();
    inkReader(stdin);
    stdin.setRawMode(true);
    expect(real.listenerCount('data')).toBe(1);
    const resume = stdin.suspendInput();
    expect(real.listenerCount('data')).toBe(0);
    expect(real.setRawMode).toHaveBeenLastCalledWith(false);
    expect(real.unref).toHaveBeenCalled();
    resume();
    expect(real.listenerCount('data')).toBe(1);
    expect(real.setRawMode).toHaveBeenLastCalledWith(true);
    expect(real.ref).toHaveBeenCalled();
  });

  it('drops a half-received sequence when input is detached', async () => {
    const { real, stdin, events } = make();
    const r = inkReader(stdin);
    real.emit('data', Buffer.from(`${ESC}[<0;1`));
    const resume = stdin.suspendInput();
    resume();
    real.emit('data', Buffer.from('M'));
    await tick();
    expect(r.text()).toBe('M');
    expect(events).toEqual([]);
  });
});
