// Modal dialogs of the review screen (channel C "session ended", `S` session picker) as rows of segments plus the
// rectangles the mouse can press. A dialog replaces the body area (like the help screen); the header and the status
// bar stay. `hits` are relative to the body's top-left cell.
import stringWidth from 'string-width';
import { fitSegs, pushSeg, ellipsize, ellipsizeStart } from './ansi.js';
import { buildLayout } from '../mouse/layout.js';
import { splitGraphemes, graphemeWidth } from '../input/text.js';
import { candidateLine, pickWindow } from './pickList.js';
import { headlessLine, tildePath } from './channelC.js';
import { COLOR } from './theme.js';
import { t } from '../../i18n/index.js';

const BORDER = { dim: true };

/**
 * Draw a bordered box centred in `width` x `height`.
 * @param {object} o
 * @param {number} o.width @param {number} o.height  the body area
 * @param {string} o.title
 * @param {number} [o.maxWidth]
 * @param {(inner: number, compact: boolean) => Array<{segs: import('./ansi.js').Segment[], action?: string}>} o.build  content lines for an inner
 *        width; `compact` (asked for when the roomy version is taller than the area) leaves out blank lines and explanations
 * @returns {{rows: import('./ansi.js').Segment[][], hits: {y: number, x0: number, x1: number, action: string}[], rect: {x: number, y: number, w: number, h: number}}}
 */
export function boxLayout({ width, height, title, maxWidth = 78, build }) {
  const boxW = Math.max(24, Math.min(width - 2, maxWidth));
  const inner = boxW - 4;
  let lines = build(inner, false);
  if (lines.length + 2 > height) lines = build(inner, true);
  const boxH = Math.min(height, lines.length + 2);
  // Too tall even compact: cut from the middle, the last line (how to close the dialog) must stay.
  const room = Math.max(0, boxH - 2);
  const shown = lines.length <= room || room < 2 ? lines.slice(0, room) : [...lines.slice(0, room - 1), lines[lines.length - 1]];
  const x = Math.max(0, Math.floor((width - boxW) / 2));
  const y = Math.max(0, Math.floor((height - boxH) / 3));

  const pad = (segs) => fitSegs([{ text: ' '.repeat(x), style: null }, ...segs], width);
  const out = [];
  const titleText = ` ${ellipsize(title, Math.max(1, boxW - 7))} `; // a title wider than the box is cut, the corner stays
  const rest = Math.max(0, boxW - 3 - stringWidth(titleText));
  out.push(pad([{ text: '╭─', style: BORDER }, { text: titleText, style: { bold: true, fg: COLOR.warn } }, { text: `${'─'.repeat(rest)}╮`, style: BORDER }]));
  const hits = [];
  shown.forEach((ln, i) => {
    out.push(pad([{ text: '│ ', style: BORDER }, ...fitSegs(ln.segs, inner), { text: ' │', style: BORDER }]));
    if (ln.action) hits.push({ y: y + 1 + i, x0: x + 1, x1: x + boxW - 1, action: ln.action });
  });
  out.push(pad([{ text: `╰${'─'.repeat(boxW - 2)}╯`, style: BORDER }]));

  const rows = [];
  for (let r = 0; r < height; r++) rows.push(r >= y && r < y + out.length ? out[r - y] : fitSegs([], width));
  return { rows, hits, rect: { x, y, w: boxW, h: out.length } };
}

const plain = (text, style = null) => ({ segs: [{ text, style }] });
const blank = () => plain('');
// Text wrapping. Messages mix Chinese (no spaces: cut at the column) with English words and paths: a word wrap alone leaves ragged
// rows next to a long Chinese run, a column cut alone splits "session" in two. So: break after a space when that moves at most
// SLACK columns to the next row, else cut at the column. A command is the exception: it is cut at spaces (a long path is
// still cut hard), so that `--resume <id>` stays together as far as possible.
const SLACK = 12;
function wrapMixed(text, width) {
  const w = Math.max(1, width);
  const out = [];
  for (const para of String(text).split('\n')) {
    let row = []; // graphemes of the current row
    let cols = 0;
    for (const { text: g } of splitGraphemes(para)) {
      const gw = graphemeWidth(g);
      if (cols + gw > w && row.length > 0) {
        let at = -1; // index after the last space of the row
        for (let k = row.length - 1; k >= 0; k--) {
          if (row[k] === ' ') {
            at = k + 1;
            break;
          }
        }
        const tail = at > 0 ? row.slice(at) : [];
        const tailCols = tail.reduce((n, x) => n + graphemeWidth(x), 0);
        if (at > 0 && tailCols <= SLACK) {
          out.push(row.slice(0, at).join('').trimEnd());
          row = tail;
          cols = tailCols;
        } else {
          out.push(row.join(''));
          row = [];
          cols = 0;
        }
      }
      row.push(g);
      cols += gw;
    }
    out.push(row.join(''));
  }
  return out;
}
const wrapText = (text, width, words) =>
  words ? Array.from(buildLayout(String(text).split('\n'), { width: Math.max(1, width), tabWidth: 2, wordWrap: true }), (r) => r.text) : wrapMixed(text, width);
const wrapped = (text, inner, style = null, indent = '', words = false) => wrapText(text, inner - stringWidth(indent), words).map((part) => plain(indent + part, style));

/** One option of a dialog: `[key] label  description`; the description goes on its own row (or is left out) when it does not fit beside. */
function button(key, label, desc, action, inner, disabled, compact = false) {
  const segs = [];
  pushSeg(segs, ' ', null);
  pushSeg(segs, `[${key}]`, { bold: true, fg: disabled ? COLOR.dim : COLOR.accent });
  const labelStyle = disabled ? { dim: true } : { bold: true };
  const labelRoom = inner - stringWidth(`[${key}]`) - 2;
  if (stringWidth(label) > labelRoom && labelRoom >= 8) {
    // A label wider than the dialog (narrow terminals, long wording) continues on the next rows instead of being cut.
    const parts = wrapText(label, labelRoom, false);
    pushSeg(segs, ` ${parts[0]}`, labelStyle);
    const rows = [{ segs: fitSegs(segs, inner), action }];
    for (const part of parts.slice(1)) rows.push({ segs: fitSegs([{ text: `${' '.repeat(stringWidth(key) + 4)}${part}`, style: labelStyle }], inner), action });
    if (!compact) for (const part of wrapText(desc, inner - 5, false)) rows.push({ segs: fitSegs([{ text: `     ${part}`, style: { dim: true } }], inner), action });
    return rows;
  }
  pushSeg(segs, ` ${label}`, labelStyle);
  const used = segs.reduce((n, s) => n + stringWidth(s.text), 0);
  const gap = Math.max(2, 22 - used);
  const beside = used + gap + stringWidth(desc) <= inner;
  if (beside) {
    pushSeg(segs, ' '.repeat(gap), null);
    pushSeg(segs, desc, { dim: true });
    return [{ segs: fitSegs(segs, inner), action }];
  }
  const rows = [{ segs: fitSegs(segs, inner), action }];
  if (!compact) for (const part of wrapText(desc, inner - 5, false)) rows.push({ segs: fitSegs([{ text: `     ${part}`, style: { dim: true } }], inner), action });
  return rows;
}

// General tip below the buttons (not a button description): a headless resume is a one-shot start. Not pressable.
/**
 * The "session ended" dialog.
 * @param {object} o
 * @param {number} o.width @param {number} o.height
 * @param {object} o.d   dialog state: {queued, sessionId, reviewId, command?: string, copied?: boolean, error?: string, busy?: boolean}
 * @param {object | null} [o.headless]  headlessStatus() result
 */
export function channelCRows({ width, height, d, headless = null }) {
  return boxLayout({
    width,
    height,
    title: t('resume.title'),
    build: (inner, compact) => {
      const gap = () => (compact ? [] : [blank()]);
      const lines = [...gap()];
      const sid = d.sessionId ? ` (session ${String(d.sessionId).slice(0, 8)})` : '';
      lines.push(...wrapped(compact ? t('resume.introCompact', { queued: d.queued, sid }) : t('resume.intro', { reviewId: d.reviewId, queued: d.queued, sid }), inner));
      lines.push(...gap());
      const off = d.busy === true;
      lines.push(...button('c', t('resume.btnShow'), t('resume.btnShowDesc'), 'dialog:show', inner, off, compact));
      lines.push(...button('h', t('resume.btnHeadless'), t('resume.btnHeadlessDesc'), 'dialog:headless', inner, off, compact));
      lines.push(...button('l', t('resume.btnLeave'), t('resume.btnLeaveDesc'), 'dialog:leave', inner, off, compact));
      if (!compact) lines.push(...wrapped(t('resume.tip'), inner, { dim: true }, ' ')); // compact (little room): left out so that c/h/l and the Esc line stay
      const status = headlessLine(headless);
      if (d.busy) {
        lines.push(...gap(), plain(t('resume.starting'), { fg: COLOR.warn }));
      } else if (status) {
        lines.push(...gap(), ...wrapped(status, inner, { fg: headless.state === 'failed' ? COLOR.err : headless.state === 'running' ? COLOR.accent : undefined }, ' '));
      }
      if (d.command) {
        lines.push(...gap(), plain(t('resume.runInTerminal'), { dim: true }));
        lines.push(...wrapped(d.command, inner, { bold: true, fg: COLOR.accent }, '  ', true));
        if (!compact) lines.push(...wrapped(t('resume.copiedHint', { copied: d.copied, reviewId: d.reviewId }), inner, { dim: true }, ' '));
      }
      if (d.error) lines.push(...gap(), ...wrapped(`! ${d.error}`, inner, { fg: COLOR.warn, bold: true }));
      lines.push(...gap(), plain(compact ? t('resume.closeCompact') : t('resume.close'), { dim: true }));
      return lines;
    },
  });
}

/**
 * The `S` session picker.
 * @param {object} o
 * @param {number} o.width @param {number} o.height
 * @param {{items: import('./pickList.js').Candidate[], index: number, first?: number}} o.picker
 * @param {string} o.title
 */
export function pickerRows({ width, height, picker, title }) {
  return boxLayout({
    width,
    height,
    title,
    maxWidth: 100,
    build: (inner) => {
      const lines = [plain(t('resume.pickerHint'), { dim: true }), blank()];
      const room = Math.max(1, height - 2 - lines.length - 3);
      const first = pickWindow(picker.index, picker.items.length, room, picker.first ?? 0);
      picker.items.slice(first, first + room).forEach((c, k) => {
        lines.push({ segs: candidateLine(c, inner, first + k === picker.index), action: `pick:${first + k}` });
      });
      const cur = picker.items[picker.index];
      if (cur?.cwd) lines.push(blank(), plain(t('resume.pickerCwd', { cwd: ellipsizeStart(tildePath(cur.cwd), inner - 6) }), { dim: true }));
      return lines;
    },
  });
}
