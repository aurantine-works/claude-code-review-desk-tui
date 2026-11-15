// Virtualised document layout and scroll math.
//
// `DocLayout` wraps source lines on demand (one `buildLayout` call per line, cached per width), so only
// the lines near the viewport are ever laid out; a 2000-line document costs the same as a 50-line one.
//
// A scroll position is `{line, sub}`: the first visible source line and how many of its wrapped screen
// rows are scrolled off. All movement is expressed in screen rows via `advance`, which only touches the
// lines it passes over.
import { buildLayout } from '../mouse/layout.js';

/** @typedef {{line: number, sub: number}} Pos */

export const cmpPos = (a, b) => a.line - b.line || a.sub - b.sub;

const CACHE_LIMIT = 3000;

export class DocLayout {
  /** @param {string[]} lines display lines (no terminators) */
  constructor(lines) {
    this.lines = lines;
    this.width = 0;
    this.gutterWidth = 0;
    this.tabWidth = 4;
    /** @type {Map<number, number[]> | null} line -> display offsets where a new screen row must start (rendered tables) */
    this.breaks = null;
    /** @type {Map<number, import('../mouse/layout.js').ScreenRow[]>} */
    this.cache = new Map();
    /** Number of buildLayout calls made (tests / profiling). */
    this.layoutCalls = 0;
  }

  get count() {
    return this.lines.length;
  }

  /**
   * Switch to other display lines (the source or the rendered view of the same document); drops the cache.
   * `breaks` (the view's, if it has any) forces a new screen row at those display offsets of a line.
   */
  setLines(lines, breaks = null) {
    if (lines !== this.lines || breaks !== this.breaks) {
      this.lines = lines;
      this.breaks = breaks;
      this.cache.clear();
    }
    return this;
  }

  get textWidth() {
    return Math.max(1, this.width - this.gutterWidth);
  }

  /** Set the pane geometry; the per-line cache is dropped only when it actually changes. */
  configure({ width, gutterWidth, tabWidth = 4 }) {
    if (width !== this.width || gutterWidth !== this.gutterWidth || tabWidth !== this.tabWidth) {
      this.width = width;
      this.gutterWidth = gutterWidth;
      this.tabWidth = tabWidth;
      this.cache.clear();
    }
    return this;
  }

  /** Wrapped screen rows of one source line. */
  rows(i) {
    let rs = this.cache.get(i);
    if (!rs) {
      if (this.cache.size > CACHE_LIMIT) this.cache.clear();
      rs = Array.from(
        buildLayout([this.lines[i] ?? ''], { width: this.width, gutterWidth: this.gutterWidth, tabWidth: this.tabWidth, firstLine: i, breaks: this.breaks }),
      );
      this.layoutCalls++;
      this.cache.set(i, rs);
    }
    return rs;
  }

  rowCount(i) {
    return this.rows(i).length;
  }

  /** Clamp a position into the document. */
  clampPos(p) {
    if (this.count === 0) return { line: 0, sub: 0 };
    const line = Math.max(0, Math.min(this.count - 1, p.line));
    return { line, sub: Math.max(0, Math.min(this.rowCount(line) - 1, p.sub)) };
  }

  /** Move a position by `n` screen rows (negative = up), stopping at the document edges. */
  advance(p, n) {
    if (this.count === 0) return { line: 0, sub: 0 };
    let { line, sub } = this.clampPos(p);
    const last = this.count - 1;
    let left = Math.abs(n);
    if (n >= 0) {
      while (left > 0) {
        const avail = this.rowCount(line) - sub; // rows from the current one to the end of the line
        if (left < avail) {
          sub += left;
          break;
        }
        left -= avail;
        if (line === last) {
          sub = this.rowCount(line) - 1;
          break;
        }
        line++;
        sub = 0;
      }
    } else {
      while (left > 0) {
        if (sub >= left) {
          sub -= left;
          break;
        }
        left -= sub + 1; // step onto the last row of the previous line
        if (line === 0) {
          sub = 0;
          break;
        }
        line--;
        sub = this.rowCount(line) - 1;
      }
    }
    return { line, sub };
  }

  /** The lowest scroll position: the last document row sits on the last viewport row. */
  maxTop(height) {
    if (this.count === 0) return { line: 0, sub: 0 };
    const last = this.count - 1;
    return this.advance({ line: last, sub: this.rowCount(last) - 1 }, -(Math.max(1, height) - 1));
  }

  /** Scroll by `n` rows, clamped to [start, maxTop]. */
  scrollBy(top, n, height) {
    const t = this.advance(top, n);
    const max = this.maxTop(height);
    return cmpPos(t, max) > 0 ? max : t;
  }

  clampTop(top, height) {
    const t = this.clampPos(top);
    const max = this.maxTop(height);
    return cmpPos(t, max) > 0 ? max : t;
  }

  /**
   * Smallest scroll that shows source line `line` completely (a line taller than the viewport shows its
   * start), keeping `margin` rows of context above and below where the document has them.
   */
  ensureVisible(top, line, height, margin = 2) {
    if (this.count === 0) return { line: 0, sub: 0 };
    const h = Math.max(1, height);
    const m = Math.min(margin, Math.floor((h - 1) / 2));
    const l = Math.max(0, Math.min(this.count - 1, line));
    const t0 = this.clampTop(top, h);
    const first = { line: l, sub: 0 };
    const wantTop = this.advance(first, -m);
    if (cmpPos(t0, wantTop) > 0) return wantTop;
    const bottomRow = this.advance({ line: l, sub: this.rowCount(l) - 1 }, m);
    let t = this.advance(bottomRow, -(h - 1));
    if (cmpPos(t, first) > 0) t = first;
    return cmpPos(t0, t) < 0 ? t : t0;
  }

  /**
   * The rows to draw for a viewport.
   * @returns {{rows: import('../mouse/layout.js').ScreenRow[], rowOf: (line: number) => number, firstLine: number, lastLine: number}}
   *   `rowOf(line)` is the viewport row index of the line's first row (-1 when not visible).
   */
  window(top, height) {
    const rows = [];
    let line = top.line;
    let skip = top.sub;
    const firstRow = new Map();
    while (rows.length < height && line < this.count) {
      const rs = this.rows(line);
      for (let k = skip; k < rs.length && rows.length < height; k++) {
        if (rs[k].first) firstRow.set(line, rows.length);
        rows.push(rs[k]);
      }
      skip = 0;
      line++;
    }
    return {
      rows,
      rowOf: (l) => firstRow.get(l) ?? -1,
      firstLine: top.line,
      lastLine: rows.length ? rows[rows.length - 1].line : top.line,
    };
  }

  /**
   * Range of cursor lines that stay inside the viewport (with `margin` rows of slack, except at the
   * document edges). Used to drag the cursor along when the view is scrolled with the wheel.
   */
  cursorBounds(top, height, margin = 2) {
    const m = Math.min(margin, Math.floor((height - 1) / 2));
    const win = this.window(top, height);
    const atTop = top.line === 0 && top.sub === 0;
    const lastRow = this.count - 1;
    const reachesEnd = win.lastLine === lastRow && win.rows.length < height + 1 && win.rowOf(lastRow) + this.rowCount(lastRow) <= height;
    let lo = -1;
    let hi = -1;
    let anyFull = -1;
    for (let l = top.line; l <= win.lastLine; l++) {
      const r = win.rowOf(l);
      if (r === -1) continue; // first row scrolled off above
      const end = r + this.rowCount(l) - 1;
      if (end > height - 1) continue; // clipped at the bottom
      if (anyFull === -1) anyFull = l;
      if ((atTop || r >= m) && (reachesEnd || end <= height - 1 - m)) {
        if (lo === -1) lo = l;
        hi = l;
      }
    }
    if (lo === -1) lo = hi = anyFull === -1 ? Math.min(this.count - 1, top.line + (top.sub > 0 ? 1 : 0)) : anyFull;
    return { lo, hi };
  }
}

/** Build the hitTest-compatible layout array of the rows on screen. */
export function viewLayout(win, doc) {
  const rows = win.rows.slice();
  Object.defineProperty(rows, 'meta', {
    value: { width: doc.width, gutterWidth: doc.gutterWidth, textWidth: doc.textWidth, tabWidth: doc.tabWidth },
    enumerable: false,
  });
  return rows;
}
