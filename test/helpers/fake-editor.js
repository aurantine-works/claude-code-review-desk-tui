// A fake $EDITOR for tests: `node fake-editor.js <file>`. Behaviour comes from the environment:
//   FAKE_EDITOR_MODE  append (default) | same | clear | fail | signal
//   FAKE_EDITOR_TEXT  text appended (append) -- "\n" sequences are real newlines
//   FAKE_EDITOR_LOG   file that receives a JSON line {argv, file, mode, content} for every run
import fs from 'node:fs';

const mode = process.env.FAKE_EDITOR_MODE ?? 'append';
const args = process.argv.slice(2);
const file = args[args.length - 1];
const content = fs.readFileSync(file, 'utf8');
if (process.env.FAKE_EDITOR_LOG) {
  fs.appendFileSync(process.env.FAKE_EDITOR_LOG, JSON.stringify({ argv: args, file, mode: fs.statSync(file).mode & 0o777, content }) + '\n');
}
if (mode === 'fail') process.exit(3);
if (mode === 'signal') process.kill(process.pid, 'SIGKILL');
if (mode === 'clear') fs.writeFileSync(file, '');
if (mode === 'append') fs.appendFileSync(file, (process.env.FAKE_EDITOR_TEXT ?? 'edited').replace(/\\n/g, '\n') + '\n');
