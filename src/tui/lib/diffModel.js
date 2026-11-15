// Data model of the diff view (`d`): the rows to draw for "revision <base> -> current revision", the base revision
// stepping (`<` / `>`) and the lookups between diff rows and document lines. Pure; the only store access is
// `loadDiffModel`, which reads the two revision files.
//
// The diff is made on the SOURCE text of the revisions (never on the rendered Markdown), with the same line model as the
// review screen, so a row's `newLine` is the line number the normal view shows. A change that only adds or removes the
// trailing newline is invisible there and therefore invisible here as well.
import { diffRevisions } from '../../feedback/diff.js';
import { readRevision } from '../../store/reviews.js';

/** The text as the review screen shows it: CRLF -> LF, and the empty "line" after a final newline dropped. */
export function viewText(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

export const revisionNumbers = (meta) => (meta.revisions ?? []).map((r) => r.n);

/** Revisions that can serve as the base of a comparison with the current one (all but the current). */
export const baseCandidates = (meta) => revisionNumbers(meta).slice(0, -1);

/** The base revision to compare against: the explicit choice when it is still valid, else the previous revision; null with a single revision. */
export function resolveBase(meta, base) {
  const older = baseCandidates(meta);
  if (older.length === 0) return null;
  return base != null && older.includes(base) ? base : older[older.length - 1];
}

/**
 * `<` (dir -1: an older base) and `>` (dir +1: a newer base, at most the revision before the current one).
 * @returns {{base: number, edge: boolean}}  `edge`: already at the end of the range (base unchanged)
 */
export function stepBase(meta, base, dir) {
  const older = baseCandidates(meta);
  const cur = resolveBase(meta, base);
  const i = older.indexOf(cur);
  const j = i + dir;
  if (j < 0 || j >= older.length) return { base: cur, edge: true };
  return { base: older[j], edge: false };
}

/** Digits needed for the largest line number of either side. */
const digits = (n) => String(Math.max(1, n)).length;

/**
 * @typedef {object} DiffModel
 * @property {'rows'|'tooLarge'|'identical'} kind
 * @property {number} from @property {number} to   revision numbers compared
 * @property {{added: number, removed: number}} summary
 * @property {boolean} approximate  the summary of a too large diff is a line-multiset estimate
 * @property {import('../../feedback/diff.js').Line[]} rows  every line of both documents in order (kind ctx / add / del)
 * @property {string[]} texts       row texts (what the layout wraps)
 * @property {number[]} changeStarts  index of the first row of each block of changed rows
 * @property {Map<number, number>} rowOfNew  0-based new line -> row index (ctx and add rows)
 * @property {number} numWidth      width of one line-number column
 * @property {number} gutterWidth   old number, space, new number, thread marker, sign, bar, space
 */

/**
 * @param {string} oldText @param {string} newText
 * @param {{from: number, to: number}} revs
 * @returns {DiffModel}
 */
export function buildDiffModel(oldText, newText, { from, to }) {
  const d = diffRevisions(viewText(oldText), viewText(newText), { context: Infinity });
  const base = { from, to, summary: d.summary, approximate: d.approximate === true, rows: [], texts: [], changeStarts: [], rowOfNew: new Map(), numWidth: 1, gutterWidth: 2 + 5 };
  if (d.tooLarge) return { ...base, kind: 'tooLarge' };
  if (d.identical) return { ...base, kind: 'identical' };
  const rows = d.hunks[0]?.lines ?? [];
  const changeStarts = [];
  const rowOfNew = new Map();
  let maxOld = 0;
  let maxNew = 0;
  rows.forEach((r, i) => {
    if (r.kind !== 'ctx' && (i === 0 || rows[i - 1].kind === 'ctx')) changeStarts.push(i);
    if (r.newLine != null) {
      rowOfNew.set(r.newLine - 1, i);
      maxNew = Math.max(maxNew, r.newLine);
    }
    if (r.oldLine != null) maxOld = Math.max(maxOld, r.oldLine);
  });
  const numWidth = digits(Math.max(maxOld, maxNew));
  return { ...base, kind: 'rows', rows, texts: rows.map((r) => r.text), changeStarts, rowOfNew, numWidth, gutterWidth: 2 * numWidth + 5 };
}

/**
 * Read the two revisions and build the model. Base `null` = the previous revision.
 * @returns {DiffModel | null}  null when the review has a single revision
 */
export function loadDiffModel(id, meta, base, { readRev = readRevision } = {}) {
  const from = resolveBase(meta, base);
  if (from == null) return null;
  const to = meta.currentRevision;
  return buildDiffModel(readRev(id, from), readRev(id, to), { from, to });
}

/** 0-based new-side line of a row, null for a removed line. */
export const newLine0 = (model, idx) => (model.rows[idx]?.newLine != null ? model.rows[idx].newLine - 1 : null);

/**
 * The 0-based line of the normal view that `Enter` jumps to from row `idx`: the row's own new line; for a removed line
 * the next line that exists in the new text (where the deletion happened), else the last one.
 */
export function jumpLine0(model, idx, lineCount) {
  for (let i = idx; i < model.rows.length; i++) {
    if (model.rows[i].newLine != null) return Math.min(model.rows[i].newLine - 1, Math.max(0, lineCount - 1));
  }
  return Math.max(0, lineCount - 1);
}

/** First row of the block of changed rows that contains `idx`, or null when `idx` is an unchanged row. */
export function blockStart(model, idx) {
  if (model.rows[idx]?.kind === 'ctx') return null;
  let i = idx;
  while (i > 0 && model.rows[i - 1].kind !== 'ctx') i--;
  return i;
}

/** The next / previous block of changes relative to row `idx`; null when there is none in that direction. */
export function stepChange(model, idx, dir) {
  const starts = model.changeStarts;
  if (dir > 0) return starts.find((i) => i > idx) ?? null;
  const here = blockStart(model, idx);
  const limit = here ?? idx;
  for (let k = starts.length - 1; k >= 0; k--) if (starts[k] < limit) return starts[k];
  return null;
}

/** The first new-side line number visible in rows [from, from + n) - used to anchor the panel (null when none). */
export function firstNewLine0(model, rowIdxs) {
  for (const i of rowIdxs) {
    const l = newLine0(model, i);
    if (l != null) return l;
  }
  return null;
}
