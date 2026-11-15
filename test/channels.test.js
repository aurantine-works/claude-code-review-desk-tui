// Delivery channels A (prompt-submit), B (Stop), the rd-await output injection, and document registration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { dispatchHook } from '../src/hooks/index.js';
import { hasAwaitTask, stopOutput, STOP_STYLE } from '../src/hooks/stop.js';
import { readAwaitOutput, isReviewReplyCommand } from '../src/hooks/prompt-submit.js';
import { matchesDocGlobs } from '../src/hooks/post-tool-use.js';
import { createReview, getMeta, listMetas } from '../src/store/reviews.js';
import { addThread, addUserMessage, listThreads } from '../src/store/threads.js';
import { getSession, updateSession } from '../src/store/sessions.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';
import { renderAwaitOutput, AWAIT_MARKER } from '../src/feedback/instructions.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const home = useTempHome();
const SID = 'chan-session';
const deps = { findPid: () => 4242, env: {} };
const content = ['# Report', '', 'Risk is low.', 'Takes two weeks.'].join('\n');
const anchor = (line) => makeAnchor(content, { startLine: line, endLine: line }, 1);
const outbox = (id) => readJson(paths.outbox(id), []);
const mk = (over = {}) => createReview({ kind: 'doc', docPath: '/w/docs/a.md', sessionId: SID, cwd: '/w', content, source: 'Write', turn: 1, ...over });
const start = () => dispatchHook('session-start', { session_id: SID, cwd: '/w' }, deps);

describe('channel A: prompt-submit', () => {
  it('attaches waiting feedback (instructions + rd show output) to a normal prompt and marks it received', async () => {
    await start();
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'why is the risk low?', send: true });
    const out = await dispatchHook('prompt-submit', { session_id: SID, prompt: 'carry on' }, deps);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain(`How to handle review ${id}`);
    expect(ctx).toContain(`rd reply ${id} <threadId> <<'EOF'`);
    expect(ctx).toContain('**User:** why is the risk low?');
    expect(ctx).toContain('> 3 | Risk is low.');
    expect(outbox(id)[0]).toMatchObject({ deliveredVia: 'A' });
    expect(outbox(id)[0].receivedAt).toBeTruthy();
    expect(getMeta(id).status).toBe('delivered');
    // delivered once only
    expect(await dispatchHook('prompt-submit', { session_id: SID, prompt: 'next' }, deps)).toBeUndefined();
  });

  it('a /review-reply prompt gets the feedback without repeating the instructions', async () => {
    await start();
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    const out = await dispatchHook('prompt-submit', { session_id: SID, prompt: `/review-reply ${id}` }, deps);
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('**User:** q');
    expect(ctx).not.toContain('How to handle review');
    expect(isReviewReplyCommand('/review-reply')).toBe(true);
    expect(isReviewReplyCommand('  /review-reply doc-x')).toBe(true);
    expect(isReviewReplyCommand('/review-replyx')).toBe(false);
    expect(isReviewReplyCommand('please /review-reply')).toBe(false);
  });

  it('delivers every waiting review of the session, not other sessions\' and not from background wake-ups', async () => {
    await start();
    const a = await mk();
    const b = await mk({ docPath: '/w/docs/b.md' });
    const foreign = await mk({ sessionId: 'someone-else', docPath: '/w/docs/c.md' });
    for (const r of [a, b, foreign]) await addThread(r.id, { anchor: anchor(3), text: `q for ${r.id}`, send: true });
    // a task-notification prompt never carries feedback (that is the await channel's business)
    const notif = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';
    expect(await dispatchHook('prompt-submit', { session_id: SID, prompt: notif }, deps)).toBeUndefined();
    expect(outbox(a.id)[0].receivedAt).toBeUndefined();
    const ctx = (await dispatchHook('prompt-submit', { session_id: SID, prompt: 'go' }, deps)).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(a.id);
    expect(ctx).toContain(b.id);
    expect(ctx).not.toContain(foreign.id);
    expect(outbox(foreign.id)[0].receivedAt).toBeUndefined();
  });

  it('plan reviews whose hook is waiting are left to the hook', async () => {
    await start();
    const p = await createReview({ kind: 'plan', sessionId: SID, cwd: '/w', content, source: 'ExitPlanMode' });
    const { withReview } = await import('../src/store/reviews.js');
    await withReview(p.id, (ctx) => {
      ctx.meta.hook = { pid: process.pid, since: 'now' };
    });
    await addThread(p.id, { anchor: anchor(3), text: 'q', send: true });
    expect(await dispatchHook('prompt-submit', { session_id: SID, prompt: 'x' }, deps)).toBeUndefined();
    expect(outbox(p.id)[0].receivedAt).toBeUndefined();
  });

  it('stays silent and logs when delivery fails (a broken review must not break the prompt)', async () => {
    await start();
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    fs.writeFileSync(paths.threads(id), '{ not json');
    expect(await dispatchHook('prompt-submit', { session_id: SID, prompt: 'x' }, deps)).toBeUndefined();
    expect(getSession(SID).state).toBe('busy');
  });
});

describe('rd await output injection on task notifications', () => {
  const notification = (file) => `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>t</tool-use-id>\n<output-file>${file}</output-file>\n<status>completed</status>\n</task-notification>`;
  const write = (name, text) => {
    const f = path.join(home(), name);
    fs.writeFileSync(f, text);
    return f;
  };

  it('injects the output file when it starts with the rd-await marker', async () => {
    await start();
    const text = `${renderAwaitOutput('end', { reason: 'the review was closed' })}[exited with code 0]\n`;
    const f = write('task1.output', text);
    const out = await dispatchHook('prompt-submit', { session_id: SID, prompt: notification(f) }, deps);
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain(AWAIT_MARKER);
    expect(ctx).toContain('The Review Desk session has ended');
    expect(getSession(SID)).toMatchObject({ lastPromptKind: 'task-notification', state: 'busy' });
  });

  it('never injects other files: wrong marker, relative path, directory, symlink, missing, huge', () => {
    const plain = write('plain.output', 'just some command output\n');
    expect(readAwaitOutput(notification(plain))).toBeNull();
    expect(readAwaitOutput(notification('relative/x.output'))).toBeNull();
    expect(readAwaitOutput(notification(home()))).toBeNull();
    expect(readAwaitOutput(notification(path.join(home(), 'missing')))).toBeNull();
    const real = write('real.output', `${AWAIT_MARKER}\nfeedback\n`);
    const link = path.join(home(), 'link.output');
    fs.symlinkSync(real, link);
    expect(readAwaitOutput(notification(link))).toBeNull(); // O_NOFOLLOW
    expect(readAwaitOutput(notification(real))).toContain('feedback');
    const big = write('big.output', `${AWAIT_MARKER}\n${'x'.repeat(200_000)}`);
    expect(Buffer.byteLength(readAwaitOutput(notification(big)))).toBeLessThanOrEqual(64 * 1024);
    expect(readAwaitOutput('<task-notification>no file</task-notification>')).toBeNull();
  });
});

describe('channel B: Stop hook', () => {
  const stopInput = (over = {}) => ({ session_id: SID, stop_hook_active: false, background_tasks: [], ...over });

  it('hands over the earliest waiting review at the end of the turn and keeps the session busy', async () => {
    await start();
    await dispatchHook('prompt-submit', { session_id: SID, prompt: 'work' }, deps);
    const a = await mk();
    const b = await mk({ docPath: '/w/docs/b.md' });
    await addThread(b.id, { anchor: anchor(3), text: 'b was first', send: true });
    await new Promise((r) => setTimeout(r, 5));
    await addThread(a.id, { anchor: anchor(3), text: 'a was second', send: true });

    const out = await dispatchHook('stop', stopInput(), deps);
    const text = STOP_STYLE === 'block' ? out.reason : out.hookSpecificOutput.additionalContext;
    expect(text).toContain(`How to handle review ${b.id}`);
    expect(text).toContain('b was first');
    expect(text).not.toContain('a was second'); // one review per Stop
    expect(outbox(b.id)[0]).toMatchObject({ deliveredVia: 'B' });
    expect(outbox(b.id)[0].injectedAt).toBeTruthy();
    expect(getSession(SID).state).toBe('busy'); // the turn continues

    // the continuation's own Stop (stop_hook_active) must not inject again, even though `a` still waits
    expect(await dispatchHook('stop', stopInput({ stop_hook_active: true }), deps)).toBeUndefined();
    expect(getSession(SID).state).toBe('idle');
    expect(outbox(a.id)[0].receivedAt).toBeUndefined();
    // a later normal Stop delivers the next one
    const next = await dispatchHook('stop', stopInput(), deps);
    expect(JSON.stringify(next)).toContain('a was second');
  });

  it('does not inject when a background `rd await` is running (task list or live awaiting record)', async () => {
    await start();
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    const task = { id: 'b1', type: 'shell', status: 'running', command: 'rd await', description: 'wait' };
    expect(await dispatchHook('stop', stopInput({ background_tasks: [task] }), deps)).toBeUndefined();
    await updateSession(SID, { awaiting: { reviewId: null, since: 'now', pid: process.pid } });
    expect(await dispatchHook('stop', stopInput(), deps)).toBeUndefined();
    expect(outbox(id)[0].receivedAt).toBeUndefined();
    await updateSession(SID, { awaiting: { reviewId: null, since: 'now', pid: 2 ** 22 + 12345 } }); // dead process
    expect(await dispatchHook('stop', stopInput(), deps)).toBeDefined();
  });

  it('is silent when nothing waits, and a message queued behind an earlier delivery is not injected twice', async () => {
    await start();
    expect(await dispatchHook('stop', stopInput(), deps)).toBeUndefined();
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    expect(await dispatchHook('stop', stopInput(), deps)).toBeDefined();
    expect(await dispatchHook('stop', stopInput(), deps)).toBeUndefined(); // already received
    await addUserMessage(id, 't1', { text: 'follow-up', send: true });
    expect(JSON.stringify(await dispatchHook('stop', stopInput(), deps))).toContain('follow-up');
  });

  it('hasAwaitTask recognises rd await shell tasks only', () => {
    const t = (command, over = {}) => ({ type: 'shell', status: 'running', command, ...over });
    expect(hasAwaitTask([t('rd await')])).toBe(true);
    expect(hasAwaitTask([t('rd await --review doc-20261109-142301-a3f9')])).toBe(true);
    expect(hasAwaitTask([t('node /x/bin/rd.js await')])).toBe(true);
    expect(hasAwaitTask([t('cd /p && rd await')])).toBe(true);
    expect(hasAwaitTask([t('rd awaiting')])).toBe(false);
    expect(hasAwaitTask([t('sleep 5 # rd await')])).toBe(true); // conservative: a mention counts
    expect(hasAwaitTask([t('rd show')])).toBe(false);
    expect(hasAwaitTask([{ type: 'subagent', status: 'running' }])).toBe(false);
    expect(hasAwaitTask([t('rd await', { status: 'completed' })])).toBe(false);
    expect(hasAwaitTask(undefined)).toBe(false);
    expect(hasAwaitTask([])).toBe(false);
  });

  it('can emit both output styles', () => {
    expect(stopOutput('x', 'block')).toEqual({ decision: 'block', reason: 'x' });
    expect(stopOutput('x', 'additionalContext')).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'x' } });
  });
});

describe('post-tool-use: document registration', () => {
  const cfgDeps = { ...deps, env: { CLAUDE_CONFIG_DIR: path.join('/nonexistent-claude') }, home: '/nonexistent-home' };
  let proj; // a project directory OUTSIDE rd's own home (writes inside RD_HOME are never registered)
  const projs = [];
  const project = () => (proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-proj-')), projs.push(proj), fs.realpathSync(proj));
  afterEach(() => projs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const write = (rel, text) => {
    const f = path.join(proj, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };
  const hook = (rel, over = {}) =>
    dispatchHook('post-tool-use', { session_id: SID, cwd: proj, tool_name: 'Write', tool_input: { file_path: rel }, ...over }, cfgDeps);

  it('registers a matching file for the session with the turn, then merges same-turn edits', async () => {
    proj = project();
    await start();
    await dispatchHook('prompt-submit', { session_id: SID, prompt: 'write a report' }, deps); // turn 1
    write('reports/week.md', '# Week\n\nfirst\n');
    await hook('reports/week.md');
    const [meta] = listMetas();
    expect(meta).toMatchObject({ kind: 'doc', sessionId: SID, cwd: proj, status: 'awaiting_review', title: 'Week' });
    expect(meta.docPath).toBe(fs.realpathSync(path.join(proj, 'reports/week.md')));
    expect(meta.revisions[0]).toMatchObject({ source: 'Write', turn: 1 });

    write('reports/week.md', '# Week\n\nsecond\n');
    await hook('reports/week.md', { tool_name: 'Edit' });
    expect(getMeta(meta.id).revisions).toHaveLength(1); // same turn: merged
    await dispatchHook('prompt-submit', { session_id: SID, prompt: 'more' }, deps); // turn 2
    write('reports/week.md', '# Week\n\nthird\n');
    await hook('reports/week.md', { tool_name: 'MultiEdit' });
    expect(getMeta(meta.id)).toMatchObject({ currentRevision: 2 });
    expect(listMetas()).toHaveLength(1);
  });

  it('ignores files outside the globs, excluded ones, plan files, rd\'s own state, files over 2 MB and missing files', async () => {
    proj = project();
    await start();
    write('src/code.js', 'x');
    write('notes.md', '# n');
    write('docs/README.md', '# readme'); // included by docs/**, excluded by README.md
    write('node_modules/pkg/docs/x.md', '# x');
    write('docs/big.md', '# big\n' + 'x'.repeat(2 * 1024 * 1024 + 10));
    for (const f of ['src/code.js', 'notes.md', 'docs/README.md', 'node_modules/pkg/docs/x.md', 'docs/big.md', 'docs/missing.md']) await hook(f);
    expect(listMetas()).toEqual([]);
    // everything was still recorded in writes.jsonl
    expect(fs.readFileSync(paths.writes(), 'utf8').trim().split('\n')).toHaveLength(6);
    expect(fs.readFileSync(paths.log(), 'utf8')).toContain('cannot read');
  });

  it('never registers rd\'s own files', async () => {
    proj = project();
    await start();
    fs.mkdirSync(path.join(home(), 'docs'), { recursive: true });
    fs.writeFileSync(path.join(home(), 'docs', 'x.md'), '# inside RD_HOME');
    await hook(path.join(home(), 'docs', 'x.md'));
    expect(listMetas()).toEqual([]);
  });

  it('subagent writes register to the main session; an already registered doc gets revisions whatever its path', async () => {
    proj = project();
    await start();
    write('docs/sub.md', '# Sub\n\nx\n');
    await hook('docs/sub.md', { agent_id: 'a479014fb00f3ed9b', agent_type: 'general-purpose' });
    const [meta] = listMetas();
    expect(meta.sessionId).toBe(SID);

    // a manually registered document outside the globs
    const outside = write('misc/free.txt', 'hello\nworld\n');
    const manual = await createReview({ kind: 'doc', docPath: fs.realpathSync(outside), sessionId: SID, cwd: proj, content: 'hello\nworld\n', source: 'manual' });
    const { setActiveReview } = await import('../src/store/docsIndex.js');
    await setActiveReview(outside, manual.id);
    await dispatchHook('prompt-submit', { session_id: SID, prompt: 'edit' }, deps);
    write('misc/free.txt', 'hello\nthere\n');
    await hook('misc/free.txt', { tool_name: 'Edit' });
    expect(getMeta(manual.id).currentRevision).toBe(2);
  });

  it('registers custom globs from the config (and the extension pre-filter does not hide them)', async () => {
    expect(await matchesDocGlobs('/p/notes/today.txt', { include: ['**/notes/**/*.txt'], exclude: [] })).toBe(true);
    expect(await matchesDocGlobs('/p/notes/today.md', { include: ['**/notes/**/*.txt'], exclude: [] })).toBe(false);
    expect(await matchesDocGlobs('/p/notes/today.md', { include: ['**/notes/**'], exclude: ['**/today.md'] })).toBe(false);
    expect(await matchesDocGlobs('/p/notes/today.md', { include: ['**/notes/**'], exclude: [] })).toBe(true);
    expect(await matchesDocGlobs('/p/a/b.MD', { include: ['**/*.md'], exclude: [] })).toBe(false); // globs are case sensitive
    expect(await matchesDocGlobs('/p/.hidden/docs/a.md', DEFAULT_CONFIG.docs)).toBe(true); // dot directories
    expect(await matchesDocGlobs('/p/x.md', { include: [], exclude: [] })).toBe(false);
    expect(await matchesDocGlobs('/p/x.md', undefined)).toBe(false);
  });
});
