// The comment lines at the top of the temp file `$EDITOR` is started on (src/tui/input/externalEditor.js drops exactly these
// lines from the result). They say what is being commented on and what saving does.
import stringWidth from 'string-width';
import { t } from '../../i18n/index.js';

const MAX_QUOTE_LINES = 3;
const MAX_QUOTE_COLS = 90;

/** Cut a line to `width` columns, with an ellipsis. */
function clip(text, width) {
  if (stringWidth(text) <= width) return text;
  let out = '';
  for (const ch of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (stringWidth(out + ch.segment) > width - 1) break;
    out += ch.segment;
  }
  return `${out}…`;
}

/**
 * @param {object} o
 * @param {'comment'|'reply'} o.kind
 * @param {string} o.label            'L14-16' for a comment, the thread id for a reply
 * @param {string} [o.quote]          the quoted source text (the first lines are shown)
 * @param {'instant'|'batch'} o.sendMode
 * @param {'send'|'box'} [o.purpose]  'send': the result goes straight out (C / R); 'box': it goes back into the comment box (Ctrl+E)
 * @returns {string[]} lines, each starting with `# `
 */
export function buildEditorHeader({ kind, label, quote = '', sendMode, purpose = 'send' }) {
  const lines = [`# Review Desk · ${kind === 'reply' ? t('editor.reply') : t('editor.comment')} ${label}`];
  const q = String(quote).replace(/\r\n/g, '\n').split('\n');
  while (q.length && q[q.length - 1] === '') q.pop();
  if (q.length) {
    lines.push(t('editor.quote'));
    for (const l of q.slice(0, MAX_QUOTE_LINES)) lines.push(`#   > ${clip(l.replace(/\t/g, '  '), MAX_QUOTE_COLS)}`);
    if (q.length > MAX_QUOTE_LINES) lines.push(t('editor.moreLines', { n: q.length - MAX_QUOTE_LINES }));
  }
  lines.push(
    purpose === 'box'
      ? t('editor.backToBox')
      : t('editor.saveQuit', { what: sendMode === 'batch' ? t('editor.saveDraft') : t('editor.send') }),
  );
  lines.push(t('editor.notSent'));
  return lines;
}
