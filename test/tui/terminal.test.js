import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SEQ,
  enableMouse,
  disableMouse,
  enablePaste,
  disablePaste,
  isMouseEnabled,
  isPasteEnabled,
  bell,
  restoreTerminal,
  installCleanup,
  suspendForEditor,
} from '../../src/tui/terminal.js';
import { editExternally } from '../../src/tui/input/externalEditor.js';

function fakeOut({ isTTY = true } = {}) {
  const writes = [];
  return { isTTY, writes, write: (s) => writes.push(s), destroyed: false };
}

beforeEach(() => {
  const o = fakeOut();
  disableMouse(o);
  disablePaste(o);
});

describe('terminal mode sequences', () => {
  it('writes the documented sequences', () => {
    expect(SEQ.MOUSE_ON).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    expect(SEQ.MOUSE_OFF).toBe('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
    expect(SEQ.PASTE_ON).toBe('\x1b[?2004h');
    expect(SEQ.PASTE_OFF).toBe('\x1b[?2004l');
    const o = fakeOut();
    enableMouse(o);
    enablePaste(o);
    bell(o);
    disableMouse(o);
    disablePaste(o);
    expect(o.writes).toEqual([SEQ.MOUSE_ON, SEQ.PASTE_ON, '\x07', SEQ.MOUSE_OFF, SEQ.PASTE_OFF]);
  });

  it('tracks which modes are on', () => {
    const o = fakeOut();
    expect([isMouseEnabled(), isPasteEnabled()]).toEqual([false, false]);
    enableMouse(o);
    expect([isMouseEnabled(), isPasteEnabled()]).toEqual([true, false]);
    enablePaste(o);
    disableMouse(o);
    expect([isMouseEnabled(), isPasteEnabled()]).toEqual([false, true]);
  });

  it('writes nothing to a non-TTY stream and survives write errors', () => {
    const piped = fakeOut({ isTTY: false });
    enableMouse(piped);
    enablePaste(piped);
    bell(piped);
    expect(piped.writes).toEqual([]);
    expect(isMouseEnabled()).toBe(false);
    const broken = { isTTY: true, write: () => { throw new Error('EIO'); } };
    expect(() => { enableMouse(broken); restoreTerminal(broken); }).not.toThrow();
  });

  it('restoreTerminal turns everything off and shows the cursor', () => {
    const o = fakeOut();
    restoreTerminal(o, 'X');
    expect(o.writes).toEqual([SEQ.MOUSE_OFF, SEQ.PASTE_OFF, `${SEQ.CURSOR_SHOW}X`]);
  });
});

describe('installCleanup', () => {
  function fakeProc() {
    const p = new EventEmitter();
    p.stderr = { chunks: [], write(s) { this.chunks.push(s); } };
    return p;
  }

  it('restores the terminal on exit', () => {
    const o = fakeOut();
    const proc = fakeProc();
    installCleanup({ stdout: o, proc, exit: vi.fn() });
    proc.emit('exit', 0);
    expect(o.writes).toEqual([SEQ.MOUSE_OFF, SEQ.PASTE_OFF, SEQ.CURSOR_SHOW]);
  });

  it('leaves the alternate screen when asked to', () => {
    const o = fakeOut();
    const proc = fakeProc();
    installCleanup({ stdout: o, proc, exit: vi.fn(), alternateScreen: true });
    proc.emit('exit', 0);
    expect(o.writes.at(-1)).toBe(SEQ.CURSOR_SHOW + SEQ.ALT_SCREEN_OFF);
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]])('restores and exits on %s with %i', (sig, code) => {
    const o = fakeOut();
    const proc = fakeProc();
    const exit = vi.fn();
    installCleanup({ stdout: o, proc, exit });
    proc.emit(sig);
    expect(o.writes).toContain(SEQ.MOUSE_OFF);
    expect(exit).toHaveBeenCalledWith(code);
    expect(proc.listenerCount(sig)).toBe(0); // uninstalled itself
  });

  it('restores, prints the error and exits 1 on uncaughtException', () => {
    const o = fakeOut();
    const proc = fakeProc();
    const exit = vi.fn();
    installCleanup({ stdout: o, proc, exit });
    proc.emit('uncaughtException', new Error('boom'));
    expect(o.writes).toContain(SEQ.PASTE_OFF);
    expect(proc.stderr.chunks.join('')).toContain('boom');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uninstall removes every listener', () => {
    const proc = fakeProc();
    const uninstall = installCleanup({ stdout: fakeOut(), proc, exit: vi.fn() });
    expect(proc.eventNames().length).toBeGreaterThan(3);
    uninstall();
    expect(proc.eventNames()).toEqual([]);
  });
});

describe('suspendForEditor', () => {
  it('turns mouse/paste off, runs fn, then restores what was on', async () => {
    const o = fakeOut();
    enableMouse(o);
    enablePaste(o);
    o.writes.length = 0;
    const order = [];
    const result = await suspendForEditor(
      async () => {
        order.push(...o.writes.splice(0).map((w) => `w:${w}`), 'fn');
        return 42;
      },
      { stdout: o },
    );
    expect(result).toBe(42);
    expect(order).toEqual([`w:${SEQ.MOUSE_OFF}`, `w:${SEQ.PASTE_OFF}`, 'fn']);
    expect(o.writes).toEqual([SEQ.MOUSE_ON, SEQ.PASTE_ON]);
    expect(isMouseEnabled()).toBe(true);
  });

  it('does not enable modes that were not on before', async () => {
    const o = fakeOut();
    enablePaste(o);
    o.writes.length = 0;
    await suspendForEditor(() => {}, { stdout: o });
    expect(o.writes).toEqual([SEQ.MOUSE_OFF, SEQ.PASTE_OFF, SEQ.PASTE_ON]);
  });

  it('restores even when fn throws, and resumes the filtered stdin', async () => {
    const o = fakeOut();
    enableMouse(o);
    const resume = vi.fn();
    const stdin = { suspendInput: vi.fn(() => resume) };
    await expect(suspendForEditor(() => { throw new Error('editor died'); }, { stdout: o, stdin })).rejects.toThrow('editor died');
    expect(stdin.suspendInput).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
    expect(isMouseEnabled()).toBe(true);
    expect(o.writes.at(-1)).toBe(SEQ.MOUSE_ON);
  });

  it('delegates to Ink suspendTerminal when provided and returns fn result', async () => {
    const o = fakeOut();
    enableMouse(o);
    const calls = [];
    const suspendTerminal = async (cb) => {
      calls.push('ink-suspend');
      await cb();
      calls.push('ink-resume');
    };
    const stdin = { suspendInput: vi.fn() };
    const out = await suspendForEditor(async () => { calls.push('fn'); return 'done'; }, { stdout: o, suspendTerminal, stdin });
    expect(out).toBe('done');
    expect(calls).toEqual(['ink-suspend', 'fn', 'ink-resume']);
    expect(stdin.suspendInput).not.toHaveBeenCalled();
  });
});

describe('editExternally', () => {
  function makeEditorScript(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-test-editor-'));
    const script = path.join(dir, 'ed.mjs');
    fs.writeFileSync(script, body);
    return { dir, cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` };
  }

  it('round-trips text through the editor and removes the temp dir', async () => {
    const seen = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-test-seen-'));
    const { dir, cmd } = makeEditorScript(`
      import fs from 'node:fs';
      const f = process.argv[2];
      fs.writeFileSync(${JSON.stringify(path.join(seen, 'path'))}, f);
      fs.writeFileSync(${JSON.stringify(path.join(seen, 'initial'))}, fs.readFileSync(f, 'utf8'));
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').toUpperCase() + '多行\\r\\n第二行\\n');
    `);
    try {
      const suspended = vi.fn((fn) => fn());
      const out = await editExternally("it's\nmine", { editor: cmd, suspend: suspended });
      expect(out).toBe("IT'S\nMINE\n多行\n第二行");
      expect(suspended).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(path.join(seen, 'initial'), 'utf8')).toBe("it's\nmine\n");
      const used = fs.readFileSync(path.join(seen, 'path'), 'utf8');
      expect(used.startsWith(os.tmpdir())).toBe(true);
      expect(fs.existsSync(path.dirname(used))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(seen, { recursive: true, force: true });
    }
  });

  it('returns null when the editor exits non-zero or cannot be started', async () => {
    const { dir, cmd } = makeEditorScript('process.exit(3)');
    try {
      expect(await editExternally('x', { editor: cmd })).toBeNull();
      expect(await editExternally('x', { editor: 'exit 127 #' })).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installCleanup beforeRestore', () => {
  it('runs first; when it succeeds the alternate screen is left to the UI library, when it throws the sequence is written', () => {
    const mk = () => {
      const out = new EventEmitter();
      out.isTTY = true;
      out.chunks = [];
      out.write = (d) => out.chunks.push(d);
      return out;
    };
    const run = (before) => {
      const o = mk();
      const proc = new EventEmitter();
      proc.stderr = { write() {} };
      const order = [];
      installCleanup({ stdout: o, proc, exit: vi.fn(), alternateScreen: true, beforeRestore: () => { order.push('before'); before(); } });
      proc.emit('exit');
      return { text: o.chunks.join(''), order };
    };
    const ok = run(() => {});
    expect(ok.order).toEqual(['before']);
    expect(ok.text).not.toContain('\x1b[?1049l');
    expect(ok.text).toContain('\x1b[?1000l'); // mouse still switched off
    const bad = run(() => {
      throw new Error('boom');
    });
    expect(bad.text).toContain('\x1b[?1049l');
  });
});

describe('auto-wrap', () => {
  const mk = () => {
    const o = new EventEmitter();
    o.isTTY = true;
    o.writes = [];
    o.write = (d) => o.writes.push(d);
    return o;
  };
  it('disableWrap clips overflowing rows; restoreTerminal puts the terminal default back (only when rd turned it off)', async () => {
    const { disableWrap, enableWrap } = await import('../../src/tui/terminal.js');
    const o = mk();
    disableWrap(o);
    expect(o.writes).toEqual([SEQ.WRAP_OFF]);
    o.writes.length = 0;
    restoreTerminal(o);
    expect(o.writes).toEqual([SEQ.MOUSE_OFF, SEQ.PASTE_OFF, SEQ.WRAP_ON, SEQ.CURSOR_SHOW]);
    o.writes.length = 0;
    restoreTerminal(o); // nothing to undo any more
    expect(o.writes).toEqual([SEQ.MOUSE_OFF, SEQ.PASTE_OFF, SEQ.CURSOR_SHOW]);
    enableWrap(mk());
  });
});
