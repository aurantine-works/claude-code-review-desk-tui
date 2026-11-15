// Inline Markdown for the half-rendered view: decides, for every UTF-16 unit of a source line, whether it is hidden,
// replaced by a glyph, and which emphasis flags apply. Nothing here builds the display text; mdRender.js does that
// from these attributes, so the display <-> source mapping stays a plain "skip / replace one unit" affair.
//
// Rules (a pragmatic subset of CommonMark + GFM strikethrough, one line at a time):
//   `code` (any backtick run length), \* escapes, **bold** / __bold__, *italic* / _italic_ (intra-word `_` is no
//   emphasis), ***both***, ~~strike~~, [text](url), [text][ref], ![alt](src), <https://autolink>.
//   Unmatched markers stay visible. Emphasis never spans lines. CJK punctuation counts as a letter when deciding
//   whether a delimiter can open / close, so a closing `**` right before CJK text works (strict CommonMark would refuse it).

export const FLAG = { BOLD: 1, ITALIC: 2, STRIKE: 4, CODE: 8, LINK: 16, IMAGE: 32 };

// One scratch record is reused for every line (rendering is sequential and never re-entrant), so a 2000 line document
// does not allocate 4000 typed arrays. The caller must be done with the previous result before asking for the next.
const scratch = { hide: new Uint8Array(512), flags: new Uint8Array(512), rep: new Map() };

/** Cleared per-unit attributes for a source line of `len` units: hide, flags and rep (unit -> replacement glyph). */
export function newAttrs(len) {
  if (len > scratch.hide.length) {
    const size = Math.max(len, scratch.hide.length * 2);
    scratch.hide = new Uint8Array(size);
    scratch.flags = new Uint8Array(size);
  } else {
    scratch.hide.fill(0, 0, len);
    scratch.flags.fill(0, 0, len);
  }
  scratch.rep.clear();
  return scratch;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const CJK_PUNCT = /[‘-‟　-〿＀-￯]/;
const UNI_PUNCT = /[\p{P}\p{S}]/u;
const AUTOLINK = /<(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/y;

const isWs = (ch) => ch === undefined || /\s/.test(ch);
const isPunct = (ch) => ch !== undefined && UNI_PUNCT.test(ch) && !CJK_PUNCT.test(ch);

/** The code point just before / at index i inside [from, to), or undefined at the region edge. */
function charBefore(text, i, from) {
  if (i <= from) return undefined;
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i - 2 >= from) return text.slice(i - 2, i);
  return text[i - 1];
}
function charAt(text, i, to) {
  if (i >= to) return undefined;
  const cp = text.codePointAt(i);
  return String.fromCodePoint(cp);
}

/** End (exclusive) of the backtick run that closes a code span opened by a run of `n` backticks at `from`, or -1. */
function findCodeClose(text, from, to, n) {
  let k = from;
  while (k < to) {
    if (text[k] !== '`') {
      k++;
      continue;
    }
    let m = k;
    while (m < to && text[m] === '`') m++;
    if (m - k === n) return k;
    k = m;
  }
  return -1;
}

/**
 * `[text](url)` / `[text][ref]` starting at text[open] === '['.
 * @returns {{textEnd: number, end: number} | null}  textEnd = index of the closing `]`, end = just past the link
 */
function matchLink(text, open, to) {
  let depth = 0;
  let k = open;
  for (; k < to; k++) {
    const ch = text[k];
    if (ch === '\\') {
      k++;
      continue;
    }
    if (ch === '`') {
      let j = k;
      while (j < to && text[j] === '`') j++;
      const close = findCodeClose(text, j, to, j - k);
      k = close >= 0 ? close + (j - k) - 1 : j - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (k >= to || k === open + 1) return null; // unbalanced or empty text
  const textEnd = k;
  const next = text[textEnd + 1];
  if (next === '(') {
    let p = textEnd + 2;
    if (text[p] === '<') {
      const gt = text.indexOf('>', p + 1);
      if (gt < 0 || gt >= to) return null;
      p = gt + 1;
      while (p < to && text[p] !== ')') p++;
      return p < to ? { textEnd, end: p + 1 } : null;
    }
    let paren = 1;
    for (; p < to; p++) {
      const ch = text[p];
      if (ch === '\\') p++;
      else if (ch === '(') paren++;
      else if (ch === ')' && --paren === 0) return { textEnd, end: p + 1 };
    }
    return null;
  }
  if (next === '[') {
    for (let q = textEnd + 2; q < to; q++) {
      if (text[q] === '\\') q++;
      else if (text[q] === '[') return null;
      else if (text[q] === ']') return { textEnd, end: q + 1 };
    }
  }
  return null;
}

function hideRange(attrs, from, to) {
  for (let i = from; i < to; i++) attrs.hide[i] = 1;
}
function flagRange(attrs, from, to, bit) {
  for (let i = from; i < to; i++) attrs.flags[i] |= bit;
}

/**
 * Parse the inline Markdown in text[from, to) and record the result in `attrs`.
 * @param {string} text   the whole source line
 * @param {number} from @param {number} to
 * @param {ReturnType<typeof newAttrs>} attrs
 */
export function parseInline(text, from, to, attrs) {
  const delims = [];
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 < to && ASCII_PUNCT.test(text[i + 1])) {
        attrs.hide[i] = 1;
        i += 2;
      } else i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < to && text[j] === '`') j++;
      const n = j - i;
      const close = findCodeClose(text, j, to, n);
      if (close < 0) {
        i = j; // a literal backtick run
        continue;
      }
      hideRange(attrs, i, j);
      hideRange(attrs, close, close + n);
      flagRange(attrs, j, close, FLAG.CODE);
      // One space on both sides is padding (CommonMark), unless the content is only spaces.
      if (close - j >= 2 && text[j] === ' ' && text[close - 1] === ' ' && /[^ ]/.test(text.slice(j, close))) {
        attrs.hide[j] = 1;
        attrs.hide[close - 1] = 1;
      }
      i = close + n;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      const link = matchLink(text, i + 1, to);
      if (link) {
        attrs.rep.set(i, '▫');
        attrs.flags[i] |= FLAG.IMAGE;
        attrs.hide[i + 1] = 1;
        parseInline(text, i + 2, link.textEnd, attrs);
        flagRange(attrs, i + 2, link.textEnd, FLAG.IMAGE);
        hideRange(attrs, link.textEnd, link.end);
        i = link.end;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[') {
      const link = matchLink(text, i, to);
      if (link) {
        attrs.hide[i] = 1;
        parseInline(text, i + 1, link.textEnd, attrs);
        flagRange(attrs, i + 1, link.textEnd, FLAG.LINK);
        hideRange(attrs, link.textEnd, link.end);
        i = link.end;
        continue;
      }
      i++;
      continue;
    }
    if (c === '<') {
      AUTOLINK.lastIndex = i;
      const m = AUTOLINK.exec(text);
      if (m && i + m[0].length <= to) {
        const end = i + m[0].length;
        attrs.hide[i] = 1;
        attrs.hide[end - 1] = 1;
        flagRange(attrs, i + 1, end - 1, FLAG.LINK);
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < to && text[j] === c) j++;
      const n = j - i;
      if (c === '~' && n !== 2) {
        i = j;
        continue;
      }
      const prev = charBefore(text, i, from);
      const next = charAt(text, j, to);
      const left = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
      const right = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
      let open = left;
      let close = right;
      if (c === '_') {
        open = left && (!right || isPunct(prev));
        close = right && (!left || isPunct(next));
      }
      if (open || close) delims.push({ ch: c, pos: i, n, origN: n, open, close, dead: false });
      i = j;
      continue;
    }
    i++;
  }
  processEmphasis(delims, attrs);
}

/** CommonMark's "process emphasis": match closers with the nearest compatible opener. */
function processEmphasis(delims, attrs) {
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.close || closer.dead) continue;
    while (closer.n > 0) {
      let opener = null;
      let oi = ci - 1;
      for (; oi >= 0; oi--) {
        const o = delims[oi];
        if (o.dead || o.ch !== closer.ch || !o.open || o.n === 0) continue;
        // "Rule of 3": a delimiter that can both open and close only matches when the run lengths allow it.
        if ((o.close || closer.open) && (o.origN + closer.origN) % 3 === 0 && !(o.origN % 3 === 0 && closer.origN % 3 === 0)) continue;
        opener = o;
        break;
      }
      if (!opener) break;
      const use = closer.ch === '~' ? 2 : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
      const oFrom = opener.pos + opener.n - use;
      const cFrom = closer.pos;
      hideRange(attrs, oFrom, oFrom + use);
      hideRange(attrs, cFrom, cFrom + use);
      flagRange(attrs, oFrom + use, cFrom, closer.ch === '~' ? FLAG.STRIKE : use === 2 ? FLAG.BOLD : FLAG.ITALIC);
      opener.n -= use;
      closer.pos += use;
      closer.n -= use;
      for (let k = oi + 1; k < ci; k++) delims[k].dead = true; // what lies between can no longer pair up
    }
  }
}
