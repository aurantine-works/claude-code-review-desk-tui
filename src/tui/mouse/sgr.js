/**
 * Incremental terminal-input parser: SGR mouse reports and bracketed paste.
 *
 * Everything that is not a mouse report or a paste is passed through verbatim as `text`
 * events (including every other escape sequence: arrows, F-keys, Alt+x, `\x1b\r`, a lone
 * ESC...), so that Ink's own key parser sees exactly what the terminal sent.
 *
 * Recognised sequences
 *   SGR mouse      ESC [ < Cb ; Cx ; Cy (M|m)     (xterm modes 1000/1002/1006)
 *   paste start    ESC [ 200 ~      paste end    ESC [ 201 ~
 *
 * Streaming behaviour (SSH splits writes at arbitrary byte positions):
 *   - A buffer ending in a proper prefix of a recognised sequence (`ESC`, `ESC [`, `ESC [ < 12 ;`,
 *     `ESC [ 2 0`, ...) is held back until more input arrives.
 *   - A held prefix that never completes (the Esc key is a lone ESC byte!) is released by
 *     `flush()`. The owner calls it from a ~25-30 ms timer after `hasPendingEscape()` turned
 *     true; see filteredStdin.js.
 *   - An open paste is never released by `flush()` (slow links may pause for longer than the Esc
 *     timer); the owner can force it with `flush({ force: true })` after a long idle timeout.
 *   - A stray paste-end marker outside a paste is dropped.
 *
 * Pure module: no I/O, no timers, no Ink imports.
 */

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /^\x1b\[<(\d{1,6});(\d{1,6});(\d{1,6})([Mm])/;
// eslint-disable-next-line no-control-regex
const SGR_PARTIAL = /^\x1b\[<[0-9;]{0,20}$/;
/** Hard cap for the pasted body; beyond it the paste is emitted early to bound memory. */
const MAX_PASTE = 16 * 1024 * 1024;

/**
 * @typedef {{type: 'text', data: string}} TextEvent
 * @typedef {{type: 'paste', text: string}} PasteEvent
 * @typedef {object} MouseEvent
 * @property {'mouse'} type
 * @property {'left'|'middle'|'right'|'none'|'wheelUp'|'wheelDown'|'wheelLeft'|'wheelRight'|'other'} button
 *           `none` is a motion report with no button held (only with xterm mode 1003, which rd does not enable).
 * @property {number} x     0-based column.
 * @property {number} y     0-based row.
 * @property {'press'|'release'|'drag'|'wheel'|'move'} kind
 * @property {boolean} shift
 * @property {boolean} meta
 * @property {boolean} ctrl
 * @typedef {TextEvent | PasteEvent | MouseEvent} InputEvent
 */

/**
 * Decode the numeric fields of an SGR mouse report.
 * @param {number} cb  Button/modifier code.
 * @param {number} cx  1-based column.
 * @param {number} cy  1-based row.
 * @param {'M'|'m'} final
 * @returns {MouseEvent}
 */
export function decodeSgrMouse(cb, cx, cy, final) {
  const low = cb & 3;
  const wheel = (cb & 64) !== 0;
  const motion = (cb & 32) !== 0;
  let button;
  let kind;
  if (wheel) {
    button = ['wheelUp', 'wheelDown', 'wheelLeft', 'wheelRight'][low];
    kind = 'wheel';
  } else if (cb & 128) {
    button = 'other'; // buttons 8-11 (back/forward...)
    kind = final === 'm' ? 'release' : motion ? 'drag' : 'press';
  } else {
    button = ['left', 'middle', 'right', 'none'][low];
    if (final === 'm') kind = 'release';
    else if (motion) kind = low === 3 ? 'move' : 'drag';
    else kind = 'press';
  }
  return {
    type: 'mouse',
    button,
    x: Math.max(0, cx - 1),
    y: Math.max(0, cy - 1),
    kind,
    shift: (cb & 4) !== 0,
    meta: (cb & 8) !== 0,
    ctrl: (cb & 16) !== 0,
  };
}

/**
 * True when `rest` (which starts with ESC and runs to the end of the buffer) could still grow
 * into a recognised sequence.
 */
function isPartialSequence(rest) {
  if (rest === ESC || rest === '\x1b[') return true;
  if (rest.length < PASTE_START.length && PASTE_START.startsWith(rest)) return true;
  if (rest.length < PASTE_END.length && PASTE_END.startsWith(rest)) return true;
  return SGR_PARTIAL.test(rest);
}

/**
 * Create a parser instance. State is private to the instance.
 */
export function createInputParser() {
  let pending = ''; // held-back partial escape sequence (never while pasting)
  let pasting = false;
  let pasteBuf = '';

  /** @type {InputEvent[]} */
  let events = [];

  function pushText(data) {
    if (!data) return;
    const prev = events[events.length - 1];
    if (prev && prev.type === 'text') prev.data += data;
    else events.push({ type: 'text', data });
  }

  /** Consume `buf` while inside a paste; returns the unconsumed remainder or null if still open. */
  function consumePaste(buf) {
    // The end marker may straddle chunks, so rescan the last 5 buffered chars as well.
    const from = Math.max(0, pasteBuf.length - (PASTE_END.length - 1));
    pasteBuf += buf;
    const end = pasteBuf.indexOf(PASTE_END, from);
    if (end === -1) {
      if (pasteBuf.length > MAX_PASTE) {
        events.push({ type: 'paste', text: pasteBuf });
        pasteBuf = '';
        pasting = false;
      }
      return null;
    }
    const rest = pasteBuf.slice(end + PASTE_END.length);
    events.push({ type: 'paste', text: pasteBuf.slice(0, end) });
    pasteBuf = '';
    pasting = false;
    return rest;
  }

  function scan(input) {
    let buf = input;
    let pos = 0; // everything before `pos` has been consumed
    let from = 0; // where to look for the next ESC (>= pos)
    for (;;) {
      if (pasting) {
        const rest = consumePaste(buf.slice(pos));
        if (rest === null) return;
        buf = rest;
        pos = from = 0;
      }
      const i = buf.indexOf(ESC, from);
      if (i === -1) {
        pushText(buf.slice(pos));
        return;
      }
      const rest = buf.slice(i);
      const m = SGR_MOUSE.exec(rest);
      if (m) {
        pushText(buf.slice(pos, i));
        events.push(decodeSgrMouse(+m[1], +m[2], +m[3], m[4]));
        pos = from = i + m[0].length;
      } else if (rest.startsWith(PASTE_START)) {
        pushText(buf.slice(pos, i));
        pasting = true;
        pos = from = i + PASTE_START.length;
      } else if (rest.startsWith(PASTE_END)) {
        // Stray end marker (its start was lost): drop it.
        pushText(buf.slice(pos, i));
        pos = from = i + PASTE_END.length;
      } else if (isPartialSequence(rest)) {
        pushText(buf.slice(pos, i));
        pending = rest;
        return;
      } else {
        from = i + 1; // an ordinary ESC: part of the pass-through text
      }
    }
  }

  return {
    /**
     * Feed decoded text and get the events it completes, in order.
     * @param {string} input
     * @returns {InputEvent[]}
     */
    feed(input) {
      events = [];
      const buf = pending + input;
      pending = '';
      if (buf !== '') scan(buf);
      const out = events;
      events = [];
      return out;
    },

    /**
     * Release a held-back partial escape sequence as plain text (the user pressed Esc, or the
     * sequence is not one we know). Call from a short timer when `hasPendingEscape()` is true.
     * An open paste is left alone unless `force` is set, in which case what has been collected
     * so far is emitted as a paste.
     * @param {{force?: boolean}} [opts]
     * @returns {InputEvent[]}
     */
    flush({ force = false } = {}) {
      const out = [];
      if (pending) {
        out.push({ type: 'text', data: pending });
        pending = '';
      }
      if (force && pasting) {
        out.push({ type: 'paste', text: pasteBuf });
        pasteBuf = '';
        pasting = false;
      }
      return out;
    },

    /** True while a partial escape sequence is buffered (arm the Esc flush timer). */
    hasPendingEscape() {
      return pending !== '';
    },

    /** True between a paste-start marker and its end marker. */
    isPasting() {
      return pasting;
    },

    /** Drop all buffered state (e.g. when input is suspended for an external editor). */
    reset() {
      pending = '';
      pasting = false;
      pasteBuf = '';
    },
  };
}
