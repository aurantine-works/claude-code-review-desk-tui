// Half-rendered Markdown: turns source lines into display lines, one for one.
//
// Every display line comes from exactly one source line (so the line numbers stay the source's), and every display
// character is either
//   - a copy of one source character (hidden markers such as `**` or `#` are simply not copied),
//   - a 1:1 glyph replacement of one source character (`-` -> `•`, `>` -> `▎`, `|` -> `│`), or
//   - synthetic: it has no source character (table padding, the tail of a drawn rule).
// The mapping is kept per display UTF-16 unit (`src[i]`, -1 = synthetic, `src[len]` = length of the source line), which
// is all the UI needs to move between the two coordinate systems. The source stays the only truth: anchors, quotes and
// everything sent to Claude use source offsets, see docView.js for the boundary helpers.
//
// A table wider than the pane keeps this contract too: its cells are cut into pieces that fill k "segments" of exactly
// `maxWidth` columns each, which the pane's soft wrap shows as k screen rows of the SAME display line (see renderTable). The
// mapping is then no longer monotonic within such a line (segment 2 shows the second pieces of all cells), so consumers must
// not assume the source offset grows with the display offset.
//
// Pure module: no React / Ink.
import stringWidth from 'string-width';
import { splitGraphemes, graphemeWidth } from '../input/text.js';
import { COLOR } from './theme.js';
import { HEADING_FG } from './markdown.js';
import { FLAG, newAttrs, parseInline } from './mdInline.js';

/** @typedef {import('./ansi.js').Style} Style */
/** @typedef {{from: number, to: number, style: Style | null}} Run */

// ---- styles ---------------------------------------------------------------------------------------------------------

const HEADING = [
  null,
  { bold: true, underline: true, fg: HEADING_FG[1] },
  { bold: true, fg: HEADING_FG[2] },
  { bold: true, fg: HEADING_FG[3] },
  { italic: true, fg: HEADING_FG[4] },
  { italic: true, fg: HEADING_FG[5] },
  { italic: true, fg: HEADING_FG[6] },
];
const QUOTE = { fg: '#8fa58f' };
const BULLET = { fg: COLOR.warn };
const CODE_ROW = { bg: COLOR.bgCode };
const FENCE_LANG = { dim: true, bg: COLOR.bgCode };
const BORDER = { dim: true };
const HR_STYLE = { dim: true };
const TASK_OPEN = { fg: COLOR.accent };
const TASK_DONE = { dim: true };
const TABLE_HEAD = { bold: true };
const SETEXT_RULE = [null, { fg: HEADING_FG[1] }, { fg: HEADING_FG[2] }];
const BULLETS = ['•', '◦', '▪'];
const DIM_BASE = { dim: true };
const DIM_QUOTE = { ...QUOTE, dim: true };

const ASCII_ONLY = /^[\x20-\x7e]*$/;
const NO_BASE = {};
const composed = new WeakMap(); // base style -> Map(flags -> composed style)
/** The style of a character with base style `base` and inline flags. Memoised, so equal styles are identical objects. */
function styleFor(base, flags) {
  if (!flags) return base;
  const key = base ?? NO_BASE;
  let m = composed.get(key);
  if (!m) composed.set(key, (m = new Map()));
  let s = m.get(flags);
  if (!s) {
    s = { ...(base ?? {}) };
    if (flags & FLAG.BOLD) s.bold = true;
    if (flags & FLAG.ITALIC) s.italic = true;
    if (flags & FLAG.STRIKE) s.strike = true;
    if (flags & FLAG.CODE) {
      s.fg = COLOR.accent;
      s.bg = COLOR.bgCode;
    }
    if (flags & FLAG.LINK) {
      s.fg = COLOR.accent;
      s.underline = true;
    }
    if (flags & FLAG.IMAGE) s.dim = true;
    m.set(flags, s);
  }
  return s;
}

// ---- display line builder -------------------------------------------------------------------------------------------

class Buf {
  constructor() {
    this.text = '';
    /** @type {number[]} */
    /** @type {number[]} source offset per display unit, -1 = synthetic */
    this.src = [];
    /** @type {Run[]} */
    this.runs = [];
    /** @type {number[] | null} display offsets where a new wrapped screen row must start (table segments) */
    this.breaks = null;
  }

  _extend(from, style) {
    const last = this.runs[this.runs.length - 1];
    if (last && last.style === style && last.to === from) last.to = from + 1;
    else this.runs.push({ from, to: from + 1, style });
  }

  /** One display unit that shows (or replaces) the source unit `off`. */
  unit(ch, off, style) {
    this._extend(this.text.length, style ?? null);
    this.text += ch;
    this.src.push(off);
  }

  /** Display text without a source character. */
  synth(str, style) {
    for (let i = 0; i < str.length; i++) {
      this._extend(this.text.length, style ?? null);
      this.text += str[i];
      this.src.push(-1);
    }
  }

  /** Copy source[from, to) verbatim. */
  copy(source, from, to, style) {
    for (let i = from; i < to; i++) this.unit(source[i], i, style);
  }

  append(other) {
    const base = this.text.length;
    this.text += other.text;
    for (const s of other.src) this.src.push(s);
    for (const r of other.runs) {
      const last = this.runs[this.runs.length - 1];
      if (last && last.style === r.style && last.to === base + r.from) last.to = base + r.to;
      else this.runs.push({ from: base + r.from, to: base + r.to, style: r.style });
    }
  }

  /** A copy of the display units [from, to): text, source map and styles. */
  slice(from, to) {
    const b = new Buf();
    b.text = this.text.slice(from, to);
    b.src = this.src.slice(from, to);
    for (const r of this.runs) {
      if (r.to <= from || r.from >= to) continue;
      b.runs.push({ from: Math.max(r.from, from) - from, to: Math.min(r.to, to) - from, style: r.style });
    }
    return b;
  }

  /** The next display unit starts a new screen row (the previous segment of a wrapped table row ends here). */
  markBreak() {
    (this.breaks ??= []).push(this.text.length);
  }

  get width() {
    return ASCII_ONLY.test(this.text) ? this.text.length : stringWidth(this.text);
  }

  finish(srcLen) {
    this.src.push(srcLen); // src[display length] = length of the source line
    return { text: this.text, src: this.src, runs: this.runs, breaks: this.breaks, prev: null, next: null };
  }
}

/** Emit the unhidden units of text[from, to) with their inline styles. */
function emitRegion(buf, text, from, to, attrs, base) {
  for (let i = from; i < to; i++) {
    if (attrs.hide[i]) continue;
    const style = styleFor(base, attrs.flags[i]);
    const rep = attrs.rep.get(i);
    buf.unit(rep ?? text[i], i, style);
  }
}

// ---- block scan -----------------------------------------------------------------------------------------------------

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const SETEXT_RE = /^ {0,3}(=+|-{2,})[ \t]*$/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?=[ \t])/;
const QUOTE_RE = /^ {0,3}>/;
const DELIM_ROW_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const NOT_TABLE_HEAD_RE = /^[ \t]*(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|#{1,6}(?:[ \t]|$))/;
const BLANK_RE = /^[ \t]*$/;
const QUOTE_STICKY = / {0,3}>/y;
const TASK_STICKY = /\[( |x|X)\](?=[ \t]|$)/y;

const isParagraphLike = (line) =>
  !BLANK_RE.test(line) && !HR_RE.test(line) && !ATX_RE.test(line) && !LIST_RE.test(line) && !QUOTE_RE.test(line) && !FENCE_OPEN.test(line);

/** Split a table row at its unescaped pipes. `items` are in source order: {t:'ws'|'pipe'|'cell', from, to}. */
function parseRow(line) {
  const pipes = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '|') pipes.push(i);
  }
  const firstNon = line.search(/[^ \t]/);
  const lastNon = line.search(/[ \t]*$/) - 1;
  const lead = pipes.length > 0 && pipes[0] === firstNon;
  const trail = pipes.length > (lead ? 1 : 0) && pipes[pipes.length - 1] === lastNon;
  const items = [];
  const cells = [];
  let begin = 0;
  const addCell = (from, to) => {
    const c = { t: 'cell', from, to, index: cells.length };
    cells.push(c);
    items.push(c);
  };
  pipes.forEach((p, k) => {
    if (k === 0 && lead) {
      if (p > 0) items.push({ t: 'ws', from: 0, to: p });
    } else addCell(begin, p);
    items.push({ t: 'pipe', from: p, to: p + 1, index: k });
    begin = p + 1;
  });
  if (!trail) addCell(begin, line.length);
  else if (begin < line.length) items.push({ t: 'ws', from: begin, to: line.length });
  return { items, cells, pipeCount: pipes.length, lead, trail };
}

/**
 * Block structure of the document.
 * @returns {Array<{kind: 'blank'|'text'|'hr'|'code'|'setextText'|'setextLine'|'table', role?: string, level?: number, lang?: string, start?: number, end?: number}>}
 */
function scanBlocks(lines) {
  const n = lines.length;
  const out = new Array(n);
  let i = 0;
  // Front matter: `---` on the very first line up to the next `---` / `...` is shown like a code block.
  if (n > 1 && /^---[ \t]*$/.test(lines[0])) {
    for (let j = 1; j < n; j++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[j])) {
        out[0] = { kind: 'code', role: 'open', lang: '' };
        for (let k = 1; k < j; k++) out[k] = { kind: 'code', role: 'body' };
        out[j] = { kind: 'code', role: 'close' };
        i = j + 1;
        break;
      }
    }
  }
  while (i < n) {
    const line = lines[i];
    const f = FENCE_OPEN.exec(line);
    if (f && !(f[2][0] === '`' && f[3].includes('`'))) {
      const marker = f[2];
      out[i] = { kind: 'code', role: 'open', lang: f[3].trim().split(/\s+/)[0] ?? '' };
      let j = i + 1;
      for (; j < n; j++) {
        const c = FENCE_OPEN.exec(lines[j]);
        if (c && c[2][0] === marker[0] && c[2].length >= marker.length && c[3].trim() === '') {
          out[j] = { kind: 'code', role: 'close' };
          break;
        }
        out[j] = { kind: 'code', role: 'body' };
      }
      i = j + 1;
      continue;
    }
    if (BLANK_RE.test(line)) {
      out[i] = { kind: 'blank' };
      i++;
      continue;
    }
    // Table: a header row with a pipe, then a delimiter row with the same number of cells, then rows with pipes.
    if (i + 1 < n && line.includes('|') && lines[i + 1].includes('|') && DELIM_ROW_RE.test(lines[i + 1]) && !NOT_TABLE_HEAD_RE.test(line)) {
      if (parseRow(line).cells.length === parseRow(lines[i + 1]).cells.length) {
        let end = i + 2;
        while (end < n && !BLANK_RE.test(lines[end]) && lines[end].includes('|') && !FENCE_OPEN.test(lines[end])) end++;
        const t = { kind: 'table', start: i, end };
        for (let k = i; k < end; k++) out[k] = t;
        i = end;
        continue;
      }
    }
    // Setext heading: a paragraph line directly above a `===` / `---` line.
    if (i + 1 < n && isParagraphLike(line) && SETEXT_RE.test(lines[i + 1])) {
      const level = lines[i + 1].trim()[0] === '=' ? 1 : 2;
      out[i] = { kind: 'setextText', level };
      out[i + 1] = { kind: 'setextLine', level };
      i += 2;
      continue;
    }
    out[i] = HR_RE.test(line) ? { kind: 'hr' } : { kind: 'text' };
    i++;
  }
  return out;
}

// ---- line renderers -------------------------------------------------------------------------------------------------

const indentWidth = (s) => {
  let w = 0;
  for (const ch of s) w += ch === '\t' ? 4 - (w % 4) : 1;
  return w;
};

function listDepth(stack, indent) {
  while (stack.length && stack[stack.length - 1] > indent) stack.pop();
  if (!stack.length || stack[stack.length - 1] < indent) stack.push(indent);
  return stack.length - 1;
}

/** Paragraph / heading / list item / quote line. */
function renderTextLine(text, listStack) {
  const buf = new Buf();
  const len = text.length;
  const attrs = newAttrs(len);

  // Quote markers: every `>` becomes `▎`.
  let pos = 0;
  const quoteAt = new Set();
  for (;;) {
    QUOTE_STICKY.lastIndex = pos;
    const m = QUOTE_STICKY.exec(text);
    if (!m) break;
    quoteAt.add(pos + m[0].length - 1);
    pos += m[0].length;
  }
  const quoted = quoteAt.size > 0;
  let base = quoted ? QUOTE : null;
  const lead = (upTo) => {
    for (let k = 0; k < upTo; k++) buf.unit(quoteAt.has(k) ? '▎' : text[k], k, QUOTE);
  };

  const atx = ATX_RE.exec(text.slice(pos));
  if (atx) {
    const level = atx[1].length;
    let from = pos + atx[0].length;
    while (from < len && (text[from] === ' ' || text[from] === '\t')) from++;
    let to = len;
    const close = /[ \t]+#+[ \t]*$|^#+[ \t]*$/.exec(text.slice(from));
    if (close) to = from + close.index;
    else to = len - (text.length - text.trimEnd().length);
    lead(pos);
    base = HEADING[level];
    parseInline(text, from, to, attrs);
    emitRegion(buf, text, from, to, attrs, base);
    if (!quoted) listStack.length = 0;
    return buf;
  }

  const li = LIST_RE.exec(text.slice(pos));
  if (li) {
    const markerAt = pos + li[1].length;
    const markerEnd = markerAt + li[2].length;
    const ordered = /\d/.test(li[2]);
    // The depth comes from the indentation of the line (a quote prefix restarts the count).
    const depth = quoted ? 0 : listDepth(listStack, indentWidth(li[1]));
    lead(pos);
    buf.copy(text, pos, markerAt, base);
    if (ordered) buf.copy(text, markerAt, markerEnd, BULLET);
    else buf.unit(BULLETS[Math.min(depth, BULLETS.length - 1)], markerAt, BULLET);
    let from = markerEnd;
    // Whitespace after the marker, then an optional task box.
    let ws = from;
    while (ws < len && (text[ws] === ' ' || text[ws] === '\t')) ws++;
    buf.copy(text, from, ws, base);
    from = ws;
    TASK_STICKY.lastIndex = from;
    const t = TASK_STICKY.exec(text);
    if (t) {
      const done = t[1] !== ' ';
      buf.copy(text, from, from + 3, done ? TASK_DONE : TASK_OPEN);
      from += 3;
      if (done) base = quoted ? DIM_QUOTE : DIM_BASE; // a finished task fades out
    }
    parseInline(text, from, len, attrs);
    emitRegion(buf, text, from, len, attrs, base);
    return buf;
  }

  lead(pos);
  parseInline(text, pos, len, attrs);
  emitRegion(buf, text, pos, len, attrs, base);
  if (!quoted && text.length > 0 && text[0] !== ' ' && text[0] !== '\t') listStack.length = 0;
  return buf;
}

function renderSetextText(text, level) {
  const buf = new Buf();
  const len = text.length;
  const attrs = newAttrs(len);
  const from = text.length - text.trimStart().length;
  const to = text.trimEnd().length;
  parseInline(text, from, to, attrs);
  emitRegion(buf, text, from, to, attrs, HEADING[level]);
  return buf;
}

function renderRule(text, width, ch, style, minWidth = 0) {
  const buf = new Buf();
  const n = Math.max(1, Math.min(width, Math.max(minWidth, text.length)));
  for (let k = 0; k < n; k++) {
    if (k < text.length) buf.unit(ch, k, style);
    else buf.synth(ch, style);
  }
  return buf;
}

function renderCodeLine(text, b) {
  const buf = new Buf();
  if (b.role === 'body') buf.copy(text, 0, text.length, CODE_ROW);
  else if (b.role === 'open' && b.lang) {
    const at = text.indexOf(b.lang, text.search(/[`~]/));
    buf.copy(text, at, at + b.lang.length, FENCE_LANG);
  }
  return buf;
}

const MIN_COL = 3; // narrowest content width a wrapped table column may get
const EMPTY_FRAG = { buf: new Buf(), w: 0, trail: 0 };

/**
 * Content widths for a table that is wider than the pane: water-filling. Every column gets at most its natural width,
 * the rest is shared out equally among the columns that still want more. null when even the minimums do not fit.
 * @param {number[]} natural  widest cell per column
 * @param {number} avail  columns left for the content (borders and padding already taken off)
 */
function allocateWidths(natural, avail) {
  const w = natural.map((x) => Math.min(x, MIN_COL));
  let left = avail - w.reduce((a, b) => a + b, 0);
  if (left < 0) return null;
  for (;;) {
    const open = w.map((x, k) => k).filter((k) => w[k] < natural[k]);
    if (left <= 0 || open.length === 0) break;
    const share = Math.floor(left / open.length);
    if (share === 0) {
      // Fewer columns left than columns wanting some: the ones that miss most get the odd columns.
      open.sort((a, b) => natural[b] - w[b] - (natural[a] - w[a]) || a - b);
      for (let i = 0; i < left; i++) w[open[i]]++;
      break;
    }
    for (const k of open) {
      const add = Math.min(share, natural[k] - w[k]);
      w[k] += add;
      left -= add;
    }
  }
  return w;
}

/**
 * Cut one cell's rendered content into pieces of at most `cw` columns (grapheme boundaries, a wide character that does not
 * fit starts the next piece). Pieces end after a space when there is one, otherwise the word is cut. A single space that
 * would not fit stays at the end of its piece and hangs into the cell's right padding. Every character lands in exactly
 * one piece, with its source offset.
 * @returns {{buf: Buf, w: number, trail: number}[]}  at least one piece: w = columns it occupies, trail = those of its closing spaces
 */
function wrapCell(buf, cw) {
  const gs = splitGraphemes(buf.text);
  if (gs.length === 0) return [EMPTY_FRAG];
  const frags = [];
  const widthOf = (a, b) => {
    let w = 0;
    for (let k = a; k < b; k++) w += graphemeWidth(gs[k].text);
    return w;
  };
  let i = 0;
  while (i < gs.length) {
    let j = i;
    let w = 0;
    let brk = -1; // just after the last space of this piece
    for (; j < gs.length; j++) {
      const t = gs[j].text;
      const gw = graphemeWidth(t);
      if (w + gw > cw && j > i) {
        if (t === ' ') j++; // hangs into the padding
        else if (brk > i) j = brk;
        break;
      }
      w += gw;
      if (t === ' ') brk = j + 1;
    }
    let trail = 0;
    for (let k = j - 1; k >= i && gs[k].text === ' '; k--) trail++;
    frags.push({ buf: buf.slice(gs[i].start, gs[j - 1].end), w: widthOf(i, j), trail });
    i = j;
  }
  return frags;
}

/**
 * A cell piece with its padding: ` <left><piece><right> `, so that the cell occupies exactly cw + 2 columns. Spaces at the
 * end of a piece (it was cut after a word) are not part of the aligned text; they sit in the space on its right.
 */
function emitCell(buf, frag, cw, align) {
  const room = cw + 1 - frag.w; // columns left in the cell, the padding on the right included
  const pad = Math.max(0, cw - (frag.w - frag.trail));
  const left = Math.min(room, align === 'right' ? pad : align === 'center' ? pad >> 1 : 0);
  buf.synth(' '.repeat(1 + left));
  buf.append(frag.buf);
  buf.synth(' '.repeat(room - left));
}

/** The table's cells are not wide enough for the content: one source row becomes k segments of exactly `maxWidth` columns. */
function renderWrappedRow(row, cells, colW, aligns, maxWidth) {
  const frags = cells.map((c, k) => wrapCell(c.buf, colW[k]));
  const nseg = Math.max(1, ...frags.map((f) => f.length));
  const segW = row.pipeCount + cells.reduce((a, c, k) => a + colW[k] + 2, 0);
  const buf = new Buf();
  for (let j = 0; j < nseg; j++) {
    if (j > 0) buf.markBreak();
    for (const it of row.items) {
      if (it.t === 'pipe') {
        if (j === 0) buf.unit('│', it.from, BORDER);
        else buf.synth('│', BORDER);
      } else if (it.t === 'cell') {
        emitCell(buf, frags[it.index][j] ?? EMPTY_FRAG, colW[it.index], aligns[it.index] ?? 'left');
      } // leading / trailing whitespace outside the pipes is not shown
    }
    if (j < nseg - 1 && segW < maxWidth) buf.synth(' '.repeat(maxWidth - segW)); // every segment but the last fills a pane row
  }
  return buf;
}

/** Whole table. Writes the Buf of every row into `out[start..end)`. */
function renderTable(lines, start, end, maxWidth, out) {
  const rows = [];
  for (let k = start; k < end; k++) rows.push(parseRow(lines[k]));
  const delim = rows[1];
  const aligns = delim.cells.map((c) => {
    const s = lines[start + 1].slice(c.from, c.to).trim();
    return s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : 'left';
  });

  // Inline-render the content of every cell of the header and body rows.
  const cellData = rows.map((row, r) => {
    if (r === 1) return null;
    const text = lines[start + r];
    const attrs = newAttrs(text.length);
    return row.cells.map((c) => {
      let cs = c.from;
      let ce = c.to;
      while (cs < ce && (text[cs] === ' ' || text[cs] === '\t')) cs++;
      while (ce > cs && (text[ce - 1] === ' ' || text[ce - 1] === '\t')) ce--;
      parseInline(text, cs, ce, attrs);
      // A table cell splits at unescaped pipes only, so `\|` is a pipe even inside a code span.
      for (let k = cs; k < ce - 1; k++) {
        if (text[k] !== '\\') continue;
        if (text[k + 1] === '|') attrs.hide[k] = 1;
        k++;
      }
      const buf = new Buf();
      emitRegion(buf, text, cs, ce, attrs, r === 0 ? TABLE_HEAD : null);
      buf.text = buf.text.replace(/\t/g, ' '); // a tab has no width of its own (the pane expands it to a tab stop)
      return { cs, ce, buf, width: buf.width };
    });
  });
  const ncols = Math.max(...rows.map((r) => r.cells.length));
  const widths = Array.from({ length: ncols }, () => 1);
  cellData.forEach((cells) => cells?.forEach((c, k) => (widths[k] = Math.max(widths[k], c.width))));
  const total = widths.reduce((a, w) => a + w + 2, 0) + rows[0].pipeCount;
  const padded = total <= maxWidth;
  // Wider than the pane: share the width out and wrap the cells inside their columns. Only when even
  // the narrowest columns do not fit are the cells left alone (just the pipes are replaced).
  let colW = widths;
  if (!padded) {
    const pipes = Math.max(...rows.map((r) => r.pipeCount));
    colW = allocateWidths(widths, maxWidth - pipes - 2 * ncols);
  }
  const wrapped = !padded && colW !== null;

  rows.forEach((row, r) => {
    const text = lines[start + r];
    if (wrapped && r !== 1) {
      out[start + r] = renderWrappedRow(row, cellData[r], colW, aligns, maxWidth).finish(text.length);
      return;
    }
    const buf = new Buf();
    const isDelim = r === 1;
    const lastPipe = row.pipeCount - 1;
    for (const it of row.items) {
      if (it.t === 'ws') {
        if (!wrapped) buf.copy(text, it.from, it.to, null);
      } else if (it.t === 'pipe') {
        let g = '│';
        if (isDelim) g = it.index === 0 && row.lead ? '├' : it.index === lastPipe && row.trail ? '┤' : '┼';
        buf.unit(g, it.from, BORDER);
      } else if (isDelim) {
        const marks = [];
        for (let k = it.from; k < it.to; k++) if (text[k] !== ' ' && text[k] !== '\t') marks.push(k);
        if (colW) {
          const count = colW[it.index] + 2;
          for (let k = 0; k < count; k++) {
            if (k < marks.length) buf.unit('─', marks[k], BORDER);
            else buf.synth('─', BORDER);
          }
        } else {
          for (let k = it.from; k < it.to; k++) {
            if (text[k] === ' ' || text[k] === '\t') buf.unit(text[k], k, null);
            else buf.unit('─', k, BORDER);
          }
        }
      } else {
        const c = cellData[r][it.index];
        if (padded) {
          emitCell(buf, { buf: c.buf, w: c.width, trail: 0 }, widths[it.index], aligns[it.index] ?? 'left');
        } else {
          buf.copy(text, it.from, c.cs, null);
          buf.append(c.buf);
          buf.copy(text, c.ce, it.to, null);
        }
      }
    }
    out[start + r] = buf.finish(text.length);
  });
}

// ---- document -------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} RenderedDoc
 * @property {string[]} lines                   display text per source line
 * @property {Run[][]} runs                     style runs per display line (they cover every character)
 * @property {Map<number, number[]> | null} breaks  line -> display offsets where a new screen row must start (wrapped table rows)
 * @property {(Style | null)[]} rowStyle        style that fills the rest of the row (code block background)
 * @property {(line: number) => number} srcLen  length of the source line
 * @property {(line: number, dOff: number) => number} toSrc    display offset -> source offset (synthetic: nearest real char)
 * @property {(line: number, sOff: number) => number} toDisp   source offset -> display offset (hidden: next visible char; the one with the smallest source offset >= sOff)
 * @property {(line: number, dOff: number) => boolean} synthetic
 * @property {(line: number, dOff: number, from: number, to: number) => boolean} covered  is the display char inside the source interval
 * @property {(line: number, dOff: number) => Style | null} styleAt
 * @property {(range: {start: {line: number, off: number}, end: {line: number, off: number}}) => ({start: {line: number, off: number}, end: {line: number, off: number}} | null)} srcRange
 *           display range (end exclusive) -> source range of its real characters
 */

/**
 * @param {string[]} lines  source lines
 * @param {{maxWidth?: number}} [opts]  text columns available; decides whether a table is padded and how long rules are
 * @returns {RenderedDoc}
 */
export function renderMarkdown(lines, { maxWidth = 80 } = {}) {
  const width = Number.isFinite(maxWidth) ? Math.max(1, Math.floor(maxWidth)) : 80;
  const n = lines.length;
  const blocks = scanBlocks(lines);
  const bufs = new Array(n);
  const rowStyle = new Array(n).fill(null);
  const listStack = [];

  for (let i = 0; i < n; i++) {
    if (bufs[i]) continue; // filled by a table
    const text = lines[i];
    const b = blocks[i];
    switch (b.kind) {
      case 'code':
        bufs[i] = renderCodeLine(text, b).finish(text.length);
        rowStyle[i] = CODE_ROW;
        break;
      case 'table':
        renderTable(lines, b.start, b.end, width, bufs);
        listStack.length = 0;
        break;
      case 'hr':
        bufs[i] = renderRule(text, width, '─', HR_STYLE, width).finish(text.length);
        listStack.length = 0;
        break;
      case 'setextText': {
        const buf = renderSetextText(text, b.level);
        bufs[i] = buf.finish(text.length);
        bufs[i + 1] = renderRule(lines[i + 1], width, b.level === 1 ? '═' : '─', SETEXT_RULE[b.level], buf.width).finish(lines[i + 1].length);
        listStack.length = 0;
        break;
      }
      case 'blank': {
        const buf = new Buf();
        buf.copy(text, 0, text.length, null);
        bufs[i] = buf.finish(text.length);
        break;
      }
      default:
        bufs[i] = renderTextLine(text, listStack).finish(text.length);
    }
  }

  const out = bufs;
  const links = (b) => {
    // Nearest real display unit before / after every position, built on first use (only synthetic cells need them).
    if (b.prev) return b;
    const len = b.text.length;
    b.prev = new Int32Array(len);
    b.next = new Int32Array(len);
    let last = -1;
    for (let k = 0; k < len; k++) {
      b.prev[k] = last;
      if (b.src[k] >= 0) last = k;
    }
    last = -1;
    for (let k = len - 1; k >= 0; k--) {
      b.next[k] = last;
      if (b.src[k] >= 0) last = k;
    }
    return b;
  };

  const toSrc = (line, dOff) => {
    const b = out[line];
    const len = b.text.length;
    if (dOff >= len) return b.src[len];
    const o = Math.max(0, dOff);
    const s = b.src[o];
    if (s >= 0) return s;
    links(b);
    const p = b.prev[o];
    const q = b.next[o];
    if (p < 0 && q < 0) return 0;
    if (p < 0) return b.src[q];
    if (q < 0) return b.src[p];
    return o - p <= q - o ? b.src[p] : b.src[q];
  };

  // The mapping is not monotonic in a wrapped table row, so this is the display character with the smallest source
  // offset >= sOff (the lowest one on a tie), not simply the first one that qualifies.
  const toDisp = (line, sOff) => {
    const b = out[line];
    const len = b.text.length;
    let best = len;
    let bestSrc = Infinity;
    for (let k = 0; k < len; k++) {
      const s = b.src[k];
      if (s >= sOff && s < bestSrc) {
        best = k;
        bestSrc = s;
        if (s === sOff) break;
      }
    }
    return best;
  };

  const synthetic = (line, dOff) => {
    const b = out[line];
    return dOff >= 0 && dOff < b.text.length && b.src[dOff] < 0;
  };

  const covered = (line, dOff, from, to) => {
    const b = out[line];
    const len = b.text.length;
    if (dOff >= len) return b.src[len] >= from && b.src[len] < to;
    const s = b.src[dOff];
    if (s >= 0) return s >= from && s < to;
    links(b);
    const p = b.prev[dOff];
    const q = b.next[dOff];
    return p >= 0 && q >= 0 && b.src[p] >= from && b.src[p] < to && b.src[q] >= from && b.src[q] < to;
  };

  const styleAt = (line, dOff) => {
    const runs = out[line].runs;
    let lo = 0;
    let hi = runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = runs[mid];
      if (dOff < r.from) hi = mid - 1;
      else if (dOff >= r.to) lo = mid + 1;
      else return r.style;
    }
    return null;
  };

  // Per line the smallest and the largest source offset among the selected real characters (in a wrapped table row the
  // first / last selected character is not the lowest / highest one).
  const srcRange = (range) => {
    const { start, end } = range;
    let s = null;
    let e = null;
    for (let l = start.line; l <= end.line; l++) {
      const b = out[l];
      const lim = l === end.line ? end.off : b.text.length;
      let lo = Infinity;
      let hi = -1;
      for (let k = l === start.line ? start.off : 0; k < lim; k++) {
        const v = b.src[k];
        if (v < 0) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi < 0) continue;
      s ??= { line: l, off: lo };
      e = { line: l, off: hi + 1 };
    }
    if (!s || !e || (e.line === s.line && e.off <= s.off)) return null;
    return { start: s, end: e };
  };

  // Display offsets where a wrapped table row starts a new screen row (see renderTable): line -> offsets.
  const breaks = new Map();
  out.forEach((b, i) => {
    if (b.breaks) breaks.set(i, b.breaks);
  });

  return {
    lines: out.map((b) => b.text),
    runs: out.map((b) => b.runs),
    breaks: breaks.size ? breaks : null,
    rowStyle,
    srcLen: (line) => lines[line]?.length ?? 0,
    toSrc,
    toDisp,
    synthetic,
    covered,
    styleAt,
    srcRange,
  };
}
