// Two Claude Code transcripts (in a throw-away CLAUDE_CONFIG_DIR) that both wrote the same file with a Bash command, so `rd add <file>`
// finds two candidate sessions and, in a terminal, asks which one.
// Usage: node seed-writers.mjs <claude-config-dir> <file>...      (the files are created; both sessions wrote all of them)
// Prints the two session ids, newest first, one per line.
import fs from 'node:fs';
import path from 'node:path';
import { createTranscript } from '../helpers/transcript.js';

const [cfg, ...files] = process.argv.slice(2);
if (!cfg || files.length === 0) throw new Error('usage: seed-writers.mjs <claude-config-dir> <file>...');
const abs = files.map((file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Migration report\n\nThe store migration was completed this week.\n');
  return fs.realpathSync(file);
});

const make = (sessionId, project, prompt, ageSeconds) => {
  const t = createTranscript(sessionId);
  t.user(prompt);
  for (const p of abs) t.toolUse('Bash', { command: `cat > ${p} <<'EOF'\n# Migration report\nEOF`, description: 'write the report' });
  // The helper stamps records with a fixed date in 2023: restamp them so the candidates are "1m ago" / "5m ago" (newest first).
  t.lines.forEach((line, i) => {
    try {
      const rec = JSON.parse(line);
      if (rec.timestamp) t.lines[i] = JSON.stringify({ ...rec, timestamp: new Date(Date.now() - ageSeconds * 1000 + i * 10).toISOString() });
    } catch {
      /* keep the line */
    }
  });
  const f = path.join(cfg, 'projects', project, `${sessionId}.jsonl`);
  t.write(f);
  const at = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(f, at, at);
};
const NEWER = 'aaaaaaaa-1111-4111-8111-111111111111';
const OLDER = 'bbbbbbbb-2222-4222-8222-222222222222';
make(NEWER, '-work-reports', 'Write this week\'s store migration up as a report', 60);
make(OLDER, '-work-notes', 'Summarise the migration for the team', 300);
console.log(NEWER);
console.log(OLDER);
