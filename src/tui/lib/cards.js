// Thread cards: the lines shown for one thread in the right-hand panel or the bottom drawer.
import { buildLayout } from '../mouse/layout.js';
import { fitSegs, pushSeg } from './ansi.js';
import { COLOR, GLYPH, threadColor } from './theme.js';
import { isPending } from '../../store/threads.js';
import { lineLabel, isOrphan } from './threadView.js';
import { textWidth } from '../input/text.js';
import { t, currentLang } from '../../i18n/index.js';

/** Wrap plain text to `width` columns (CJK aware); explicit newlines are kept. */
export function wrapPlain(text, width) {
  const w = Math.max(1, width);
  const out = [];
  for (const row of buildLayout(String(text).replace(/\r\n/g, '\n').split('\n'), { width: w, tabWidth: 2 })) out.push(row.text);
  return out;
}

const AUTHOR = {
  user: { name: () => t('card.you'), fg: COLOR.accent },
  claude: { name: () => 'Claude', fg: COLOR.ok },
  system: { name: () => t('card.system'), fg: COLOR.dim },
};

/** A system message with a `kind` is shown in the reader's language; one without (stored by an older version) as it was stored. */
const SYSTEM_KINDS = { unanswered: 'notes.unanswered' };
const messageText = (m) => (m.author === 'system' && SYSTEM_KINDS[m.kind] ? t(SYSTEM_KINDS[m.kind]) : m.text);

const cache = new WeakMap();

/**
 * @param {object} thread
 * @param {number} width           columns of the card (the caller adds its own margin)
 * @param {object} [opts]
 * @param {boolean} [opts.focused]
 * @param {string}  [opts.pendingLabel]  text of the "waiting for Claude" line
 * @param {number}  [opts.currentRevision]  shows "@rev n" when the anchor belongs to an older revision
 * @returns {import('./ansi.js').Segment[][]}  rows of exactly `width` columns
 */
export function buildCard(thread, width, { focused = false, pendingLabel = t('delivery.answering'), currentRevision } = {}) {
  const key = `${currentLang()}|${width}|${focused}|${pendingLabel}|${currentRevision}`;
  let perThread = cache.get(thread);
  if (!perThread) cache.set(thread, (perThread = new Map()));
  const hit = perThread.get(key);
  if (hit) return hit;

  const rows = [];
  const a = thread.anchor;
  const color = threadColor(thread.status);
  const statusText = thread.status === 'resolved' ? 'resolved ✓' : thread.status;
  const drafts = thread.messages.filter((m) => m.author === 'user' && m.state === 'draft').length;

  // Header
  const bg = focused ? { bg: COLOR.bgFocus } : {};
  const head = [];
  pushSeg(head, GLYPH.marker, { fg: color, ...bg });
  let title = `${thread.id}${GLYPH.sep}${lineLabel(a)}${GLYPH.sep}${statusText}`;
  if (drafts) title += `${GLYPH.sep}${t('card.drafts', { n: drafts })}`;
  if (currentRevision != null && a.revision != null && a.revision !== currentRevision) title += ` @rev${a.revision}`;
  pushSeg(head, title, { bold: true, fg: thread.status === 'resolved' ? COLOR.dim : undefined, ...bg });
  rows.push(fitSegs(head, width, focused ? bg : null));

  // Orphaned threads keep their quote so the user can still tell what they were about.
  if (isOrphan(thread) && a.quote) {
    const q = wrapPlain(`“${a.quote.replace(/\s+/g, ' ').trim()}”`, width - 2);
    const shown = q.slice(0, 2);
    if (q.length > 2) shown[1] = `${shown[1].slice(0, Math.max(0, shown[1].length - 1))}…`;
    for (const line of shown) rows.push(fitSegs([{ text: `  ${line}`, style: { dim: true, italic: true } }], width));
  }

  for (const m of thread.messages) {
    const who = AUTHOR[m.author] ?? AUTHOR.system;
    const label = `${who.name()}${m.state === 'draft' ? t('card.draftSuffix') : ''}: `;
    const labelW = textWidth(label);
    const body = wrapPlain(messageText(m), Math.max(4, width - 2 - labelW));
    body.forEach((line, i) => {
      const segs = [];
      if (i === 0) {
        pushSeg(segs, '  ', null);
        pushSeg(segs, label, { fg: m.state === 'draft' ? COLOR.warn : who.fg, bold: true });
      } else {
        pushSeg(segs, ' '.repeat(2 + labelW), null);
      }
      pushSeg(segs, line, m.author === 'system' ? { dim: true } : null);
      rows.push(fitSegs(segs, width));
    });
  }

  if (isPending(thread)) {
    for (const line of wrapPlain(pendingLabel, Math.max(4, width - 2))) rows.push(fitSegs([{ text: `  ${line}`, style: { fg: COLOR.warn, dim: true } }], width));
  }

  perThread.set(key, rows);
  if (perThread.size > 12) perThread.delete(perThread.keys().next().value);
  return rows;
}
