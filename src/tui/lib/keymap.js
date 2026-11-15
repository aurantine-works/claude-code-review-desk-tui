// Key -> action mapping for the review screen (Normal / Visual). Pure: takes Ink's (input, key) pair.

/**
 * @typedef {{action: string, pending?: string | null} | null} KeyResult
 * `pending` is the first half of a two-key sequence (`]` or `[`); the caller keeps it for the next key.
 */

/**
 * @param {string} input   text as delivered by Ink's useInput
 * @param {object} key     Ink key flags
 * @param {string | null} pending
 * @param {'normal'|'visual'} mode
 * @returns {KeyResult}
 */
export function mapKey(input, key, pending, mode) {
  if (pending) {
    if (input === 'c' && !key.ctrl) return { action: pending === ']' ? 'nextThread' : 'prevThread' };
    // any other key cancels the sequence and is handled normally below
  }
  if (key.ctrl) {
    if (input === 'c') return { action: mode === 'visual' ? 'escape' : 'back' }; // Ctrl+C = q
    if (input === 'd') return { action: 'halfDown' };
    if (input === 'u') return { action: 'halfUp' };
    if (input === 'f') return { action: 'pageDown' };
    if (input === 'b') return { action: 'pageUp' };
    if (input === 'e') return { action: 'panelDown' };
    if (input === 'y') return { action: 'panelUp' };
    return null;
  }
  if (key.escape) return { action: 'escape' };
  if (key.downArrow) return { action: 'down' };
  if (key.upArrow) return { action: 'up' };
  if (key.leftArrow) return { action: 'left' };
  if (key.rightArrow) return { action: 'right' };
  if (key.pageDown) return { action: 'pageDown' };
  if (key.pageUp) return { action: 'pageUp' };
  if (key.home) return { action: 'top' };
  if (key.end) return { action: 'bottom' };
  if (key.tab) return { action: key.shift ? 'prevFocus' : 'nextFocus' };
  if (key.return) return { action: 'enter' };
  if (key.meta) return null;
  switch (input) {
    case 'j':
      return { action: 'down' };
    case 'k':
      return { action: 'up' };
    case 'g':
      return { action: 'top' };
    case 'G':
      return { action: 'bottom' };
    case ']':
    case '[':
      return { action: 'pendingKey', pending: input };
    case 'h':
      return { action: 'left' };
    case 'l':
      return { action: 'right' };
    case 'w':
      return { action: 'wordNext' };
    case 'b':
      return { action: 'wordPrev' };
    case 'e':
      return { action: 'wordEnd' };
    case '0':
      return { action: 'lineStart' };
    case '^':
      return { action: 'firstNonBlank' };
    case '$':
      return { action: 'lineEnd' };
    case 'v':
      return { action: 'visualChar' }; // in Visual mode: switch to / leave character selection
    case 'V':
      return { action: 'visualLine' };
    case 'c':
      return { action: 'comment' };
    case 'C':
      return { action: 'commentExternal' };
    case 'r':
      return { action: 'reply' };
    case 'R':
      return { action: 'replyExternal' };
    case 'x':
      return { action: 'resolve' };
    case 'D':
      return { action: 'deleteDraft' };
    case 'd':
      return { action: 'diff' };
    case 's':
      return { action: 'submit' };
    case 'B':
      return { action: 'toggleMode' };
    case 'A':
      return { action: 'approve' };
    case 'E':
      return { action: 'endQna' };
    case 'q':
      return { action: mode === 'visual' ? 'escape' : 'back' };
    case '?':
      return { action: 'help' };
    case 'm':
      return { action: 'toggleMouse' };
    case 'M':
      return { action: 'toggleMd' };
    case 'O':
      return { action: 'channelC' }; // reopen the "session ended" dialog (feedback waiting, session gone)
    case 'U':
      return { action: 'adoptExternal' }; // take the file's current content as a new revision
    case 'S':
      return { action: 'rebind' }; // bind the review to another session
    default:
      return null;
  }
}

/** Keys that change something: in the diff view they only say that the view is read-only. */
const WRITE_KEYS = new Set(['c', 'C', 'r', 'R', 'x', 'D', 'v', 'V', 's', 'B', 'A', 'E', 'M', 'U', 'O', 'S']);

/**
 * Key -> action mapping of the diff view (read-only: navigation, base revision, back).
 * @param {string | null} pending  `]` or `[` typed first
 * @returns {KeyResult}
 */
export function mapDiffKey(input, key, pending) {
  if (pending && input === 'c' && !key.ctrl) return { action: pending === ']' ? 'diffNext' : 'diffPrev' };
  if (key.ctrl) {
    if (input === 'c') return { action: 'diffBack' };
    if (input === 'd') return { action: 'halfDown' };
    if (input === 'u') return { action: 'halfUp' };
    if (input === 'f') return { action: 'pageDown' };
    if (input === 'b') return { action: 'pageUp' };
    if (input === 'e') return { action: 'panelDown' };
    if (input === 'y') return { action: 'panelUp' };
    return null;
  }
  if (key.escape) return { action: 'diffBack' };
  if (key.downArrow) return { action: 'down' };
  if (key.upArrow) return { action: 'up' };
  if (key.pageDown) return { action: 'pageDown' };
  if (key.pageUp) return { action: 'pageUp' };
  if (key.home) return { action: 'top' };
  if (key.end) return { action: 'bottom' };
  if (key.return) return { action: 'diffJump' };
  if (key.meta || key.tab) return null;
  switch (input) {
    case 'j':
      return { action: 'down' };
    case 'k':
      return { action: 'up' };
    case 'g':
      return { action: 'top' };
    case 'G':
      return { action: 'bottom' };
    case ']':
    case '[':
      return { action: 'pendingKey', pending: input };
    case '<':
      return { action: 'diffOlder' };
    case '>':
      return { action: 'diffNewer' };
    case 'd':
    case 'q':
      return { action: 'diffBack' };
    case '?':
      return { action: 'help' };
    case 'm':
      return { action: 'toggleMouse' };
    default:
      return WRITE_KEYS.has(input) ? { action: 'diffReadOnly' } : null;
  }
}

/** Keys of the channel C dialog. @returns {'show' | 'headless' | 'leave' | null} */
export function mapDialogKey(input, key) {
  if (key.escape || (key.ctrl && input === 'c') || input === 'l' || input === 'L' || input === 'q') return 'leave';
  if (key.ctrl || key.meta) return null;
  if (input === 'c' || input === 'C') return 'show';
  if (input === 'h' || input === 'H') return 'headless';
  return null;
}

/** Keys of a pick list (session rebind). @returns {'down' | 'up' | 'top' | 'bottom' | 'pick' | 'cancel' | null} */
export function mapPickerKey(input, key) {
  if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return 'cancel';
  if (key.return) return 'pick';
  if (key.downArrow || input === 'j' || (key.ctrl && input === 'n')) return 'down';
  if (key.upArrow || input === 'k' || (key.ctrl && input === 'p')) return 'up';
  if (key.home || input === 'g') return 'top';
  if (key.end || input === 'G') return 'bottom';
  return null;
}

/** Keys in the confirm bar. @returns {'yes' | 'no' | null} */
export function mapConfirmKey(input, key) {
  if (key.return || input === 'y' || input === 'Y') return 'yes';
  if (key.escape || input === 'n' || input === 'N' || input === 'q' || (key.ctrl && input === 'c')) return 'no';
  return null;
}

/**
 * Ink delivers several characters typed in quick succession (SSH batching, key repeat, an IME commit) as one
 * `input` string, with no key flags. Outside the text box every character is a command, so split them and
 * re-derive the flags of control characters (Ctrl-d arrives as 0x04, Enter as CR, ...).
 * @returns {Array<[string, object]>}
 */
export function splitKeys(input, key) {
  if (input.length <= 1 || key.ctrl || key.meta) return [[input, key]];
  const out = [];
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (ch === '\r' || ch === '\n') out.push(['', { ...key, return: true }]);
    else if (ch === '\t') out.push(['', { ...key, tab: true }]);
    else if (ch === '\x7f' || ch === '\b') out.push(['', { ...key, backspace: true }]);
    else if (ch === '\x1b') out.push(['', { ...key, escape: true }]);
    else if (code >= 1 && code <= 26) out.push([String.fromCharCode(code + 96), { ...key, ctrl: true }]);
    else out.push([ch, key]);
  }
  return out;
}
