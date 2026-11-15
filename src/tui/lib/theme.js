// Colours and shared glyphs. All colours are hex; chalk downgrades them for 256/16-colour terminals.

export const COLOR = {
  dim: '#7f8796',
  accent: '#56b6c2',
  blue: '#61afef',
  ok: '#98c379',
  warn: '#e5c07b',
  err: '#e06c75',
  purple: '#c678dd',
  // Backgrounds for highlighted document text.
  bgAnchor: '#26324d',
  bgFocus: '#2f5080',
  bgOverlap: '#43407a',
  bgSelect: '#6a5a20',
  bgButton: '#56b6c2',
  bgBar: '#2c313a',
  bgBadge: '#3e4451',
  // Fenced code blocks and front matter in the rendered Markdown view (a faint lift over a dark terminal background).
  bgCode: '#262a33',
  // Diff view: a tinted row for added / removed lines, a stronger tint on the words that differ inside a changed line.
  bgAdd: '#1b4d27',
  bgAddWord: '#2f8f2f',
  bgDel: '#591f26',
  bgDelWord: '#af2f2f',
};

export const GLYPH = {
  marker: '▌', // left half block, drawn next to line numbers that carry a thread
  vbar: '│',
  hbar: '─',
  tee: '┬',
  teeUp: '┴',
  dot: '●',
  ring: '○',
  sep: ' · ',
};

/** Status of a thread -> colour of its gutter marker / card header. */
export function threadColor(status) {
  if (status === 'resolved') return COLOR.dim;
  if (status === 'answered') return COLOR.ok;
  return COLOR.warn;
}
