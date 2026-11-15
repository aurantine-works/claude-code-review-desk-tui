// findWriters: writes.jsonl first, then a bounded read-only scan of Claude Code transcripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { createTranscript } from './helpers/transcript.js';
import { findWriters, scanTranscripts, scanText, containsPath, pathForms, toolUseMentions, promptLabel, readTranscriptHead, transcriptFileOf } from '../src/feedback/transcriptScan.js';
import { recordWrite } from '../src/store/writes.js';
import { updateSession } from '../src/store/sessions.js';

useTempHome();
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const S3 = 'cccccccc-3333-4333-8333-333333333333';
let root;
let cfg;
let docDir;
let doc;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-writers-'));
  cfg = path.join(root, 'claude-config');
  docDir = path.join(root, 'out');
  fs.mkdirSync(docDir, { recursive: true });
  doc = path.join(docDir, 'summary.md');
  fs.writeFileSync(doc, '# summary\n');
  // canonical spelling, as rd compares paths after realpath
  doc = fs.realpathSync(doc);
  docDir = path.dirname(doc);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Write a transcript file for a session; `build(t)` adds records. `age`: seconds before now for the file's mtime. */
function transcript(sessionId, build, { project = '-work-proj', age = 0 } = {}) {
  const t = createTranscript(sessionId);
  build(t);
  const file = path.join(cfg, 'projects', project, `${sessionId}.jsonl`);
  t.write(file);
  const at = new Date(Date.now() - age * 1000);
  fs.utimesSync(file, at, at);
  return file;
}
// createTranscript stamps records with cwd '/work/proj' (helpers/transcript.js)
const bashWrite = (t, cmd) => t.toolUse('Bash', { command: cmd, description: 'write the file' });

describe('containsPath / pathForms', () => {
  it('whole-path mentions only', () => {
    expect(containsPath('cat > /a/b/x.md <<EOF', '/a/b/x.md')).toBe(true);
    expect(containsPath('cat > reports/x.md', 'reports/x.md')).toBe(true);
    expect(containsPath('cat > ./reports/x.md', 'reports/x.md')).toBe(true);
    expect(containsPath('echo "x" > "reports/x.md"; ls', 'reports/x.md')).toBe(true);
    expect(containsPath('cp a.md /a/b/x.md', '/a/b/x.md')).toBe(true);
    expect(containsPath('cat > my-reports/x.md', 'reports/x.md')).toBe(false); // longer directory name
    expect(containsPath('cat > /home/u/a/b/x.md', '/a/b/x.md')).toBe(false); // tail of a longer path
    expect(containsPath('cat > /a/b/x.md.bak', '/a/b/x.md')).toBe(false); // head of a longer file name
    expect(containsPath('cat > /a/b/x.mdx', '/a/b/x.md')).toBe(false);
    expect(containsPath('see x.md.', 'x.md')).toBe(true); // sentence end
    expect(containsPath('', 'x')).toBe(false);
    expect(containsPath(null, 'x')).toBe(false);
  });

  it('spellings: absolute, relative to the record cwd, ~/, $HOME/', () => {
    expect(pathForms('/home/u/proj/reports/x.md', '/home/u/proj', '/home/u').sort()).toEqual(['$HOME/proj/reports/x.md', '${HOME}/proj/reports/x.md', '/home/u/proj/reports/x.md', 'reports/x.md', '~/proj/reports/x.md'].sort());
    expect(pathForms('/data/x.md', '/home/u', '/home/u')).toContain('../../data/x.md');
    expect(pathForms('/data/x.md', undefined, '/home/u')).toEqual(['/data/x.md']);
  });

  it('toolUseMentions: any string of the input; read-only tools never count; directory + name counts', () => {
    const abs = '/home/u/notes/x.md';
    const bash = (command) => ({ type: 'tool_use', name: 'Bash', input: { command } });
    expect(toolUseMentions(bash('cat > ~/notes/x.md'), abs, '/tmp', '/home/u')).toBe(true);
    expect(toolUseMentions(bash('cd /home/u/notes && cat > x.md'), abs, '/tmp', '/home/u')).toBe(true);
    expect(toolUseMentions(bash('cat > x.md'), abs, '/home/u/notes', '/home/u')).toBe(true); // relative to the cwd
    expect(toolUseMentions(bash('cat > x.md'), abs, '/tmp', '/home/u')).toBe(false);
    expect(toolUseMentions({ type: 'tool_use', name: 'Read', input: { file_path: abs } }, abs, '/tmp')).toBe(false);
    expect(toolUseMentions({ type: 'tool_use', name: 'Write', input: { file_path: abs, content: 'x' } }, abs, '/tmp')).toBe(true);
    expect(toolUseMentions({ type: 'tool_use', name: 'Agent', input: { prompt: `write the report to ${abs}` } }, abs, '/tmp')).toBe(true);
    expect(toolUseMentions({ type: 'tool_use', name: 'MultiEdit', input: { edits: [{ nested: { deep: abs } }] } }, abs, '/tmp')).toBe(true);
    expect(toolUseMentions({ type: 'text', text: abs }, abs, '/tmp')).toBe(false);
    expect(toolUseMentions(null, abs, '/tmp')).toBe(false);
  });
});

describe('promptLabel / readTranscriptHead', () => {
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

  it('typed prompts only: not meta, not tool results, not local-command output; one line, 80 characters', () => {
    expect(promptLabel(user('  write\n  a   report  '))).toBe('write a report');
    expect(promptLabel(user([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]))).toBe('first second');
    expect(promptLabel(user('x', { isMeta: true }))).toBeNull();
    expect(promptLabel(user('x', { isSidechain: true }))).toBeNull();
    expect(promptLabel(user([{ type: 'tool_result', content: 'ok', tool_use_id: 't' }]))).toBeNull();
    expect(promptLabel(user('<local-command-stdout>Set model</local-command-stdout>'))).toBeNull();
    expect(promptLabel(user('<system-reminder>x</system-reminder>'))).toBeNull();
    expect(promptLabel({ type: 'assistant', message: { content: 'hi' } })).toBeNull();
    expect(promptLabel(user('<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the PR</command-args>'))).toBe('/review the PR');
    const long = promptLabel(user('字'.repeat(200)));
    expect(Array.from(long).length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
    expect(promptLabel(user('😀'.repeat(100)))).toBe('😀'.repeat(79) + '…'); // never cuts a surrogate pair
  });

  it('reads the first prompt and the launch cwd from the head of the file', async () => {
    const file = transcript(S1, (t) => {
      t.raw(JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }));
      t.raw(JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' }, cwd: '/launch/dir' }));
      t.user('please write the quarterly summary');
      t.user('second prompt');
    });
    expect(await readTranscriptHead(file)).toEqual({ firstPrompt: 'please write the quarterly summary', cwd: '/launch/dir' });
    expect(await readTranscriptHead(path.join(root, 'nope.jsonl'))).toEqual({ firstPrompt: null, cwd: null });
  });

  it('transcriptFileOf finds <config>/projects/*/<id>.jsonl; ids are validated', async () => {
    const file = transcript(S1, (t) => t.user('x'), { project: '-some-other-project' });
    expect(await transcriptFileOf(S1, cfg)).toBe(file);
    expect(await transcriptFileOf(S2, cfg)).toBeNull();
    expect(await transcriptFileOf('../escape', cfg)).toBeNull();
    expect(await transcriptFileOf(S1, path.join(root, 'no-config'))).toBeNull();
  });
});

describe('findWriters: writes.jsonl', () => {
  it('lists every writer, newest first, one entry per session, with launch cwd and first prompt', async () => {
    transcript(S1, (t) => t.user('draft the summary'));
    transcript(S2, (t) => t.user('polish the summary'));
    await updateSession(S1, { cwd: '/work/one', transcriptPath: path.join(cfg, 'projects', '-work-proj', `${S1}.jsonl`) });
    recordWrite({ path: doc, sessionId: S1, cwd: '/moved/away', tool: 'Write' });
    recordWrite({ path: doc, sessionId: S2, cwd: '/work/two', tool: 'Edit' });
    recordWrite({ path: doc, sessionId: S1, cwd: '/moved/away', tool: 'Edit' });
    recordWrite({ path: path.join(docDir, 'other.md'), sessionId: S3, cwd: '/x', tool: 'Write' });
    const r = await findWriters(doc, { configDir: cfg });
    expect(r.map((c) => c.sessionId)).toEqual([S1, S2]);
    expect(r[0]).toMatchObject({ source: 'writes', cwd: '/work/one', project: 'one', firstPrompt: 'draft the summary' }); // registry cwd wins over the hook's
    // no registry record: the launch directory in the transcript (found by session id) beats the cwd of the hook call
    expect(r[1]).toMatchObject({ source: 'writes', cwd: '/work/proj', project: 'proj', firstPrompt: 'polish the summary' });
    expect(typeof r[0].lastAt).toBe('string');
    expect(r.truncated).toBeUndefined();
    expect((await findWriters(doc, { configDir: cfg, limit: 1 })).map((c) => c.sessionId)).toEqual([S1]);
    // neither a registry record nor a transcript: the cwd of the write is all there is
    recordWrite({ path: doc, sessionId: S3, cwd: '/work/three', tool: 'Write' });
    expect((await findWriters(doc, { configDir: cfg }))[0]).toMatchObject({ sessionId: S3, cwd: '/work/three', project: 'three', firstPrompt: '' });
  });

  it('does not scan transcripts when writes.jsonl knows the file', async () => {
    transcript(S2, (t) => bashWrite(t, `cat > ${doc} <<'EOF'\nx\nEOF`));
    recordWrite({ path: doc, sessionId: S1, cwd: '/work/one', tool: 'Write' });
    const r = await findWriters(doc, { configDir: cfg });
    expect(r.map((c) => c.sessionId)).toEqual([S1]);
  });
});

describe('findWriters: transcript scan (files written through Bash)', () => {
  it('finds the session whose Bash command wrote the file, by absolute path', async () => {
    transcript(S1, (t) => {
      t.user('write a summary into the out directory');
      t.assistantText('on it');
      bashWrite(t, `cat > ${doc} <<'EOF'\n# summary\nEOF`);
    });
    transcript(S2, (t) => t.user('something unrelated').assistantText('fine'));
    const r = await findWriters(doc, { configDir: cfg });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sessionId: S1, source: 'transcript', cwd: '/work/proj', project: 'proj', firstPrompt: 'write a summary into the out directory' });
    expect(r[0].lastAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(r[0].transcriptPath).toBe(path.join(cfg, 'projects', '-work-proj', `${S1}.jsonl`));
  });

  it('matches the path relative to the record cwd, and `cd <dir> && … > name`', async () => {
    const relDoc = '/work/proj/reports/week.md';
    transcript(S1, (t) => bashWrite(t, 'mkdir -p reports && cat > reports/week.md <<EOF\nx\nEOF'));
    const r = await scanTranscripts(relDoc, { configDir: cfg, home: '/nonexistent-home' });
    expect(r.candidates.map((c) => c.sessionId)).toEqual([S1]);
    transcript(S2, (t) => bashWrite(t, `cd ${docDir} && printf x > summary.md`));
    expect((await scanTranscripts(doc, { configDir: cfg })).candidates.map((c) => c.sessionId)).toEqual([S2]);
  });

  it('ignores sessions that only read the file, api-request-blob duplicates, sidechain turns, near-miss names', async () => {
    transcript(S1, (t) => t.toolUse('Read', { file_path: doc }));
    transcript(S2, (t) => {
      t.sidechainText(`I wrote ${doc}`);
      bashWrite(t, `cat > ${doc}.bak <<EOF\nx\nEOF`);
      bashWrite(t, `cat > ${path.join(docDir, 'old-summary.md')} <<EOF\nx\nEOF`);
    });
    // a blob that mentions the path but is not a conversation record
    transcript(S3, (t) => t.raw(JSON.stringify({ type: 'api-request-blob', sessionId: S3, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `cat > ${doc}` } }] } })));
    const r = await scanTranscripts(doc, { configDir: cfg });
    expect(r.candidates).toEqual([]);
    expect(await findWriters(doc, { configDir: cfg })).toHaveLength(0);
  });

  it('several sessions: newest first, one entry each, the newest mention of a session counts', async () => {
    transcript(S1, (t) => bashWrite(t, `cat > ${doc} <<EOF\n1\nEOF`));
    transcript(S2, (t) => {
      bashWrite(t, `echo a > ${doc}`);
      bashWrite(t, `echo b >> ${doc}`);
    });
    const r = await findWriters(doc, { configDir: cfg });
    expect(r.map((c) => c.sessionId).sort()).toEqual([S1, S2]);
    // timestamps come from the transcript records: sorted newest first
    expect(r[0].lastAt >= r[1].lastAt).toBe(true);
    expect(r.find((c) => c.sessionId === S2).lastAt).toBe(scanText(fs.readFileSync(path.join(cfg, 'projects', '-work-proj', `${S2}.jsonl`), 'utf8'), doc).lastAt);
  });

  it('time window: transcripts untouched since long before the file was written are skipped, unless nothing else is found', async () => {
    const mtime = new Date();
    fs.utimesSync(doc, mtime, mtime);
    const oldFile = transcript(S1, (t) => bashWrite(t, `cat > ${doc} <<EOF\nx\nEOF`), { age: 3 * 3600 });
    const recent = transcript(S2, (t) => bashWrite(t, `echo > ${doc}`), { age: 60 });
    let r = await scanTranscripts(doc, { configDir: cfg });
    expect(r.candidates.map((c) => c.sessionId)).toEqual([S2]); // the old one is not even read
    expect(r.scanned).toBe(1);
    fs.rmSync(recent);
    r = await scanTranscripts(doc, { configDir: cfg });
    expect(r.candidates.map((c) => c.sessionId)).toEqual([S1]); // second pass over the older transcripts
    expect(r.scanned).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(true);
  });

  it('a missing document is searched without a time filter', async () => {
    const gone = path.join(docDir, 'deleted.md');
    transcript(S1, (t) => bashWrite(t, `echo x > ${gone}`), { age: 99 * 3600 });
    expect((await scanTranscripts(gone, { configDir: cfg })).candidates.map((c) => c.sessionId)).toEqual([S1]);
  });

  it('budget: at most maxFiles transcripts (newest first) and budgetMs; the result says truncated', async () => {
    for (const [i, sid] of [S1, S2, S3].entries()) transcript(sid, (t) => bashWrite(t, `echo > ${doc}`), { age: 10 + i * 10 });
    let r = await scanTranscripts(doc, { configDir: cfg, maxFiles: 2 });
    expect(r.candidates.map((c) => c.sessionId).sort()).toEqual([S1, S2]); // the two newest
    expect(r).toMatchObject({ truncated: true, scanned: 2 });
    const all = await scanTranscripts(doc, { configDir: cfg });
    expect(all).toMatchObject({ truncated: false, scanned: 3 });
    let t = 0;
    r = await scanTranscripts(doc, { configDir: cfg, budgetMs: 5000, now: () => (t += 4000) }); // each clock read costs 4 s
    expect(r.truncated).toBe(true);
    expect(r.candidates.length).toBeLessThan(3);
    const w = await findWriters(doc, { configDir: cfg, maxFiles: 1 });
    expect(w.truncated).toBe(true);
    expect(w).toHaveLength(1);
  });

  it('is read-only and tolerates junk: bad lines, non-jsonl files, missing config dir', async () => {
    const file = transcript(S1, (t) => {
      t.raw('{ not json with summary.md and tool_use');
      bashWrite(t, `echo > ${doc}`);
    });
    fs.writeFileSync(path.join(cfg, 'projects', '-work-proj', 'notes.txt'), `${doc} tool_use`);
    fs.mkdirSync(path.join(cfg, 'projects', '-work-proj', S1, 'subagents'), { recursive: true });
    const snapshot = () => fs.readdirSync(path.join(cfg, 'projects', '-work-proj'), { recursive: true }).map((f) => [f, fs.statSync(path.join(cfg, 'projects', '-work-proj', f)).mtimeMs]);
    const before = snapshot();
    const r = await findWriters(doc, { configDir: cfg });
    expect(r.map((c) => c.sessionId)).toEqual([S1]);
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(file, 'utf8')).toContain('summary.md');
    expect(await findWriters(doc, { configDir: path.join(root, 'no-such-dir') })).toEqual([]);
  });

  it('uses CLAUDE_CONFIG_DIR by default', async () => {
    transcript(S1, (t) => bashWrite(t, `echo > ${doc}`));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      expect((await findWriters(doc)).map((c) => c.sessionId)).toEqual([S1]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});
