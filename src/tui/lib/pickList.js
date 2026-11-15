// Pick lists of Claude Code sessions: the `S` key of the review screen (rebind to another session) and the candidate chooser
// of `rd add` / `rd open <path>` (src/tui/pickCandidate.js). Pure: items, their one-line rendering and the selection index.
import path from 'node:path';
import stringWidth from 'string-width';
import { fitSegs, pushSeg, ellipsize } from './ansi.js';
import { ageText } from './inboxModel.js';
import { COLOR } from './theme.js';
import { t } from '../../i18n/index.js';

export { ellipsize };

/**
 * @typedef {object} Candidate
 * @property {string} sessionId
 * @property {string | null} [cwd] @property {string} [project] @property {string | null} [lastAt]
 * @property {string} [firstPrompt] @property {string} [source]  'writes' | 'transcript' | 'explicit'
 * @property {boolean} [current]  the session the review is bound to now
 */

const padTo = (text, width) => text + ' '.repeat(Math.max(0, width - stringWidth(text)));

/** The sessions a document review can be bound to: `meta.writers`, and the current session (marked, first) even when not listed. */
export function sessionChoices(meta) {
  const items = [];
  const seen = new Set();
  const writers = Array.isArray(meta.writers) ? meta.writers : [];
  if (meta.sessionId) {
    const w = writers.find((x) => x?.sessionId === meta.sessionId);
    items.push({
      sessionId: meta.sessionId,
      cwd: w?.cwd ?? meta.cwd ?? null,
      project: w?.project || (meta.cwd ? path.basename(meta.cwd) : ''),
      lastAt: w?.lastAt ?? null,
      firstPrompt: w?.firstPrompt ?? '',
      source: w?.source ?? 'current',
      current: true,
    });
    seen.add(meta.sessionId);
  }
  for (const w of writers) {
    if (!w?.sessionId || seen.has(w.sessionId)) continue;
    seen.add(w.sessionId);
    items.push({ sessionId: w.sessionId, cwd: w.cwd ?? null, project: w.project || (w.cwd ? path.basename(w.cwd) : ''), lastAt: w.lastAt ?? null, firstPrompt: w.firstPrompt ?? '', source: w.source ?? 'writes', current: false });
  }
  return items;
}

/**
 * One list row: marker, project, age, short session id, first prompt (and "current" for the bound session).
 * @param {Candidate} c @param {number} width @param {boolean} selected
 * @returns {import('./ansi.js').Segment[]}  exactly `width` columns
 */
export function candidateLine(c, width, selected) {
  const bg = selected ? { bg: COLOR.bgBadge } : {};
  const segs = [];
  pushSeg(segs, selected ? '▸ ' : '  ', { fg: COLOR.accent, bold: true, ...bg });
  pushSeg(segs, padTo(ellipsize(c.project || '?', 14), 14), { fg: COLOR.accent, ...bg });
  pushSeg(segs, ' ', bg);
  pushSeg(segs, padTo(c.lastAt ? ageText(c.lastAt) : '', 8), { dim: true, ...bg });
  pushSeg(segs, ' ', bg);
  pushSeg(segs, `${String(c.sessionId).slice(0, 8)} `, { dim: true, ...bg });
  if (c.current) pushSeg(segs, t('pick.current'), { fg: COLOR.ok, bold: true, ...bg });
  const used = segs.reduce((n, s) => n + stringWidth(s.text), 0);
  const prompt = (c.firstPrompt || '').replace(/\s+/g, ' ');
  pushSeg(segs, ellipsize(prompt, Math.max(0, width - used)), bg);
  return fitSegs(segs, width, selected ? bg : null);
}

/** Selection index after a list key. */
export function movePick(index, count, key) {
  if (count <= 0) return 0;
  switch (key) {
    case 'down':
      return Math.min(count - 1, index + 1);
    case 'up':
      return Math.max(0, index - 1);
    case 'top':
      return 0;
    case 'bottom':
      return count - 1;
    default:
      return index;
  }
}

/** First visible item so that `index` is inside a window of `height` rows. */
export function pickWindow(index, count, height, first = 0) {
  const h = Math.max(1, height);
  let f = Math.min(first, Math.max(0, count - h));
  if (index < f) f = index;
  if (index >= f + h) f = index - h + 1;
  return Math.max(0, f);
}
