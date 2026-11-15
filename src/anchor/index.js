// Anchor creation and re-location across revisions.
// Lines are 1-based. startCol/endCol are 0-based UTF-16 offsets within their
// line (endCol exclusive); both null means "whole lines".
import DiffMatchPatch from 'diff-match-patch';

const MAX_BITS = 32; // diff-match-patch bitap pattern limit

const normalize = (s) => s.replace(/\r\n/g, '\n');

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Build an anchor for a selection in `content`. */
export function makeAnchor(content, sel, revision) {
  const text = normalize(content);
  const lines = text.split('\n');
  const { startLine, endLine } = sel;
  if (!(startLine >= 1 && endLine >= startLine && endLine <= lines.length)) {
    throw new Error(`invalid line range ${startLine}-${endLine}`);
  }
  const hasCols = sel.startCol != null && sel.endCol != null;
  let quote;
  if (hasCols) {
    const starts = lineStarts(text);
    const from = starts[startLine - 1] + sel.startCol;
    const to = starts[endLine - 1] + sel.endCol;
    quote = text.slice(from, to);
  } else {
    quote = lines.slice(startLine - 1, endLine).join('\n');
  }
  return {
    revision,
    startLine,
    endLine,
    startCol: hasCols ? sel.startCol : null,
    endCol: hasCols ? sel.endCol : null,
    quote,
    before: startLine > 1 ? lines[startLine - 2] : '',
    after: endLine < lines.length ? lines[endLine] : '',
    orphaned: false,
  };
}

function findAll(text, needle) {
  const hits = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    hits.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return hits;
}

function similarity(a, b, dmp) {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - dmp.diff_levenshtein(dmp.diff_main(a, b)) / max;
}

/**
 * Locate an anchor in new content.
 * @returns {{found:boolean, method?:string, startLine?, endLine?, startCol?, endCol?, quote?}}
 */
export function locate(anchor, content, opts = {}) {
  const threshold = opts.threshold ?? 0.5;
  const text = normalize(content);
  const quote = normalize(anchor.quote || '');
  if (!quote) return { found: false };

  const starts = lineStarts(text);
  const lines = text.split('\n');
  const wholeLines = anchor.startCol == null || anchor.endCol == null;

  const finish = (from, to, method) => {
    const end = Math.max(from, to - 1);
    const startLine = lineOf(starts, from);
    const endLine = lineOf(starts, end);
    if (wholeLines) {
      return {
        found: true,
        method,
        startLine,
        endLine,
        startCol: null,
        endCol: null,
        quote: lines.slice(startLine - 1, endLine).join('\n'),
      };
    }
    return {
      found: true,
      method,
      startLine,
      endLine,
      startCol: from - starts[startLine - 1],
      endCol: to - starts[endLine - 1],
      quote: text.slice(from, to),
    };
  };

  // 1 + 2: exact matches, disambiguated by context.
  let hits = findAll(text, quote);
  if (wholeLines && hits.length > 1) {
    const aligned = hits.filter((h) => {
      const atStart = h === 0 || text[h - 1] === '\n';
      const e = h + quote.length;
      return atStart && (e === text.length || text[e] === '\n');
    });
    if (aligned.length) hits = aligned;
  }
  if (hits.length === 1) return finish(hits[0], hits[0] + quote.length, 'exact');
  if (hits.length > 1) {
    const hint = anchor.startLine ?? 1;
    const scored = hits.map((h) => {
      const sl = lineOf(starts, h);
      const el = lineOf(starts, Math.max(h, h + quote.length - 1));
      const before = sl > 1 ? lines[sl - 2] : '';
      const after = el < lines.length ? lines[el] : '';
      const score = (before.trim() === (anchor.before || '').trim() ? 1 : 0) + (after.trim() === (anchor.after || '').trim() ? 1 : 0);
      return { h, score, dist: Math.abs(sl - hint) };
    });
    scored.sort((a, b) => b.score - a.score || a.dist - b.dist);
    return finish(scored[0].h, scored[0].h + quote.length, 'context');
  }

  // 3: fuzzy match with diff-match-patch.
  if (quote.trim().length < 4) return { found: false };
  const dmp = new DiffMatchPatch();
  dmp.Match_Threshold = threshold;
  dmp.Match_Distance = Math.max(1000, text.length);
  const expectLoc = starts[Math.min((anchor.startLine ?? 1) - 1, starts.length - 1)] + (anchor.startCol ?? 0);
  const head = quote.slice(0, MAX_BITS);
  let idx = dmp.match_main(text, head, expectLoc);
  if (idx === -1 && quote.length > MAX_BITS) {
    // Head may have been edited: locate by the tail and walk back.
    const tail = quote.slice(-MAX_BITS);
    const t = dmp.match_main(text, tail, expectLoc + Math.max(0, quote.length - MAX_BITS));
    if (t !== -1) idx = Math.max(0, t + tail.length - quote.length);
  }
  if (idx === -1) return { found: false };
  const to = Math.min(text.length, idx + quote.length);
  const window = text.slice(idx, to);
  if (similarity(window, quote, dmp) < 1 - threshold) return { found: false };
  return finish(idx, to, 'fuzzy');
}

/**
 * Re-anchor every unresolved thread against new content (mutates the threads).
 * Resolved threads are left alone. Orphaned threads keep their old quote/lines.
 */
export function reanchor(threads, content, revision, opts = {}) {
  const text = normalize(content);
  const lines = text.split('\n');
  for (const t of threads) {
    if (t.status === 'resolved') continue;
    const a = t.anchor;
    const r = locate(a, text, opts);
    if (!r.found) {
      a.orphaned = true;
      continue;
    }
    a.revision = revision;
    a.startLine = r.startLine;
    a.endLine = r.endLine;
    a.startCol = r.startCol;
    a.endCol = r.endCol;
    a.quote = r.quote;
    a.before = r.startLine > 1 ? lines[r.startLine - 2] : '';
    a.after = r.endLine < lines.length ? lines[r.endLine] : '';
    a.orphaned = false;
  }
  return threads;
}
