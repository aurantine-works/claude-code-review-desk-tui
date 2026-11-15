/**
 * Filtered stdin: a Readable that sits between the real TTY stdin and Ink.
 *
 *   real stdin --(Buffer)--> TextDecoder(stream) --> input parser --+--> text   --> this stream --> Ink
 *                                                                    +--> mouse --> bus 'mouse'
 *                                                                    +--> paste --> bus 'paste'
 *
 * ---------------------------------------------------------------------------------------------
 * What Ink 8.0.0 does with stdin (read from node_modules/ink/build, verified for this design)
 * ---------------------------------------------------------------------------------------------
 *  - It never uses 'data' events. When the first useInput/usePaste becomes active it calls
 *    `stdin.setEncoding('utf8')`, `stdin.ref()`, `stdin.setRawMode(true)` and attaches ONE
 *    'readable' listener that loops `while ((chunk = stdin.read()) !== null)`. When the last
 *    hook goes away it removes the listener, `setRawMode(false)` and `unref()`.
 *  - Raw mode is only considered supported if `stdin.isTTY === true` and `stdin.setRawMode` is a
 *    function (ink/build/stream.js); otherwise useInput throws.
 *  - Its own parser (ink/build/input-parser.js) keeps a trailing lone ESC / partial CSI pending
 *    and releases it 20 ms later, so the Esc key costs (our ESC timeout) + 20 ms.
 *  - Key mapping (parse-keypress.js + use-input.js), as observed by `useInput(input, key)`:
 *      Enter        '\r'     -> key.return=true,  key.meta=false, input='\r'
 *      Alt+Enter    '\x1b\r' -> key.return=true,  key.meta=true,  input='\r'
 *      Ctrl+J       '\n'     -> key.return=false (name 'enter'),  input='\n'
 *      Esc          '\x1b'   -> key.escape=true,  input=''
 *      Backspace    '\x7f'/'\b' -> key.backspace;  Delete '\x1b[3~' -> key.delete
 *    Multi-character chunks that are not a known key (IME commits, unbracketed pastes) arrive as
 *    one `input` string; a '\r' inside them is NOT a Return key.
 *  - SGR mouse reports are complete CSI sequences with no key name, so Ink silently drops them
 *    (they would not reach useInput) -- but it gives us no way to *use* them, hence this filter.
 *  - Ink 8 already supports bracketed paste (`usePaste`, plus `\x1b[200~...\x1b[201~` handling in
 *    its parser). We deliberately intercept paste here instead of relying on it:
 *      1. Our parser must understand paste boundaries anyway, otherwise mouse-looking bytes inside
 *         pasted text would be turned into mouse events (and vice versa).
 *      2. Without a `usePaste` listener Ink falls back to feeding the pasted text through
 *         `useInput`, where a pasted "q" or "j" would trigger Normal-mode hotkeys. On the bus only
 *         the component that wants paste (the comment editor) receives it.
 *      3. One owner for terminal modes: terminal.js enables/disables 2004 and restores it on
 *         crash; Ink's ref-counted `setBracketedPasteMode` would fight over the same mode.
 *      4. Ink keeps a half-received paste pending forever (no timeout) and rescans it on every
 *         chunk; the filter accumulates incrementally and has an idle timeout.
 *    Consequently: do NOT use Ink's `usePaste` in rd.
 *  - `suspendTerminal` (useApp) pauses input by removing the 'readable' listener and calling
 *    `setRawMode(false)`/`unref()`; the filter follows the listener count, so the real stdin is
 *    released while an external editor runs and re-attached when Ink resumes.
 *
 * ---------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------
 *  - The filter only reads the real stdin while somebody listens for 'readable' (or 'data') on it.
 *    `ref`/`unref`/`setRawMode` are forwarded to the real stdin.
 *  - `dispose()` detaches from the real stdin and destroys the filtered stream (never the real one).
 */
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createInputParser } from './sgr.js';

/**
 * Create the event bus the filter publishes to. Events:
 *  - `'mouse'`  (event)  see {@link import('./sgr.js').MouseEvent}
 *  - `'paste'`  (text)   raw pasted text (line endings untouched; the editor normalises them)
 * @returns {EventEmitter}
 */
export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  return bus;
}

/**
 * @typedef {object} FilteredStdinOptions
 * @property {number} [escTimeoutMs=25]    How long a trailing ESC / partial sequence is held before it
 *                                         is released as plain text (the Esc key).
 * @property {number} [pasteTimeoutMs=3000] Idle time after which an unterminated paste is emitted anyway.
 */

class FilteredStdin extends Readable {
  #real;
  #bus;
  #parser = createInputParser();
  #decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  #escMs;
  #pasteMs;
  #escTimer = null;
  #pasteTimer = null;
  #attached = false;
  #disposed = false;
  #raw = false;

  constructor(real, bus, { escTimeoutMs = 25, pasteTimeoutMs = 3000 } = {}) {
    super({ encoding: 'utf8' });
    this.#real = real;
    this.#bus = bus;
    this.#escMs = escTimeoutMs;
    this.#pasteMs = pasteTimeoutMs;
    Object.defineProperty(this, 'isTTY', { get: () => real.isTTY === true, enumerable: true, configurable: true });
    this.on('newListener', (event) => {
      if (event === 'readable' || event === 'data') this.#attach();
    });
    this.on('removeListener', (event) => {
      if ((event === 'readable' || event === 'data') && !this.#hasConsumers()) this.#detach();
    });
  }

  _read() {}

  #hasConsumers() {
    return this.listenerCount('readable') + this.listenerCount('data') > 0;
  }

  #onData = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    this.#handle(this.#parser.feed(text));
    this.#arm();
  };

  #onEnd = () => {
    this.#clearTimers();
    this.#handle(this.#parser.flush({ force: true }));
    this.push(null);
  };

  #attach() {
    if (this.#attached || this.#disposed) return;
    this.#attached = true;
    this.#real.on('data', this.#onData);
    this.#real.on('end', this.#onEnd);
    this.#real.resume?.();
  }

  #detach() {
    if (!this.#attached) return;
    this.#attached = false;
    this.#real.off('data', this.#onData);
    this.#real.off('end', this.#onEnd);
    this.#real.pause?.();
    this.#clearTimers();
    this.#parser.reset();
    this.#decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  }

  #clearTimers() {
    clearTimeout(this.#escTimer);
    clearTimeout(this.#pasteTimer);
    this.#escTimer = this.#pasteTimer = null;
  }

  /** (Re)arm the Esc-release and paste-idle timers according to the parser state. */
  #arm() {
    clearTimeout(this.#escTimer);
    this.#escTimer = null;
    if (this.#parser.hasPendingEscape()) {
      this.#escTimer = setTimeout(() => {
        this.#escTimer = null;
        this.#handle(this.#parser.flush());
      }, this.#escMs);
      this.#escTimer.unref?.();
    }
    clearTimeout(this.#pasteTimer);
    this.#pasteTimer = null;
    if (this.#parser.isPasting()) {
      this.#pasteTimer = setTimeout(() => {
        this.#pasteTimer = null;
        this.#handle(this.#parser.flush({ force: true }));
      }, this.#pasteMs);
      this.#pasteTimer.unref?.();
    }
  }

  #handle(events) {
    for (const ev of events) {
      if (ev.type === 'text') this.push(ev.data);
      else if (ev.type === 'mouse') this.#bus?.emit('mouse', ev);
      else if (ev.type === 'paste') this.#bus?.emit('paste', ev.text);
    }
  }

  // --- the subset of tty.ReadStream that Ink uses -------------------------------------------

  /** Forwarded to the real stdin (Ink calls this when a `useInput` hook becomes active). */
  setRawMode(mode) {
    this.#raw = Boolean(mode);
    this.#real.setRawMode?.(mode);
    return this;
  }

  ref() {
    this.#real.ref?.();
    return this;
  }

  unref() {
    this.#real.unref?.();
    return this;
  }

  // --- extras --------------------------------------------------------------------------------

  /**
   * Hand the terminal input to a child process without going through Ink: stop reading the real
   * stdin, leave raw mode and unref it. Returns a function that undoes it. (When Ink's own
   * `suspendTerminal` is used this is not needed: Ink removes its listener and we follow.)
   * @returns {() => void} resume
   */
  suspendInput() {
    const wasRaw = this.#raw;
    const wasAttached = this.#attached;
    this.#detach();
    if (wasRaw) this.#real.setRawMode?.(false);
    this.#real.unref?.();
    return () => {
      if (this.#disposed) return;
      this.#real.ref?.();
      if (wasRaw) this.#real.setRawMode?.(true);
      if (wasAttached || this.#hasConsumers()) this.#attach();
    };
  }

  /** Detach from the real stdin and destroy this stream. The real stdin is left untouched. */
  dispose() {
    if (this.#disposed) return;
    this.#detach();
    this.#disposed = true;
    this.destroy();
  }
}

/**
 * Wrap `realStdin` so mouse reports and bracketed pastes are diverted to `bus` and everything
 * else is forwarded, unchanged, to whoever reads the returned stream.
 *
 * Usage:
 * ```js
 * const bus = createBus();
 * const stdin = createFilteredStdin(process.stdin, bus);
 * const app = render(element, { stdin, exitOnCtrlC: true });
 * ```
 *
 * @param {NodeJS.ReadStream} realStdin  Usually `process.stdin`; anything with on/off('data'),
 *   `isTTY`, and optionally `setRawMode/ref/unref/pause/resume` (handy for tests).
 * @param {EventEmitter} [bus]  Receives `'mouse'` and `'paste'` events. Omit to discard them.
 * @param {FilteredStdinOptions} [options]
 * @returns {Readable & {isTTY: boolean, setRawMode(mode: boolean): any, ref(): any, unref(): any,
 *   suspendInput(): () => void, dispose(): void}}
 */
export function createFilteredStdin(realStdin, bus, options) {
  return /** @type {any} */ (new FilteredStdin(realStdin, bus, options));
}
