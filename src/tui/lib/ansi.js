// Styled text segments and their conversion to ANSI strings.
//
// The TUI builds every screen row as an array of segments ({text, style}) so layout, hit testing and
// tests work on plain data; only the last step turns a row into one chalk-styled string for Ink's <Text>.
import chalk from 'chalk';
import stringWidth from 'string-width';

/**
 * @typedef {object} Style
 * @property {string} [fg]      hex colour
 * @property {string} [bg]      hex colour
 * @property {boolean} [bold]
 * @property {boolean} [dim]
 * @property {boolean} [italic]
 * @property {boolean} [underline]
 * @property {boolean} [inverse]
 * @property {boolean} [strike]   strikethrough
 * @typedef {{text: string, style?: Style | null}} Segment
 */

export function styleKey(s) {
  if (!s) return '';
  return `${s.fg ?? ''}|${s.bg ?? ''}|${s.bold ? 'b' : ''}${s.dim ? 'd' : ''}${s.italic ? 'i' : ''}${s.underline ? 'u' : ''}${s.inverse ? 'r' : ''}${s.strike ? 's' : ''}`;
}

const painters = new Map();
function painterFor(style) {
  const key = styleKey(style);
  let fn = painters.get(key);
  if (fn) return fn;
  let c = chalk;
  if (style.fg) c = c.hex(style.fg);
  if (style.bg) c = c.bgHex(style.bg);
  if (style.bold) c = c.bold;
  if (style.dim) c = c.dim;
  if (style.italic) c = c.italic;
  if (style.underline) c = c.underline;
  if (style.inverse) c = c.inverse;
  if (style.strike) c = c.strikethrough;
  fn = c;
  painters.set(key, fn);
  return fn;
}

/** Style a string. An empty / null style returns the text unchanged. */
export function paint(text, style) {
  if (!style || text === '') return text;
  const key = styleKey(style);
  if (key === '||') return text;
  return painterFor(style)(text);
}

export const segsToAnsi = (segs) => segs.map((s) => paint(s.text, s.style)).join('');
export const segsText = (segs) => segs.map((s) => s.text).join('');
export const segsWidth = (segs) => segs.reduce((n, s) => n + stringWidth(s.text), 0);

/** Append a segment, merging with the previous one when the style is identical. */
export function pushSeg(segs, text, style) {
  if (text === '') return;
  const last = segs[segs.length - 1];
  if (last && styleKey(last.style) === styleKey(style)) last.text += text;
  else segs.push({ text, style: style ?? null });
}

/** Pad with spaces (or cut) so the visible width is exactly `width`. */
export function fitSegs(segs, width, padStyle = null) {
  const out = [];
  let used = 0;
  for (const seg of segs) {
    if (used >= width) break;
    const w = stringWidth(seg.text);
    if (used + w <= width) {
      out.push(seg);
      used += w;
      continue;
    }
    // Cut inside the segment, grapheme by grapheme.
    let text = '';
    for (const ch of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(seg.text)) {
      const cw = stringWidth(ch.segment);
      if (used + cw > width) break;
      text += ch.segment;
      used += cw;
    }
    if (text) out.push({ text, style: seg.style });
    break;
  }
  if (used < width) out.push({ text: ' '.repeat(width - used), style: padStyle });
  return out;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Cut `text` to at most `width` columns, ending in an ellipsis when something was cut. */
export function ellipsize(text, width) {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  let out = '';
  for (const ch of segmenter.segment(text)) {
    if (stringWidth(out + ch.segment) > width - 1) break;
    out += ch.segment;
  }
  return `${out}…`;
}

/** Like ellipsize() but keeps the END of the text (a file path: the name matters more than the first directories). */
export function ellipsizeStart(text, width) {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  const parts = [...segmenter.segment(text)].map((x) => x.segment);
  let out = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    if (stringWidth(parts[i] + out) > width - 1) break;
    out = parts[i] + out;
  }
  return `…${out}`;
}

/** The first of `variants` (longest first) that is at most `width` columns wide; the last one, cut, when none is. */
export function fitVariant(width, variants) {
  return variants.find((v) => stringWidth(v) <= width) ?? ellipsize(variants[variants.length - 1], width);
}
