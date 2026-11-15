// The bottom status bar: mode badge, clickable key hints, notices. Returns segments plus the x-ranges of the
// buttons so the same description drives drawing and mouse hit-testing.
import stringWidth from 'string-width';
import { fitSegs, pushSeg, ellipsize } from './ansi.js';
import { COLOR } from './theme.js';
import { t } from '../../i18n/index.js';

const BADGE = {
  normal: ' NORMAL ',
  visual: ' VISUAL ',
  input: ' INPUT ',
  confirm: ' CONFIRM ',
  help: ' HELP ',
  menu: ' MENU ',
  dialog: ' SESSION ',
  picker: ' PICK ',
};

/**
 * @typedef {object} StatusInput
 * @property {'normal'|'visual'|'input'|'confirm'|'help'|'menu'|'dialog'|'picker'} mode
 * @property {'instant'|'batch'} sendMode
 * @property {boolean} readOnly
 * @property {boolean} canReply
 * @property {boolean} canResolve
 * @property {boolean} resolved       the focused thread is resolved (the button says "reopen")
 * @property {number} drafts
 * @property {{text: string, kind?: 'info'|'warn'|'err'} | null} notice
 * @property {{text: string, yes?: string, no?: string} | null} confirm
 * @property {boolean} mouseOn
 * @property {string} cursorText
 * @property {boolean} [inbox]
 * @property {'char'|'line'} [visualKind]  which selection Visual mode is making
 * @property {boolean} [canEndQna]  an `rd await` is waiting: offer E (end instant Q&A)
 * @property {'rendered'|'source'|null} [mdMode]  how a Markdown body is shown (null: not a Markdown document)
 * @property {boolean} [diff]  the diff view is open (read-only navigation buttons)
 * @property {boolean} [canResume]  channel C with feedback waiting: offer O (the "session ended" dialog)
 * @property {boolean} [canAdopt]  the file was changed outside: offer U (new revision from the file)
 * @property {boolean} [canRebind]  the document has other candidate sessions: offer S
 */

/** Button actions: the Review screen maps these names to the same handlers as the keys. */
function normalItems(s) {
  const items = [];
  if (!s.readOnly) items.push({ key: 'c', label: t('status.comment'), action: 'comment', prio: 10 });
  if (!s.readOnly) items.push({ key: 'v', label: t('status.selectChar'), action: 'visualChar', prio: 3 });
  if (!s.readOnly) items.push({ key: 'V', label: t('status.selectLine'), action: 'visualLine', prio: 3 });
  if (!s.readOnly && s.canReply) items.push({ key: 'r', label: t('status.reply'), action: 'reply', prio: 7 });
  if (!s.readOnly && s.canResolve) items.push({ key: 'x', label: s.resolved ? t('status.reopen') : t('status.resolve'), action: 'resolve', prio: 6 });
  if (!s.readOnly && s.sendMode === 'batch') items.push({ key: 's', label: s.drafts ? t('status.submitN', { n: s.drafts }) : t('status.submit'), action: 'submit', prio: 8 });
  if (!s.readOnly) items.push({ key: 'A', label: t('status.approve'), action: 'approve', prio: 9 });
  if (!s.readOnly && s.canEndQna) items.push({ key: 'E', label: t('status.endQna'), action: 'endQna', prio: 2 });
  if (!s.readOnly && s.canResume) items.push({ key: 'O', label: t('status.resume'), action: 'channelC', prio: 9 });
  if (!s.readOnly && s.canAdopt) items.push({ key: 'U', label: t('status.adopt'), action: 'adoptExternal', prio: 9 });
  items.push({ key: 'd', label: 'diff', action: 'diff', prio: 5 });
  if (!s.readOnly && s.canRebind) items.push({ key: 'S', label: t('status.rebind'), action: 'rebind', prio: 2 });
  items.push({ key: '?', label: t('status.help'), action: 'help', prio: 4 });
  items.push({ key: 'q', label: t('status.back'), action: 'back', prio: 1 });
  return items;
}

function diffItems() {
  return [
    { key: 'd', label: t('status.back'), action: 'diffBack', prio: 10 },
    { key: 'Enter', label: t('status.toText'), action: 'diffJump', prio: 9 },
    { key: '<', label: t('status.older'), action: 'diffOlder', prio: 7 },
    { key: '>', label: t('status.newer'), action: 'diffNewer', prio: 7 },
    { key: ']c', label: t('status.nextChange'), action: 'diffNext', prio: 6 },
    { key: '?', label: t('status.help'), action: 'help', prio: 4 },
  ];
}

function visualItems(s) {
  return [
    { key: 'hjkl', label: s.visualKind === 'line' ? t('status.extend') : t('status.extendWords'), action: null, prio: 5 },
    { key: 'c', label: t('status.comment'), action: 'comment', prio: 10 },
    { key: 'C', label: t('status.editor'), action: 'commentExternal', prio: 3 },
    { key: s.visualKind === 'line' ? 'v' : 'V', label: s.visualKind === 'line' ? t('status.toChar') : t('status.toLine'), action: s.visualKind === 'line' ? 'visualChar' : 'visualLine', prio: 4 },
    { key: 'Esc', label: t('status.cancel'), action: 'cancel', prio: 9 },
  ];
}

/**
 * @param {StatusInput} s
 * @param {number} cols
 * @returns {{segs: import('./ansi.js').Segment[], buttons: {x0: number, x1: number, action: string}[]}}
 */
export function buildStatusBar(s, cols) {
  const segs = [];
  const buttons = [];
  let x = 0;
  const push = (text, style) => {
    pushSeg(segs, text, style);
    x += stringWidth(text);
  };
  const bar = { bg: COLOR.bgBar };

  const badge = s.mode === 'visual' && s.visualKind === 'line' ? ' VISUAL LINE ' : s.mode === 'normal' && s.diff ? ' DIFF ' : (BADGE[s.mode] ?? BADGE.normal);
  push(badge, { bold: true, fg: '#101216', bg: s.mode === 'visual' ? COLOR.warn : s.mode === 'confirm' ? COLOR.err : s.mode === 'dialog' ? COLOR.warn : COLOR.accent });
  push(' ', bar);

  // Right-hand info first, so the middle knows how much room it has. Parts have a tier: when the essential buttons
  // (comment / approve / cancel...) do not fit next to the full info, the less important parts are given up first
  // (see the key-hint branch below); the other branches always use the full info.
  const rightParts = [];
  if (s.sendMode === 'batch') rightParts.push({ text: t('status.modeBatch'), tier: 1 });
  else if (!s.inbox) rightParts.push({ text: t('status.modeInstant'), tier: 1 });
  if (s.mdMode) rightParts.push({ text: s.mdMode === 'rendered' ? 'md' : 'src', tier: 1 });
  if (!s.mouseOn) rightParts.push({ text: t('status.mouseOff'), tier: 2 });
  if (s.cursorText) rightParts.push({ text: s.cursorText, tier: 3 });
  const rightFor = (minTier) => {
    const parts = rightParts.filter((p) => p.tier >= minTier);
    return parts.length ? ` ${parts.map((p) => p.text).join(' · ')} ` : '';
  };
  let rightText = rightFor(0);
  let rightW = stringWidth(rightText);
  let room = Math.max(0, cols - x - rightW - 1);

  const addButton = (item, last) => {
    const x0 = x;
    push(item.key, { bold: true, fg: COLOR.accent, ...bar });
    push(` ${item.label}`, bar);
    if (item.action) buttons.push({ x0, x1: x, action: item.action });
    if (!last) push('  ', bar);
  };

  /** The text for the middle of the bar: the first variant that fits next to the right-hand info; failing that (compactRight) next to a
   *  shorter right-hand info (the mode and md / src given up first, then the mouse note); failing that the first one that
   *  fits without it; failing that the shortest, cut. Returns whether the right-hand info stays. */
  const middle = (variants, reserved = 0, compactRight = false) => {
    for (const minTier of compactRight ? [0, 2, 3] : [0]) {
      const text = rightFor(minTier);
      if (minTier > 0 && text === rightText) continue;
      const found = variants.find((v) => stringWidth(v) <= cols - x - stringWidth(text) - 1 - reserved);
      if (found !== undefined) {
        rightText = text;
        rightW = stringWidth(text);
        return { text: found, keepRight: true };
      }
    }
    const full = Math.max(0, cols - x - 1 - reserved);
    const without = variants.find((v) => stringWidth(v) <= full);
    if (without !== undefined) return { text: without, keepRight: false };
    return { text: ellipsize(variants[variants.length - 1], full), keepRight: false };
  };
  let keepRight = true;

  if (s.mode === 'confirm' && s.confirm) {
    const yes = { key: 'y', label: s.confirm.yes ?? t('status.confirm'), action: 'confirmYes' };
    const no = { key: 'n', label: s.confirm.no ?? t('status.cancel'), action: 'confirmNo' };
    // The buttons are what the user needs: they keep their room, the question is cut instead.
    const buttonsW = stringWidth(yes.key) + 1 + stringWidth(yes.label) + 2 + stringWidth(no.key) + 1 + stringWidth(no.label);
    const m = middle([s.confirm.text], buttonsW + 2);
    keepRight = m.keepRight;
    push(m.text, { bold: true, fg: COLOR.warn, ...bar });
    push('  ', bar);
    addButton(yes, false);
    addButton(no, true);
  } else if (s.mode === 'dialog') {
    const m = middle(t('status.dialogHints'));
    keepRight = m.keepRight;
    push(m.text, { dim: true, ...bar });
  } else if (s.mode === 'picker') {
    const m = middle(t('status.pickerHints'));
    keepRight = m.keepRight;
    push(m.text, { dim: true, ...bar });
  } else if (s.notice && (s.notice.kind !== 'info' || s.mode === 'normal' || s.mode === 'visual')) {
    // While the comment box, the help text or a menu is open its key hints matter more than an information notice.
    const color = s.notice.kind === 'err' ? COLOR.err : s.notice.kind === 'warn' ? COLOR.warn : COLOR.ok;
    const m = middle([s.notice.text]);
    keepRight = m.keepRight;
    push(m.text, { fg: color, bold: true, ...bar });
  } else if (s.mode === 'input') {
    const send = s.sendMode === 'batch' ? t('status.saveDraft') : t('status.send');
    const m = middle(t('status.inputHints', { send }), 0, true);
    keepRight = m.keepRight;
    push(m.text, { dim: true, ...bar });
  } else if (s.mode === 'help') {
    const m = middle(t('status.helpHints'));
    keepRight = m.keepRight;
    push(m.text, { dim: true, ...bar });
  } else if (s.mode === 'menu') {
    const m = middle(t('status.menuHints'));
    keepRight = m.keepRight;
    push(m.text, { dim: true, ...bar });
  } else {
    let items = s.mode === 'visual' ? visualItems(s) : s.diff ? diffItems() : normalItems(s);
    const width = (list) => list.reduce((n, it) => n + stringWidth(it.key) + 1 + stringWidth(it.label), 0) + Math.max(0, list.length - 1) * 2;
    const fit = (list, avail) => {
      let kept = list;
      while (kept.length > 1 && width(kept) > avail) {
        let drop = 0;
        kept.forEach((it, i) => {
          if (it.prio < kept[drop].prio) drop = i;
        });
        kept = kept.filter((_, i) => i !== drop);
      }
      return kept;
    };
    const nEssential = (list) => list.filter((it) => it.prio >= 9).length;
    const essential = nEssential(items);
    let fitted = fit(items, room);
    if (nEssential(fitted) < essential) {
      // Labels that are wide in cells: show the essential buttons rather than the mode and the like.
      for (const minTier of [2, 3, 4]) {
        const text = rightFor(minTier);
        const avail = Math.max(0, cols - x - stringWidth(text) - 1);
        const alt = fit(items, avail);
        if (nEssential(alt) > nEssential(fitted) && (nEssential(alt) === essential || minTier === 4)) {
          fitted = alt;
          rightText = text;
          rightW = stringWidth(text);
          room = avail;
          break;
        }
      }
    }
    items = fitted;
    items.forEach((it, i) => addButton(it, i === items.length - 1));
  }

  // Pad to the right-hand info (dropped when the middle needs the room).
  const gap = Math.max(0, cols - x - (keepRight ? rightW : 0));
  push(' '.repeat(gap), bar);
  if (rightText && keepRight) push(rightText, { dim: true, ...bar });
  return { segs: fitSegs(segs, cols, bar), buttons };
}
