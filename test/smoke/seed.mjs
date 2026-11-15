// Seed a temp RD_HOME with a doc review, a plan review and an optional large doc, for the TUI smoke test.
// Usage: RD_HOME=<tmp> [SEED_SESSION_PID=<pid>] node test/smoke/seed.mjs [--big] [--plain] [--long]
//   --big    also a 2000-line doc
//   --plain  also a doc without any thread
//   --long   also a doc whose only thread has a very long question and answer (a tall card in the panel)
//   --md     also a doc that uses every Markdown syntax the rendered view knows (CJK table and inline text, nested lists, links, ...)
//   --diff   also two docs with several revisions, for the diff view: "diff" (9 lines, 3 revisions, 2 threads) and "diffbig" (600 lines, 2 revisions)
//   --ended  also a doc bound to a session that has ended (channel C): "ended"; its session directory is $SEED_DOCS_DIR/proj
// SEED_DOCS_DIR: where the reviewed files are written (default: a new temp directory); every doc review's file exists and holds
// its latest revision, so the screens do not report a missing or externally modified file.
// SEED_SESSION_PID: pid recorded for the seeded Claude session (default: this process, i.e. dead once the seed ends);
// pass the pid of a long-lived process so the TUI sees a live, idle session.
// Prints one JSON line: {"doc": "<id>", "plan": "<id>", "big": "<id>"|null, "plain": ..., "long": ..., "md": ..., "diff": ..., "ended": ...}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReview } from '../../src/store/reviews.js';
import { addThread, replyToThread } from '../../src/store/threads.js';
import { updateSession } from '../../src/store/sessions.js';
import { appendRevision } from '../../src/store/revisions.js';
import { makeAnchor } from '../../src/anchor/index.js';

if (!process.env.RD_HOME) throw new Error('RD_HOME must be set');

const docsDir = process.env.SEED_DOCS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rd-smoke-docs-'));
fs.mkdirSync(docsDir, { recursive: true });
/** Write the reviewed file and return its path. */
const docFile = (name, content) => {
  const p = path.join(docsDir, name);
  fs.writeFileSync(p, content);
  return p;
};

const doc = [
  '# Weekly report · Week 45',
  '',
  '## Summary',
  '',
  'This week the device table refactor was completed, mostly the store migration and the slice split. Overall progress is on track, but two risks need attention.',
  '',
  '## Risks',
  '',
  'Migrating the old store is low risk because it only affects the device and policy slices.',
  'The rollback plan relies on a feature flag; see `store.migrate()` for details.',
  '',
  '- Risk 1: the old data format is incompatible',
  '- Risk 2: lock contention on concurrent writes',
  '',
  '```js',
  'const slices = ["device", "policy"];',
  'await migrate(slices);',
  '```',
  '',
  '## Schedule',
  '',
  'Expected to take two weeks.',
  '> Note: the schedule does not include testing time.',
  '',
  '---',
  '',
  'Last line of the report.',
].join('\n');

const plan = ['# Plan: refactor the device table', '', '1. Split the device slice', '2. Migrate the old store', '3. Add tests', '', '## Risks', '', 'The old data may be incompatible during the migration.'].join('\n');

// Every 7th line is long CJK text on purpose: wrapping and scrolling of wide characters.
const big = Array.from({ length: 2000 }, (_, i) =>
  i % 50 === 0 ? `## Section ${i / 50}` : i % 7 === 0 ? `第 ${i + 1} 行：这是一段比较长的中文内容，用来测试折行和滚动性能，包含 english words 与 \`code\`。` : `Line ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
).join('\n');

await updateSession('smoke-session', { cwd: '/home/dev/proj-x', pid: Number(process.env.SEED_SESSION_PID) || process.pid, state: 'idle', injector: { kind: 'none' }, transcriptPath: '/tmp/none.jsonl' });

const docMeta = await createReview({ kind: 'doc', docPath: docFile('week-45.md', doc), sessionId: 'smoke-session', cwd: '/home/dev/proj-x', content: doc, source: 'Write', turn: 1 });
const t1 = await addThread(docMeta.id, { anchor: makeAnchor(doc, { startLine: 9, endLine: 9 }, 1), text: 'What makes the risk low?', send: true });
await replyToThread(docMeta.id, t1.id, 'Both slices are only used by the device table component; there are no cross-slice dependencies.');
await addThread(docMeta.id, { anchor: makeAnchor(doc, { startLine: 22, endLine: 22, startCol: 0, endCol: 6 }, 1), text: 'Does it include testing?', send: false });

const planMeta = await createReview({ kind: 'plan', sessionId: 'smoke-session', cwd: '/home/dev/proj-x', content: plan, source: 'ExitPlanMode', turn: 1 });

let bigId = null;
if (process.argv.includes('--big')) {
  const m = await createReview({ kind: 'doc', docPath: docFile('big.md', big), sessionId: 'smoke-session', cwd: '/home/dev/proj-x', content: big, source: 'Write', turn: 1 });
  bigId = m.id;
}
const extra = {};
if (process.argv.includes('--plain')) {
  extra.plain = (await createReview({ kind: 'doc', docPath: docFile('plain.md', doc), sessionId: 'smoke-session', cwd: '/home/dev/proj-x', content: doc, source: 'Write', turn: 1 })).id;
}
if (process.argv.includes('--long')) {
  const m = await createReview({ kind: 'doc', docPath: docFile('long.md', doc), sessionId: 'smoke-session', cwd: '/home/dev/proj-x', content: doc, source: 'Write', turn: 1 });
  const t = await addThread(m.id, { anchor: makeAnchor(doc, { startLine: 9, endLine: 9 }, 1), text: 'A very long question, '.repeat(33), send: true });
  await replyToThread(m.id, t.id, 'A very long answer, '.repeat(96));
  extra.long = m.id;
}
if (process.argv.includes('--md')) {
  const md = [
    '---',
    'title: Rendering sample',
    '---',
    '# Rendering sample **overview**',
    '',
    'Setext heading',
    '==============',
    '',
    '## Paragraphs and inline',
    '这是**加粗**、*斜体*、***粗斜体***、~~删除线~~ 和 `行内代码`，还有 [链接文字](https://example.com/very/long/url) 与 ![图片说明](a.png)。',
    'Escapes \\*asterisks\\* and <https://example.com/auto> and snake_case_name.',
    '',
    '- First item',
    '  - Nested **second level**',
    '    - Third level',
    '- [ ] To do',
    '- [x] Done',
    '1. Ordered one',
    '2. Ordered two',
    '',
    '> A quote with *emphasis*',
    '> > Nested quote',
    '',
    '| 名称 | 说明 | 数量 |',
    '|:---|:---:|---:|',
    '| 苹果 | 水果，**红色** | 3 |',
    '| banana | `yellow` | 12 |',
    '',
    '```js',
    'const a = **not bold**; // not parsed inside code blocks',
    '```',
    '',
    'Sub heading',
    '-----------',
    '',
    '---',
    '',
    'The last line.',
  ].join('\n');
  extra.md = (await createReview({ kind: 'doc', docPath: docFile('render.md', md), sessionId: 'smoke-session', cwd: '/home/dev/proj-x', content: md, source: 'Write', turn: 1 })).id;
}
if (process.argv.includes('--diff')) {
  const v1 = ['# Weekly report', '', '## Risks', 'Migrating the old store is low risk because it only affects two slices.', 'The rollback plan relies on a feature flag.', '', '## Schedule', 'Expected to take two weeks.', '', 'The end.'].join('\n');
  const v2 = ['# Weekly report', '', '## Risks', 'Migrating the old store is medium risk because it affects three slices.', 'The rollback plan relies on a feature flag.', 'One more line of explanation.', '', '## Schedule', 'Expected to take three weeks.', '', 'The end.'].join('\n');
  const v3 = ['# Weekly report', '', '## Risks', 'Migrating the old store is medium risk because it affects three slices.', 'The rollback plan relies on a feature flag and a canary.', 'One more line of explanation.', '', '## Schedule', 'Expected to take three weeks.'].join('\n');
  const m = await createReview({ kind: 'doc', docPath: docFile('diff.md', v3), sessionId: 'smoke-session', cwd: '/home/dev/proj-x', content: v1, source: 'Write', turn: 1 });
  await addThread(m.id, { anchor: makeAnchor(v1, { startLine: 4, endLine: 4 }, 1), text: 'What makes the risk low?', send: false });
  await appendRevision(m.id, v2, { source: 'Edit', turn: 2 });
  await addThread(m.id, { anchor: makeAnchor(v2, { startLine: 9, endLine: 9 }, 2), text: 'How did you get to three weeks?', send: false });
  await appendRevision(m.id, v3, { source: 'Edit', turn: 3 });
  extra.diff = m.id;

  const lines = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}: some content for the scrolling tests, line ${i + 1}`);
  const edited = lines.slice();
  edited[2] = 'Line 3: the beginning was modified';
  edited[589] = 'Line 590: the end was modified';
  const b = await createReview({ kind: 'doc', docPath: docFile('diffbig.md', edited.join('\n')), sessionId: 'smoke-session', cwd: '/home/dev/proj-x', content: lines.join('\n'), source: 'Write', turn: 1 });
  await appendRevision(b.id, edited.join('\n'), { source: 'Edit', turn: 2 });
  extra.diffbig = b.id;
}
if (process.argv.includes('--ended')) {
  const proj = path.join(docsDir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  // The session ended (SessionEnd) and its process is gone: a send lands on channel C.
  await updateSession('smoke-ended', { cwd: proj, pid: 2 ** 22 + 4242, state: 'ended', injector: { kind: 'none' }, transcriptPath: '/tmp/none.jsonl' });
  const m = await createReview({ kind: 'doc', docPath: docFile('ended.md', doc), sessionId: 'smoke-ended', cwd: proj, content: doc, source: 'Write', turn: 1 });
  extra.ended = m.id;
}
console.log(JSON.stringify({ doc: docMeta.id, plan: planMeta.id, big: bigId, ...extra }));
