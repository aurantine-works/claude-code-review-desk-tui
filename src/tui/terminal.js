/**
 * Terminal mode helpers: mouse reporting, bracketed paste, bell, crash-safe cleanup and
 * hand-over of the terminal to an external editor.
 *
 * All writers are no-ops when the target stream is not a TTY, and swallow write errors (the
 * terminal may already be gone after an SSH drop).
 *
 * Mode ownership: this module is the only place that switches xterm modes 1000/1002/1006
 * (mouse) and 2004 (bracketed paste). Do not use Ink's `usePaste` (see filteredStdin.js).
 */

import os from 'node:os';

const CSI = '\x1b[';

/** Raw control sequences, exported for tests and for code that must write them itself. */
export const SEQ = Object.freeze({
  /** Button press/release (1000), drag (1002), SGR extended coordinates (1006). */
  MOUSE_ON: `${CSI}?1000h${CSI}?1002h${CSI}?1006h`,
  MOUSE_OFF: `${CSI}?1006l${CSI}?1002l${CSI}?1000l`,
  PASTE_ON: `${CSI}?2004h`,
  PASTE_OFF: `${CSI}?2004l`,
  /** DECAWM: with auto-wrap off a row that is wider on the terminal than rd measured is clipped, not wrapped onto the next row. */
  WRAP_OFF: `${CSI}?7l`,
  WRAP_ON: `${CSI}?7h`,
  CURSOR_SHOW: `${CSI}?25h`,
  /** Leave the alternate screen (only needed in crash handlers if the app uses `alternateScreen: true`). */
  ALT_SCREEN_OFF: `${CSI}?1049l`,
  BELL: '\x07',
});

// Which modes this process turned on, so suspend/restore only re-enables what was enabled.
const modes = { mouse: false, paste: false, wrap: false };

function write(out, data) {
  if (!out || out.isTTY !== true || out.destroyed) return false;
  try {
    out.write(data);
    return true;
  } catch {
    return false;
  }
}

/** Turn on mouse reporting (press, release, drag, wheel; SGR coordinates). */
export function enableMouse(out = process.stdout) {
  if (write(out, SEQ.MOUSE_ON)) modes.mouse = true;
}

/** Turn off mouse reporting. Always writes (idempotent), so it is safe in crash handlers. */
export function disableMouse(out = process.stdout) {
  write(out, SEQ.MOUSE_OFF);
  modes.mouse = false;
}

/** Turn on bracketed paste (pastes arrive as `ESC[200~ ... ESC[201~`). */
export function enablePaste(out = process.stdout) {
  if (write(out, SEQ.PASTE_ON)) modes.paste = true;
}

export function disablePaste(out = process.stdout) {
  write(out, SEQ.PASTE_OFF);
  modes.paste = false;
}

/**
 * Turn off the terminal's auto-wrap. The screen is laid out by display width; terminals that draw some characters
 * (ambiguous-width punctuation, emoji sequences) wider than the library measured would otherwise wrap the overflow
 * onto the next row and shift everything below it, so that mouse rows no longer match the drawing.
 */
export function disableWrap(out = process.stdout) {
  if (write(out, SEQ.WRAP_OFF)) modes.wrap = true;
}

/** Restore auto-wrap (the terminal default). */
export function enableWrap(out = process.stdout) {
  write(out, SEQ.WRAP_ON);
  modes.wrap = false;
}

/** Whether this process currently has mouse reporting switched on. */
export function isMouseEnabled() {
  return modes.mouse;
}

/** Whether this process currently has bracketed paste switched on. */
export function isPasteEnabled() {
  return modes.paste;
}

/**
 * Ask the terminal to put `text` on the system clipboard (OSC 52). Terminals that do not support it ignore the sequence, and
 * so does a non-TTY stream. Returns whether the sequence was written (not whether the terminal acted on it).
 */
export function copyToClipboard(text, out = process.stdout) {
  return write(out, `\x1b]52;c;${Buffer.from(String(text), 'utf8').toString('base64')}\x07`);
}

/** Ring the terminal bell (tab highlight / sound depending on the client). */
export function bell(out = process.stdout) {
  write(out, SEQ.BELL);
}

/**
 * Restore everything rd may have changed on the terminal: mouse, paste, auto-wrap (when rd turned it off), cursor visibility.
 * @param {NodeJS.WriteStream} [out]
 * @param {string} [extra]  Additional sequence to write last (e.g. leave the alternate screen).
 */
export function restoreTerminal(out = process.stdout, extra = '') {
  disableMouse(out);
  disablePaste(out);
  if (modes.wrap) enableWrap(out);
  write(out, SEQ.CURSOR_SHOW + extra);
}

/**
 * Make sure a crash or kill does not leave the user's terminal in mouse / paste mode.
 *
 * Handles `exit`, SIGINT, SIGTERM, SIGHUP, `uncaughtException` (which includes unhandled
 * rejections). After restoring the terminal, signal handlers exit with `128 + signo`, and the
 * exception handler prints the stack to stderr and exits with 1 -- installing a listener
 * disables Node's default termination, so these handlers must terminate the process.
 *
 * Note: with Ink in raw mode Ctrl+C is not a signal; it is the byte 0x03 handled by Ink.
 *
 * @param {object} [opts]
 * @param {NodeJS.WriteStream} [opts.stdout=process.stdout]
 * @param {boolean} [opts.alternateScreen=false]  The app runs on the alternate screen (Ink `alternateScreen: true`):
 *                                   leave it in the handlers so the shell prompt comes back.
 * @param {string} [opts.extra]      Extra sequence written after the restore.
 * @param {() => void} [opts.beforeRestore]  Called first in every handler. If it returns normally the alternate screen is
 *                                   assumed to be left already (no `?1049l` is written); if it throws, the handler
 *                                   falls back to writing it. Use it to let the UI
 *                                   library tear itself down while it still owns the alternate screen: Ink unmounts
 *                                   there, which leaves the alternate screen and discards its final frame. Without it
 *                                   Ink's own exit hook runs *after* these handlers and paints that frame onto the
 *                                   normal screen.
 * @param {string[]} [opts.signals]  Signals to handle.
 * @param {NodeJS.Process} [opts.proc=process]   Injectable for tests.
 * @param {(code: number) => void} [opts.exit]   Injectable for tests (default `proc.exit`).
 * @returns {() => void} uninstall -- removes every listener again.
 */
export function installCleanup({
  stdout = process.stdout,
  alternateScreen = false,
  extra = '',
  signals = ['SIGINT', 'SIGTERM', 'SIGHUP'],
  beforeRestore = null,
  proc = process,
  exit = (code) => proc.exit(code),
} = {}) {
  const restore = () => {
    let tornDown = false;
    try {
      if (beforeRestore) {
        beforeRestore();
        tornDown = true; // the UI library left the alternate screen itself
      }
    } catch {
      // ignore: the sequences below are the safety net
    }
    restoreTerminal(stdout, (alternateScreen && !tornDown ? SEQ.ALT_SCREEN_OFF : '') + extra);
  };
  const listeners = [];
  const add = (event, fn) => {
    proc.on(event, fn);
    listeners.push([event, fn]);
  };
  const uninstall = () => {
    for (const [event, fn] of listeners.splice(0)) proc.off(event, fn);
  };

  add('exit', restore);
  for (const sig of signals) {
    add(sig, () => {
      restore();
      uninstall();
      exit(128 + (os.constants.signals[sig] ?? 1));
    });
  }
  add('uncaughtException', (err) => {
    restore();
    uninstall();
    try {
      proc.stderr.write(`${err?.stack ?? err}\n`);
    } catch {
      // ignore
    }
    exit(1);
  });
  return uninstall;
}

/**
 * Run `fn` (typically: spawn `$EDITOR` and wait) with the terminal handed over to it:
 * mouse and bracketed paste are switched off, Ink's input is paused, and afterwards whatever was
 * enabled before is switched on again.
 *
 * Pass `suspendTerminal` (from Ink's `useApp()`) when running inside an Ink app: Ink erases its
 * frame, leaves raw mode, stops reading stdin (our filtered stdin detaches from the real one),
 * runs `fn`, then restores raw mode and redraws. Without it, pass the filtered `stdin` and its
 * `suspendInput()` is used instead.
 *
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {object} [ctx]
 * @param {NodeJS.WriteStream} [ctx.stdout=process.stdout]
 * @param {(cb: () => Promise<void>) => Promise<void>} [ctx.suspendTerminal]  Ink's `useApp().suspendTerminal`.
 * @param {{suspendInput?: () => () => void}} [ctx.stdin]  The filtered stdin (fallback when no `suspendTerminal`).
 * @returns {Promise<T>}
 */
export async function suspendForEditor(fn, { stdout = process.stdout, suspendTerminal, stdin } = {}) {
  const hadMouse = modes.mouse;
  const hadPaste = modes.paste;
  const hadWrap = modes.wrap;
  disableMouse(stdout);
  disablePaste(stdout);
  if (hadWrap) enableWrap(stdout); // editors expect the normal terminal
  let resumeInput;
  try {
    if (typeof suspendTerminal === 'function') {
      let result;
      await suspendTerminal(async () => {
        result = await fn();
      });
      return result;
    }
    resumeInput = stdin?.suspendInput?.();
    return await fn();
  } finally {
    resumeInput?.();
    if (hadMouse) enableMouse(stdout);
    if (hadPaste) enablePaste(stdout);
    if (hadWrap) disableWrap(stdout);
  }
}
