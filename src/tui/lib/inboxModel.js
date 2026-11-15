// Inbox data model: ordering, filtering, and formatting of the list rows. Pure (moment is the only dependency).
import path from 'node:path';
import moment from 'moment';
import stringWidth from 'string-width';
import { fitSegs, pushSeg, ellipsize } from './ansi.js';
import { COLOR, GLYPH } from './theme.js';
import { t } from '../../i18n/index.js';

moment.updateLocale('en', {
  relativeTime: {
    future: 'in %s',
    past: '%s ago',
    s: '<1m',
    ss: '%ds',
    m: '1m',
    mm: '%dm',
    h: '1h',
    hh: '%dh',
    d: '1d',
    dd: '%dd',
    w: '1w',
    ww: '%dw',
    M: '1mo',
    MM: '%dmo',
    y: '1y',
    yy: '%dy',
  },
});

/** "5m ago" / "2h ago": the compact age used by the inbox and the session pick lists. */
export const ageText = (iso) => moment(iso).fromNow();

const FINAL = new Set(['approved', 'closed']);
export const isFinal = (m) => FINAL.has(m.status);

/** 0 = needs me now, 1 = Claude answered, 2 = in Claude's hands, 3 = everything else. */
export function tierOf(m) {
  switch (m.status) {
    case 'awaiting_review':
    case 'in_review': // the user is (or was) looking at it and has not decided yet
      return 0;
    case 'answered':
      return 1;
    case 'feedback_pending':
    case 'delivered':
      return 2;
    default:
      return 3;
  }
}

/** awaiting_review -> answered -> feedback_pending/delivered -> others; newest update first within a tier. */
export function sortMetas(metas) {
  return metas.slice().sort((a, b) => tierOf(a) - tierOf(b) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1));
}

export const visibleMetas = (metas, showAll) => sortMetas(showAll ? metas : metas.filter((m) => !isFinal(m)));

export function inboxCounts(metas) {
  let open = 0;
  let answered = 0;
  for (const m of metas) {
    if (isFinal(m)) continue;
    if (m.status === 'answered') answered++;
    else open++;
  }
  return { open, answered };
}

/**
 * @typedef {object} InboxRow
 * @property {string} id @property {string} kind @property {string} project @property {string} title
 * @property {string} status @property {string} age @property {number} tier @property {boolean} stale
 */

/**
 * @param {object[]} metas  already sorted / filtered
 * @param {{threads: Map<string, object[]>, hookAlive: Map<string, boolean>}} extra
 * @returns {InboxRow[]}
 */
export function buildRows(metas, extra) {
  return metas.map((m) => {
    const threads = extra.threads.get(m.id) ?? [];
    const answered = threads.filter((t) => t.status === 'answered' || t.status === 'resolved').length;
    let status = m.status;
    if (threads.length && ['answered', 'feedback_pending', 'delivered'].includes(m.status)) status += ` (${answered}/${threads.length})`;
    const waiting = m.kind === 'plan' && (m.status === 'awaiting_review' || m.status === 'in_review');
    const stale = waiting && !extra.hookAlive.get(m.id);
    return {
      id: m.id,
      kind: m.kind,
      project: m.cwd ? path.basename(m.cwd) : '',
      title: m.title || m.id,
      status,
      age: moment(m.updatedAt).fromNow(),
      tier: tierOf(m),
      stale,
    };
  });
}

/** Column widths for a terminal of `cols` columns. */
export function inboxColumns(cols) {
  const project = cols >= 100 ? 14 : cols >= 78 ? 10 : 0;
  const status = cols >= 100 ? 28 : cols >= 78 ? 24 : 18;
  const age = 9;
  const fixed = 2 + 6 + (project ? project + 1 : 0) + status + 1 + age + 1;
  return { project, status, age, title: Math.max(8, cols - fixed - 2) };
}

/** One list row as segments of exactly `cols` columns. */
export function formatRow(row, cols, selected) {
  const c = inboxColumns(cols);
  const segs = [];
  const bg = selected ? { bg: COLOR.bgBadge } : {};
  pushSeg(segs, ' ', bg);
  pushSeg(segs, row.tier <= 1 ? GLYPH.dot : GLYPH.ring, { fg: row.tier === 0 ? COLOR.warn : row.tier === 1 ? COLOR.ok : COLOR.dim, ...bg });
  pushSeg(segs, ' ', bg);
  pushSeg(segs, row.kind.padEnd(5), { fg: row.kind === 'plan' ? COLOR.purple : COLOR.blue, ...bg });
  if (c.project) pushSeg(segs, `${ellipsize(row.project, c.project)}${' '.repeat(Math.max(0, c.project - stringWidth(ellipsize(row.project, c.project))))} `, { fg: COLOR.accent, ...bg });
  const title = ellipsize(row.title, c.title);
  pushSeg(segs, title + ' '.repeat(Math.max(0, c.title - stringWidth(title))), { bold: row.tier === 0, ...bg });
  pushSeg(segs, '  ', bg);
  const status = ellipsize(row.stale ? `${row.status} · ${t('inbox.notWaiting')}` : row.status, c.status);
  pushSeg(segs, status + ' '.repeat(Math.max(0, c.status - stringWidth(status))), { fg: row.stale ? COLOR.dim : row.tier === 0 ? COLOR.warn : row.tier === 1 ? COLOR.ok : COLOR.dim, ...bg });
  pushSeg(segs, ' ', bg);
  const age = row.age.padStart(c.age);
  pushSeg(segs, age, { dim: true, ...bg });
  return fitSegs(segs, cols, selected ? bg : null);
}
