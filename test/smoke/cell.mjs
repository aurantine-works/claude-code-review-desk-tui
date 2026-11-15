// Locate text on a captured tmux pane (plain `capture-pane -p` output) in terminal cells.
// Usage: node cell.mjs <capture-file> <needle> [--end] [--nth N] [--row-containing TEXT]
// Prints "x y" (0-based) of the first cell of the needle, or of its last cell with --end.
// Exit code 1 when the needle is not on the screen.
import fs from 'node:fs';
import stringWidth from 'string-width';

const [file, needle, ...rest] = process.argv.slice(2);
const end = rest.includes('--end');
const nthIdx = rest.indexOf('--nth');
const nth = nthIdx === -1 ? 0 : Number(rest[nthIdx + 1]);
const rcIdx = rest.indexOf('--row-containing');
const rowFilter = rcIdx === -1 ? null : rest[rcIdx + 1];

const lines = fs.readFileSync(file, 'utf8').split('\n');
let seen = 0;
for (let y = 0; y < lines.length; y++) {
  if (rowFilter && !lines[y].includes(rowFilter)) continue;
  let from = 0;
  for (;;) {
    const i = lines[y].indexOf(needle, from);
    if (i === -1) break;
    if (seen++ === nth) {
      const x = stringWidth(lines[y].slice(0, i));
      const w = stringWidth(needle);
      // the last cell of the needle (a wide character occupies two cells; report its first cell)
      const lastChar = [...needle].at(-1);
      console.log(end ? `${x + w - stringWidth(lastChar)} ${y}` : `${x} ${y}`);
      process.exit(0);
    }
    from = i + 1;
  }
}
process.exit(1);
