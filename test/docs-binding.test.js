// M3 document handling: rd add / rd open <path> (resolveDocument + the real CLI), rebinding a review to another session,
// external edit detection and adoption.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { createTranscript } from './helpers/transcript.js';
import { installFakeClaude } from './helpers/fake-claude.js';
import { resolveDocument, AmbiguousWritersError, NoWritersError, loadPicker } from '../src/cli/addCmd.js';
import { resolveOpenTarget } from '../src/cli/tuiCommands.js';
import { createReview, getMeta, readRevision } from '../src/store/reviews.js';
import { addThread, listThreads, replyToThread } from '../src/store/threads.js';
import { rebindSession, checkExternal, adoptExternal, readDocText, registerManualDoc, MAX_DOC_BYTES, EXTERNAL_SETTLE_MS, isUuidSessionId } from '../src/store/docs.js';
import { approveReview, closeReview } from '../src/store/lifecycle.js';
import { getActiveReview, setActiveReview } from '../src/store/docsIndex.js';
import { updateSession } from '../src/store/sessions.js';
import { recordWrite, lastWriteAt } from '../src/store/writes.js';
import { takeUnreceived } from '../src/store/outbox.js';
import { registerDocWrite } from '../src/store/docs.js';
import { readJson } from '../src/store/io.js';
import { paths, canonicalPath } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';

const home = useTempHome();
const BIN = path.resolve('bin/rd.js');
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const S3 = 'cccccccc-3333-4333-8333-333333333333';
let root;
let cfg;
let doc;
const saved = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-docs-'));
  cfg = path.join(root, 'claude-config');
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  doc = canonicalPath(path.join(root, 'out', 'summary.md'));
  fs.writeFileSync(doc, '# Summary\n\nRisk is low.\nTakes two weeks.\n');
  process.env.CLAUDE_CONFIG_DIR = cfg;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

function transcript(sessionId, build, { project = '-work-proj' } = {}) {
  const t = createTranscript(sessionId);
  build(t);
  return t.write(path.join(cfg, 'projects', project, `${sessionId}.jsonl`));
}
const bashWrite = (t, file) => t.toolUse('Bash', { command: `cat > ${file} <<'EOF'\nx\nEOF` });
const wrote = (sid, prompt = `prompt of ${sid.slice(0, 4)}`) => transcript(sid, (t) => (t.user(prompt), bashWrite(t, doc)));

function rd(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, RD_HOME: home(), CLAUDE_CONFIG_DIR: cfg, CLAUDE_PID: '', CLAUDE_CODE_SESSION_ID: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('resolveDocument (rd add / rd open <path>)', () => {
  it('one writer found in a transcript: registers a manual doc review bound to it', async () => {
    wrote(S1, 'write the summary please');
    const r = await resolveDocument(doc);
    expect(r).toMatchObject({ created: true, path: doc, sessionId: S1, cwd: '/work/proj' });
    const meta = getMeta(r.id);
    expect(meta).toMatchObject({ kind: 'doc', docPath: doc, sessionId: S1, cwd: '/work/proj', status: 'awaiting_review', currentRevision: 1, title: 'Summary' });
    expect(meta.revisions[0]).toMatchObject({ n: 1, source: 'manual', turn: 0 });
    expect(meta.writers).toEqual([{ sessionId: S1, cwd: '/work/proj', project: 'proj', lastAt: expect.any(String), firstPrompt: 'write the summary please', source: 'transcript' }]);
    expect(readRevision(r.id, 1)).toBe(fs.readFileSync(doc, 'utf8'));
    expect(getActiveReview(doc)).toBe(r.id);
  });

  it('an active review is returned as it is; a closed one is replaced', async () => {
    wrote(S1);
    const a = await resolveDocument(doc);
    const b = await resolveDocument(doc);
    expect(b).toMatchObject({ id: a.id, created: false, sessionId: S1 });
    fs.rmSync(doc); // the file is gone but the review is active: add / open still work (the TUI shows the snapshot)
    expect((await resolveDocument(doc)).id).toBe(a.id);
    await closeReview(a.id);
    fs.writeFileSync(doc, '# Again\n');
    const c = await resolveDocument(doc);
    expect(c.created).toBe(true);
    expect(c.id).not.toBe(a.id);
  });

  it('writes.jsonl wins; relative paths resolve against opts.cwd; --session is honoured without any search', async () => {
    recordWrite({ path: doc, sessionId: S2, cwd: '/work/two', tool: 'Write' });
    wrote(S1);
    const r = await resolveDocument('out/summary.md', { cwd: root });
    expect(r).toMatchObject({ created: true, sessionId: S2, cwd: '/work/two' });
    await closeReview(r.id);
    const explicit = await resolveDocument(doc, { session: S3 });
    expect(explicit).toMatchObject({ created: true, sessionId: S3, cwd: path.dirname(doc) }); // unknown session: the file's directory
    const meta = getMeta(explicit.id);
    expect(meta.writers[0]).toMatchObject({ sessionId: S3, source: 'explicit' });
    expect(meta.writers.map((w) => w.sessionId)).toEqual([S3, S2]); // plus the other writers writes.jsonl knows
  });

  it('several writers in writes.jsonl: the last writer is bound, the others are kept for rebinding (no question asked)', async () => {
    recordWrite({ path: doc, sessionId: S1, cwd: '/work/one', tool: 'Write' });
    recordWrite({ path: doc, sessionId: S2, cwd: '/work/two', tool: 'Edit' });
    let asked = false;
    const r = await resolveDocument(doc, { pick: async () => ((asked = true), null) });
    expect(asked).toBe(false);
    expect(r).toMatchObject({ sessionId: S2, cwd: '/work/two' });
    expect(getMeta(r.id).writers.map((w) => [w.sessionId, w.source])).toEqual([[S2, 'writes'], [S1, 'writes']]);
  });

  it('--session: well-formed UUID or a known session; cwd from the registry, then the transcript', async () => {
    await expect(resolveDocument(doc, { session: 'not a session' })).rejects.toThrow(/invalid session id/);
    await expect(resolveDocument(doc, { session: 'short-id' })).rejects.toThrow(/expected a Claude Code session UUID/);
    await expect(resolveDocument(doc, { session: '../../etc/passwd' })).rejects.toThrow(/invalid session id/);
    expect(isUuidSessionId(S1)).toBe(true);
    expect(isUuidSessionId('short-id')).toBe(false);
    await updateSession('legacy-id', { cwd: '/work/legacy' });
    const known = await resolveDocument(doc, { session: 'legacy-id' });
    expect(known).toMatchObject({ sessionId: 'legacy-id', cwd: '/work/legacy' });
    await closeReview(known.id);
    wrote(S1);
    expect(await resolveDocument(doc, { session: S1 })).toMatchObject({ sessionId: S1, cwd: '/work/proj' });
  });

  it('several writers: no chooser -> AmbiguousWritersError with the candidates; a chooser picks one; the rest become meta.writers', async () => {
    wrote(S1);
    wrote(S2);
    let err;
    try {
      await resolveDocument(doc);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AmbiguousWritersError);
    expect(err.code).toBe('ambiguous-writers');
    expect(err.candidates.map((c) => c.sessionId).sort()).toEqual([S1, S2]);
    expect(err.message).toContain('--session');
    expect(getActiveReview(doc)).toBeNull(); // nothing registered yet

    let seen;
    const r = await resolveDocument(doc, { pick: async (candidates, info) => ((seen = { candidates, info }), candidates.find((c) => c.sessionId === S2)) });
    expect(seen.info).toEqual({ path: doc });
    expect(r.sessionId).toBe(S2);
    expect(getMeta(r.id).writers.map((w) => w.sessionId).sort()).toEqual([S1, S2]);
    expect(getMeta(r.id).writers[0].sessionId).toBe(S2); // the chosen one first
    await closeReview(r.id);

    await expect(resolveDocument(doc, { pick: async () => null })).rejects.toThrow(/cancelled/);
    await expect(resolveDocument(doc, { pick: async () => ({ sessionId: S3 }) })).rejects.toThrow(/not one of the candidates/);
  });

  it('nobody found: NoWritersError points at --session', async () => {
    await expect(resolveDocument(doc)).rejects.toBeInstanceOf(NoWritersError);
    await expect(resolveDocument(doc)).rejects.toThrow(/--session <id>/);
  });

  it('file checks: exists, regular file, text, at most 2 MB; never rd\'s own state', async () => {
    await expect(resolveDocument(path.join(root, 'missing.md'), { session: S1 })).rejects.toThrow(/file not found/);
    await expect(resolveDocument(root, { session: S1 })).rejects.toThrow(/not a regular file/);
    const bin = path.join(root, 'blob.md');
    fs.writeFileSync(bin, Buffer.from([0x23, 0x20, 0x00, 0x01]));
    await expect(resolveDocument(bin, { session: S1 })).rejects.toThrow(/not a text file/);
    const big = path.join(root, 'big.md');
    fs.writeFileSync(big, Buffer.alloc(MAX_DOC_BYTES + 1, 0x61));
    await expect(resolveDocument(big, { session: S1 })).rejects.toThrow(/larger than 2 MB/);
    fs.writeFileSync(big, Buffer.alloc(MAX_DOC_BYTES, 0x61));
    expect((await resolveDocument(big, { session: S1 })).created).toBe(true); // exactly the limit is fine
    await expect(resolveDocument(path.join(home(), 'config.json'), { session: S1 })).rejects.toThrow(/own state/);
    await expect(resolveDocument('', { session: S1 })).rejects.toThrow(/path/);
    await expect(resolveDocument('a\0b', { session: S1 })).rejects.toThrow(/path/);
    expect(() => readDocText(path.join(root, 'nope'))).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('two concurrent registrations of one path create one review', async () => {
    const [a, b] = await Promise.all([resolveDocument(doc, { session: S1 }), resolveDocument(doc, { session: S1 })]);
    expect(a.id).toBe(b.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });

  it('resolveOpenTarget: a path goes through the same lookup; an id is still validated; --session passes through', async () => {
    wrote(S1);
    const id = await resolveOpenTarget(doc);
    expect(getMeta(id).sessionId).toBe(S1);
    expect(await resolveOpenTarget(doc)).toBe(id);
    wrote(S2);
    await closeReview(id);
    await expect(resolveOpenTarget(doc)).rejects.toMatchObject({ code: 'ambiguous-writers' });
    expect(getMeta(await resolveOpenTarget(doc, { session: S3 })).sessionId).toBe(S3);
    await expect(resolveOpenTarget('nonsense')).rejects.toThrow(/invalid review id/);
  });

  it('loadPicker is only offered on a terminal (and only when the component exists)', async () => {
    expect(await loadPicker({ stdin: { isTTY: false }, stdout: { isTTY: true } })).toBeNull();
    expect(await loadPicker({ stdin: { isTTY: true }, stdout: { isTTY: false } })).toBeNull();
    const p = await loadPicker({ stdin: { isTTY: true }, stdout: { isTTY: true } });
    expect(p === null || typeof p === 'function').toBe(true); // Agent I's src/tui/pickCandidate.js, not there yet or a function
  });
});

describe('rd add / rd open / rd resume through bin/rd.js', () => {
  it('add: one writer -> registered, again -> already registered, --json', async () => {
    wrote(S1);
    const a = await rd(['add', doc]);
    expect(a.code).toBe(0);
    expect(a.stdout).toMatch(new RegExp(`^registered (doc-\\d{8}-\\d{6}-[a-z0-9]{4}) \\(session ${S1}\\) ${doc}\n$`));
    const id = /registered (\S+)/.exec(a.stdout)[1];
    const b = await rd(['add', doc]);
    expect(b).toMatchObject({ code: 0, stdout: `already registered: ${id} ${doc}\n` });
    const c = await rd(['add', doc, '--json']);
    expect(JSON.parse(c.stdout)).toMatchObject({ id, created: false, sessionId: S1, path: doc });
  });

  it('add: several writers (no terminal) -> candidates on stdout, instruction on stderr, exit code 2; then --session', async () => {
    wrote(S1, 'first session\twith a tab');
    wrote(S2, 'second session');
    const r = await rd(['add', doc]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('2 sessions wrote');
    expect(r.stderr).toContain('--session <id>');
    const rows = r.stdout.trim().split('\n').map((l) => l.split('\t'));
    expect(rows.map((x) => x[0]).sort()).toEqual([S1, S2]);
    expect(rows[0]).toHaveLength(4);
    expect(rows.find((x) => x[0] === S1)[3]).toBe('first session with a tab'); // tabs inside the prompt are flattened
    expect(rows[0][2]).toBe('proj');
    const json = await rd(['add', doc, '--json']);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout).map((c) => c.sessionId).sort()).toEqual([S1, S2]);
    expect(JSON.parse(json.stdout)[0]).toMatchObject({ project: 'proj', source: 'transcript', firstPrompt: expect.any(String) });
    expect(Object.keys(readJson(paths.docsIndex(), {}))).toEqual([]); // nothing registered by the failed attempts

    const ok = await rd(['add', doc, '--session', S2]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(`(session ${S2})`);
  });

  it('add: errors exit 1 with one line on stderr', async () => {
    const none = await rd(['add', doc]);
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/^rd: no Claude Code session found that wrote .*--session <id>\n$/);
    const missing = await rd(['add', path.join(root, 'nope.md'), '--session', S1]);
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.stderr).toContain('file not found');
    const badSession = await rd(['add', doc, '--session', 'x y']);
    expect(badSession.code).toBe(1);
    expect(badSession.stderr).toContain('invalid session id');
  });

  it('open <path> with several candidates behaves like add: exit code 2, no TUI', async () => {
    wrote(S1);
    wrote(S2);
    const r = await rd(['open', doc]);
    expect(r.code).toBe(2);
    expect(r.stdout.trim().split('\n')).toHaveLength(2);
    const bad = await rd(['open', 'nonsense']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('invalid review id');
  });

  it('resume: prints the interactive command; --headless starts claudeBin in the background and returns at once', async () => {
    const m = await createReview({ kind: 'doc', docPath: doc, sessionId: S1, cwd: '/launch dir', content: 'x', source: 'manual' });
    await addThread(m.id, { anchor: makeAnchor('x', { startLine: 1, endLine: 1 }, 1), text: 'q', send: true });
    const info = await rd(['resume', m.id]);
    expect(info).toMatchObject({ code: 0, stdout: `cd '/launch dir' && claude --resume ${S1}\n` });
    const json = JSON.parse((await rd(['resume', m.id, '--json'])).stdout);
    expect(json).toMatchObject({ reviewId: m.id, sessionId: S1, interactive: expect.stringContaining('claude --resume') });
    expect(json.headlessArgv.slice(1, 5)).toEqual(['--resume', S1, '-p', `/review-reply ${m.id}`]);

    // headless: needs the session's directory to exist and a claude to run
    const fake = installFakeClaude(root);
    fs.writeFileSync(path.join(home(), 'config.json'), JSON.stringify({ delivery: { claudeBin: fake.bin } }));
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj);
    await updateSession(S1, { cwd: proj, state: 'ended', pid: 2 ** 22 + 99 });
    const out = path.join(root, 'fake-out.json');
    const r = await rd(['resume', m.id, '--headless'], { env: { FAKE_CLAUDE_OUT: out, FAKE_CLAUDE_SLEEP_MS: '20000' } });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^started headless resume of session ${S1} \\(pid \\d+\\); log: ${home()}/logs/headless-${m.id}.log\n$`));
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((res) => setTimeout(res, 50));
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).argv[0]).toBe('--resume');
    // the run is still alive (the CLI that started it is long gone): a second start is refused, and the status says so
    const again = await rd(['resume', m.id, '--headless'], { env: { FAKE_CLAUDE_OUT: out } });
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already in progress');
    const pid = getMeta(m.id).headless.pid;
    const { headlessStatus } = await import('../src/delivery/resume.js');
    expect(headlessStatus(m.id)).toMatchObject({ state: 'running', pid });
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100 && headlessStatus(m.id).state === 'running'; i++) await new Promise((res) => setTimeout(res, 50));
    expect(headlessStatus(m.id)).toMatchObject({ state: 'failed', exitCode: null, unreceived: 1 }); // nobody recorded how it ended
    const refused = await rd(['resume', 'doc-1']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('invalid review id');
  });

  it('resume --headless without waiting feedback is refused with a reason', async () => {
    const m = await createReview({ kind: 'doc', docPath: doc, sessionId: S1, cwd: root, content: 'x', source: 'manual' });
    await updateSession(S1, { cwd: root, state: 'ended', pid: 2 ** 22 + 99 });
    const r = await rd(['resume', m.id, '--headless']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no feedback is waiting for delivery');
  });
});

describe('rebindSession', () => {
  const content = '# Doc\n\nRisk is low.\n';
  const anchor = makeAnchor(content, { startLine: 3, endLine: 3 }, 1);
  async function review(writers = [{ sessionId: S1, cwd: '/work/one', project: 'one' }, { sessionId: S2, cwd: '/work/two', project: 'two' }]) {
    return createReview({ kind: 'doc', docPath: doc, sessionId: S1, cwd: '/work/one', content, source: 'manual', extra: { writers } });
  }

  it('binds to a listed writer: session id, cwd, queued feedback goes along (injection marks dropped)', async () => {
    const m = await review();
    await addThread(m.id, { anchor, text: 'q', send: true });
    const { withReview } = await import('../src/store/reviews.js');
    await withReview(m.id, (ctx) => void (ctx.outbox[0].injectedAt = '2026-11-12T10:00:00.000Z'));
    const meta = await rebindSession(m.id, S2);
    expect(meta).toMatchObject({ sessionId: S2, cwd: '/work/two', status: 'feedback_pending' });
    expect(meta.writers.map((w) => w.sessionId)).toEqual([S1, S2]);
    expect(readJson(paths.outbox(m.id))).toHaveLength(1);
    expect(readJson(paths.outbox(m.id))[0].injectedAt).toBeUndefined();
    expect(getMeta(m.id).sessionId).toBe(S2);
  });

  it('accepts an explicitly named UUID (added to the writers) or a known session; refuses anything else', async () => {
    const m = await review();
    const meta = await rebindSession(m.id, S3, { cwd: '/work/three' });
    expect(meta).toMatchObject({ sessionId: S3, cwd: '/work/three' });
    expect(meta.writers.at(-1)).toMatchObject({ sessionId: S3, cwd: '/work/three', source: 'explicit', project: 'three' });
    await updateSession('legacy-id', { cwd: '/work/legacy' });
    expect((await rebindSession(m.id, 'legacy-id')).cwd).toBe('/work/legacy');
    await expect(rebindSession(m.id, 'who-knows')).rejects.toThrow(/invalid session id/);
    await expect(rebindSession(m.id, '../../x')).rejects.toThrow(/invalid session id/);
    await expect(rebindSession(m.id, undefined)).rejects.toThrow(/invalid session id/);
    await expect(rebindSession('doc-1', S2)).rejects.toThrow(/invalid review id/);
    expect(getMeta(m.id).sessionId).toBe('legacy-id');
  });

  it('refuses while Claude is answering; allowed again once answered; same session is a no-op', async () => {
    const m = await review();
    await addThread(m.id, { anchor, text: 'q', send: true });
    expect((await rebindSession(m.id, S1)).sessionId).toBe(S1);
    await takeUnreceived(m.id, { via: 'A' });
    await expect(rebindSession(m.id, S2)).rejects.toThrow(/Claude is answering/);
    expect(getMeta(m.id).sessionId).toBe(S1);
    await replyToThread(m.id, 't1', 'because');
    expect((await rebindSession(m.id, S2)).sessionId).toBe(S2);
  });

  it('only for unfinished document reviews', async () => {
    const plan = await createReview({ kind: 'plan', sessionId: S1, cwd: '/w', content, source: 'ExitPlanMode' });
    await expect(rebindSession(plan.id, S2)).rejects.toThrow(/only document reviews/);
    const m = await review();
    await approveReview(m.id);
    await expect(rebindSession(m.id, S2)).rejects.toThrow(/closed/);
  });

  it('a review registered by rd add can be rebound to a writer it listed', async () => {
    wrote(S1);
    wrote(S2);
    const r = await resolveDocument(doc, { pick: async (c) => c.find((x) => x.sessionId === S1) });
    expect((await rebindSession(r.id, S2)).sessionId).toBe(S2);
    expect(getMeta(r.id).cwd).toBe('/work/proj');
  });
});

describe('checkExternal / adoptExternal', () => {
  async function reviewOf(text = fs.readFileSync(doc, 'utf8')) {
    const m = await createReview({ kind: 'doc', docPath: doc, sessionId: S1, cwd: '/w', content: text, source: 'Write', turn: 1 });
    await setActiveReview(doc, m.id);
    return m;
  }

  it('same / changed / missing; only unfinished document reviews are checked', async () => {
    const m = await reviewOf();
    const same = checkExternal(m.id);
    expect(same).toMatchObject({ state: 'same' });
    expect(same.sha).toMatch(/^[0-9a-f]{40}$/);
    fs.appendFileSync(doc, 'edited by hand\n');
    const changed = checkExternal(m.id);
    expect(changed).toMatchObject({ state: 'changed' });
    expect(changed.sha).not.toBe(same.sha);
    expect(checkExternal(m.id).sha).toBe(changed.sha); // stable while the file does not change
    fs.rmSync(doc);
    expect(checkExternal(m.id)).toEqual({ state: 'missing' });
    fs.mkdirSync(doc); // a directory in its place
    expect(checkExternal(m.id)).toEqual({ state: 'missing' });
    fs.rmdirSync(doc);

    const plan = await createReview({ kind: 'plan', sessionId: S1, cwd: '/w', content: 'x', source: 'ExitPlanMode' });
    expect(checkExternal(plan.id)).toEqual({ state: 'same', skipped: true });
    await closeReview(m.id);
    expect(checkExternal(m.id)).toEqual({ state: 'same', skipped: true });
    expect(() => checkExternal('doc-1')).toThrow(/invalid review id/);
  });

  it('a file Claude wrote a moment ago is settling, not external; after 5 s it is', async () => {
    const m = await reviewOf();
    fs.appendFileSync(doc, 'claude is writing\n');
    recordWrite({ path: doc, sessionId: S1, cwd: '/w', tool: 'Edit' });
    const now = Date.now();
    expect(checkExternal(m.id, { now })).toMatchObject({ state: 'same', settling: true });
    expect(checkExternal(m.id, { now: now + EXTERNAL_SETTLE_MS - 500 })).toMatchObject({ state: 'same', settling: true });
    expect(checkExternal(m.id, { now: now + EXTERNAL_SETTLE_MS + 500 })).toMatchObject({ state: 'changed' });
    // the hook registers the write: now it is the same again
    await registerDocWrite({ docPath: doc, content: fs.readFileSync(doc, 'utf8'), sessionId: S1, cwd: '/w', tool: 'Edit', turn: 2, autoRegister: false });
    expect(checkExternal(m.id, { now: now + 60_000 })).toMatchObject({ state: 'same' });
    expect(checkExternal(m.id, { now: now + 60_000 }).settling).toBeUndefined();
  });

  it('lastWriteAt reads the tail of a large log and finds the newest write of the path', () => {
    recordWrite({ path: doc, sessionId: S1, cwd: '/w', tool: 'Write' });
    const other = path.join(root, 'other.md');
    for (let i = 0; i < 4000; i++) recordWrite({ path: other, sessionId: S1, cwd: '/w', tool: 'Write' });
    expect(fs.statSync(paths.writes()).size).toBeGreaterThan(256 * 1024);
    expect(lastWriteAt(doc)).toBeNull(); // older than the tail that is read
    expect(lastWriteAt(doc, { tailBytes: 8 * 1024 * 1024 })).toBeGreaterThan(0);
    expect(Date.now() - lastWriteAt(other)).toBeLessThan(10_000);
    expect(lastWriteAt(path.join(root, 'never.md'))).toBeNull();
  });

  it('too large / binary files are changed but flagged', async () => {
    const m = await reviewOf();
    fs.writeFileSync(doc, Buffer.alloc(MAX_DOC_BYTES + 1, 0x61));
    expect(checkExternal(m.id)).toEqual({ state: 'changed', tooLarge: true });
    await expect(adoptExternal(m.id)).rejects.toThrow(/larger than 2 MB/);
    fs.writeFileSync(doc, Buffer.from([0x61, 0x00, 0x62]));
    expect(checkExternal(m.id)).toMatchObject({ state: 'changed', binary: true });
    await expect(adoptExternal(m.id)).rejects.toThrow(/not a text file/);
    fs.rmSync(doc);
    await expect(adoptExternal(m.id)).rejects.toThrow(/file not found/);
  });

  it('adoptExternal: a new manual revision, threads re-anchored, status kept sensible; twice is a no-op', async () => {
    const m = await reviewOf();
    const first = fs.readFileSync(doc, 'utf8');
    await addThread(m.id, { anchor: makeAnchor(first, { startLine: 3, endLine: 3 }, 1), text: 'why low?', send: true });
    await takeUnreceived(m.id, { via: 'A' });
    await replyToThread(m.id, 't1', 'because');
    fs.writeFileSync(doc, '# Summary\n\nA new paragraph.\n\nRisk is low.\nTakes two weeks.\n');
    expect(checkExternal(m.id).state).toBe('changed');
    const r = await adoptExternal(m.id);
    expect(r).toEqual({ n: 2, changed: true, merged: false });
    const meta = getMeta(m.id);
    expect(meta.currentRevision).toBe(2);
    expect(meta.revisions[1]).toMatchObject({ n: 2, source: 'manual' });
    expect(readRevision(m.id, 2)).toBe(fs.readFileSync(doc, 'utf8'));
    expect(readRevision(m.id, 1)).toBe(first);
    expect(listThreads(m.id)[0].anchor).toMatchObject({ startLine: 5, revision: 2, orphaned: false }); // followed the text down
    expect(checkExternal(m.id).state).toBe('same');
    expect(await adoptExternal(m.id)).toMatchObject({ n: 2, changed: false });
    expect(getMeta(m.id).revisions).toHaveLength(2);
  });

  it('a later write by Claude never merges into a manual revision', async () => {
    const m = await reviewOf();
    fs.appendFileSync(doc, 'by hand\n');
    await adoptExternal(m.id);
    fs.appendFileSync(doc, 'by claude\n');
    // the session's turn counter happens to be 0, the same as the manual revision's
    const r = await registerDocWrite({ docPath: doc, content: fs.readFileSync(doc, 'utf8'), sessionId: S1, cwd: '/w', tool: 'Edit', turn: 0, autoRegister: false });
    expect(r).toMatchObject({ action: 'revision', n: 3, merged: false });
    expect(readRevision(m.id, 2)).toContain('by hand');
    expect(readRevision(m.id, 2)).not.toContain('by claude');
  });

  it('adoptExternal is refused for plans and finished reviews', async () => {
    const plan = await createReview({ kind: 'plan', sessionId: S1, cwd: '/w', content: 'x', source: 'ExitPlanMode' });
    await expect(adoptExternal(plan.id)).rejects.toThrow(/only document reviews/);
    const m = await reviewOf();
    await approveReview(m.id);
    await expect(adoptExternal(m.id)).rejects.toThrow(/closed/);
  });

  it('registerManualDoc ignores a stale docs-index entry', async () => {
    const m = await reviewOf();
    await closeReview(m.id);
    const idx = readJson(paths.docsIndex(), {});
    idx[doc] = m.id; // closed behind the index's back
    fs.writeFileSync(paths.docsIndex(), JSON.stringify(idx));
    const r = await registerManualDoc({ docPath: doc, content: 'x', sessionId: S1, cwd: '/w' });
    expect(r.action).toBe('created');
    expect(r.id).not.toBe(m.id);
  });
});
