// Line diff between two revisions of a document, for the TUI's diff view (`d`).
//
// Lines are split exactly like the review screen and the anchors do it (CRLF -> LF, then split on "\n"), so `newLine` is the
// line number the normal view shows and `oldLine` the one of the older revision.
//
// diffRevisions(oldText, newText, { context = 3, words = true }) ->
//   { identical, tooLarge, approximate?, summary: {added, removed}, hunks: Hunk[] }
//   Hunk = { oldStart, oldCount, newStart, newCount, lines: Line[] }     (1-based starts; a side with 0 lines has start = the line before)
//   Line = { kind: 'ctx' | 'add' | 'del', oldLine?, newLine?, text, words?: [from, to][] }
//     ctx has both numbers, add only `newLine`, del only `oldLine`. `words` (only on a del/add line that is paired with an
//     add/del line of the same change block, both <= 500 chars) lists the UTF-16 ranges of `text` that differ at word level
//     (diffWordsWithSpace); the unchanged remainder is not listed.
//   `context`: unchanged lines kept around each change; Infinity gives the whole document as one hunk (the diff view
//   shows the full file with the changes marked).
//   More than 2000 changed lines (added + removed): `{ tooLarge: true, hunks: [], summary }`, nothing else is computed.
import { diffArrays, diffWordsWithSpace } from 'diff';

export const MAX_CHANGED_LINES = 2000;
export const MAX_WORD_DIFF_CHARS = 500;

/** The review screen's line model. */
export const splitLines = (text) => String(text ?? '').replace(/\r\n/g, '\n').split('\n');

/** Line counts of added/removed lines without an exact diff: multiset difference (ignores reordering). */
function approximateSummary(a, b) {
  const counts = new Map();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return { added, removed };
}

/** Word-level ranges for a paired removed/added line: [oldRanges, newRanges]. */
function wordRanges(oldLine, newLine) {
  if (oldLine.length > MAX_WORD_DIFF_CHARS || newLine.length > MAX_WORD_DIFF_CHARS) return null;
  const del = [];
  const add = [];
  let o = 0;
  let n = 0;
  for (const part of diffWordsWithSpace(oldLine, newLine)) {
    if (part.removed) {
      del.push([o, o + part.value.length]);
      o += part.value.length;
    } else if (part.added) {
      add.push([n, n + part.value.length]);
      n += part.value.length;
    } else {
      o += part.value.length;
      n += part.value.length;
    }
  }
  return [del, add];
}

/** Every line of both documents in order, with its kind and numbers. Consecutive del/add runs get their word marks. */
function lineSequence(a, b, wantWords) {
  const changes = diffArrays(a, b, { maxEditLength: MAX_CHANGED_LINES });
  if (!changes) return null; // more than 2000 changed lines
  const seq = [];
  let o = 1;
  let n = 1;
  let blockStart = -1;
  const markWords = (from, to) => {
    if (!wantWords) return;
    const dels = [];
    const adds = [];
    for (let i = from; i < to; i++) (seq[i].kind === 'del' ? dels : adds).push(seq[i]);
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
      const r = wordRanges(dels[i].text, adds[i].text);
      if (!r) continue;
      if (r[0].length) dels[i].words = r[0];
      if (r[1].length) adds[i].words = r[1];
    }
  };
  for (const c of changes) {
    for (const text of c.value) {
      if (c.removed) seq.push({ kind: 'del', oldLine: o++, text });
      else if (c.added) seq.push({ kind: 'add', newLine: n++, text });
      else seq.push({ kind: 'ctx', oldLine: o++, newLine: n++, text });
    }
    if (c.added || c.removed) {
      if (blockStart < 0) blockStart = seq.length - c.value.length;
    } else if (blockStart >= 0) {
      markWords(blockStart, seq.length - c.value.length);
      blockStart = -1;
    }
  }
  if (blockStart >= 0) markWords(blockStart, seq.length);
  return seq;
}

/** Cut the sequence into hunks: each change with `context` unchanged lines around it, overlapping ones merged. */
function toHunks(seq, context) {
  const hunks = [];
  let cur = null; // {from, to} index range, inclusive
  const ranges = [];
  // oldBefore[i] / newBefore[i]: how many lines of each side precede seq[i] (the start of a side that has no line in a hunk)
  const oldBefore = [];
  const newBefore = [];
  let o = 0;
  let n = 0;
  for (const l of seq) {
    oldBefore.push(o);
    newBefore.push(n);
    if (l.kind !== 'add') o++;
    if (l.kind !== 'del') n++;
  }
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].kind === 'ctx') continue;
    const from = Math.max(0, i - context);
    const to = Math.min(seq.length - 1, i + context);
    if (cur && from <= cur.to + 1) cur.to = Math.max(cur.to, to);
    else {
      cur = { from, to };
      ranges.push(cur);
    }
  }
  for (const { from, to } of ranges) {
    const lines = seq.slice(from, to + 1);
    const olds = lines.filter((l) => l.kind !== 'add');
    const news = lines.filter((l) => l.kind !== 'del');
    hunks.push({
      oldStart: olds.length ? olds[0].oldLine : oldBefore[from],
      oldCount: olds.length,
      newStart: news.length ? news[0].newLine : newBefore[from],
      newCount: news.length,
      lines,
    });
  }
  return hunks;
}

/**
 * @param {string} oldText
 * @param {string} newText
 * @param {{context?: number, words?: boolean}} [opts]
 */
export function diffRevisions(oldText, newText, { context = 3, words = true } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const seq = lineSequence(a, b, words);
  if (!seq) return { identical: false, tooLarge: true, approximate: true, summary: approximateSummary(a, b), hunks: [] };
  const added = seq.filter((l) => l.kind === 'add').length;
  const removed = seq.filter((l) => l.kind === 'del').length;
  if (added + removed > MAX_CHANGED_LINES) return { identical: false, tooLarge: true, summary: { added, removed }, hunks: [] };
  return { identical: added + removed === 0, tooLarge: false, summary: { added, removed }, hunks: toHunks(seq, context) };
}
