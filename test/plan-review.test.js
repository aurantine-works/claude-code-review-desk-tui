import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { createTranscript } from './helpers/transcript.js';
import { planReview } from '../src/hooks/plan-review.js';
import { dispatchHook } from '../src/hooks/index.js';
import { listMetas, getMeta, readRevision } from '../src/store/reviews.js';
import { addThread, addUserMessage, listThreads, pendingThreads, replyToThread, submitBatch } from '../src/store/threads.js';
import { approveReview, closeReview, markInReview } from '../src/store/lifecycle.js';
import { updateSession } from '../src/store/sessions.js';
import { makeAnchor } from '../src/anchor/index.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { denyMarker } from '../src/feedback/transcript.js';

const home = useTempHome();
const SID = 'sess-plan-1';
const PLAN = ['# Plan', '', 'Step one: migrate the store.', 'Step two: ship it.'].join('\n');
const toolInput = (plan = PLAN) => ({ plan, planFilePath: '/root/.claude/plans/x.md' });
const hookInput = (over = {}) => ({
  session_id: SID,
  cwd: '/work/p',
  transcript_path: path.join(home(), 'transcript.jsonl'),
  permission_mode: 'plan',
  hook_event_name: 'PermissionRequest',
  tool_name: 'ExitPlanMode',
  tool_input: toolInput(),
  ...over,
});
const FAST = { pollMs: 15, isClaudeAlive: () => true, recoverTimeoutMs: 300, recoverIntervalMs: 20 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
/** The plan review the hook registered (waits until it is waiting for the user). */
const planReviewOf = (sid = SID) =>
  waitFor(() => listMetas().find((m) => m.kind === 'plan' && m.sessionId === sid && m.hook && m.status !== 'delivered'));

const anchorOn = (content, line) => makeAnchor(content, { startLine: line, endLine: line }, 1);

describe('plan-review: approval', () => {
  it('registers revision 1, blocks, then returns allow with updatedInput and the bell', async () => {
    const input = hookInput();
    const run = planReview(input, FAST);
    const meta = await planReviewOf();
    expect(meta).toMatchObject({ kind: 'plan', status: 'awaiting_review', cwd: '/work/p', currentRevision: 1, title: 'Plan', docPath: null });
    expect(meta.hook.pid).toBe(process.pid);
    expect(readRevision(meta.id, 1)).toBe(PLAN);
    await sleep(60); // still blocked
    expect(getMeta(meta.id).status).toBe('awaiting_review');

    await approveReview(meta.id);
    const r = await run;
    expect(r.outcome).toBe('approved');
    expect(r.output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: input.tool_input },
      },
      terminalSequence: '\u0007',
    });
    expect(JSON.parse(JSON.stringify(r.output)).terminalSequence).toBe('\u0007');
    expect(getMeta(meta.id).hook).toBeUndefined();
  });

  it('works through the dispatcher and an approved review is not reused by the next plan', async () => {
    const run = dispatchHook('plan-review', hookInput(), FAST);
    const first = await planReviewOf();
    await approveReview(first.id);
    expect((await run).hookSpecificOutput.decision.behavior).toBe('allow');

    const run2 = planReview(hookInput({ tool_input: toolInput('# Another plan\nx') }), FAST);
    const second = await waitFor(() => listMetas().find((m) => m.id !== first.id && m.kind === 'plan' && m.hook));
    expect(second.id).not.toBe(first.id);
    await approveReview(second.id);
    await run2;
  });

  it('does not create two reviews for two different sessions', async () => {
    const a = planReview(hookInput({ session_id: 'sess-a' }), FAST);
    const b = planReview(hookInput({ session_id: 'sess-b' }), FAST);
    const [ma, mb] = await Promise.all([planReviewOf('sess-a'), planReviewOf('sess-b')]);
    expect(ma.id).not.toBe(mb.id);
    await approveReview(ma.id);
    await approveReview(mb.id);
    await Promise.all([a, b]);
  });
});

describe('plan-review: feedback round trip', () => {
  // Batch submit: all drafts go out in one round (instant mode would deliver the first comment alone).
  async function submitFeedback(id, items) {
    for (const [line, text] of items) await addThread(id, { anchor: anchorOn(PLAN, line), text });
    await submitBatch(id);
  }

  it('denies with the rendered feedback, marks delivered and clears the outbox', async () => {
    const run = planReview(hookInput(), FAST);
    const { id } = await planReviewOf();
    await markInReview(id);
    expect(getMeta(id).status).toBe('in_review');
    await submitFeedback(id, [[3, 'Why migrate first?'], [4, 'Can we skip shipping?']]);

    const r = await run;
    expect(r.outcome).toBe('feedback');
    const d = r.output.hookSpecificOutput.decision;
    expect(d.behavior).toBe('deny');
    expect(d.message).toContain(denyMarker(id, 1));
    expect(d.message).toContain('<rd-reply thread="<threadId>">');
    expect(d.message).toContain('## Thread t1 · lines 3-3');
    expect(d.message).toContain('**User:** Why migrate first?');
    expect(d.message).toContain('## Thread t2');
    expect(r.output.terminalSequence).toBe('\u0007');
    expect(r.output.hookSpecificOutput.hookEventName).toBe('PermissionRequest');

    const meta = getMeta(id);
    expect(meta.status).toBe('delivered');
    expect(meta.delivered).toMatchObject({ round: 1, threadIds: ['t1', 't2'] });
    expect(meta.hook).toBeUndefined();
    expect(readJson(paths.outbox(id))).toEqual([]);
  });

  it('round 2: recovers <rd-reply> answers from the transcript, notes the unanswered thread, adds a revision', async () => {
    const input = hookInput();
    const run1 = planReview(input, FAST);
    const { id } = await planReviewOf();
    await submitFeedback(id, [[3, 'Why migrate first?'], [4, 'Can we skip shipping?'], [2, 'Rename?']]);
    const deny = (await run1).output.hookSpecificOutput.decision.message;

    // What Claude Code wrote to the transcript during the deny round.
    const PLAN2 = ['# Plan', '', 'Step zero: back up.', 'Step one: migrate the store.', 'Step two: ship it.'].join('\n');
    const t = createTranscript(SID);
    t.user('make a plan');
    const exit1 = t.toolUse('ExitPlanMode', toolInput());
    t.toolResult(exit1, deny, { isError: true });
    t.assistantText('<rd-reply thread="t1">Migration comes first because everything depends on it.</rd-reply>\n<rd-reply thread="t2">Yes, shipping is a separate task; I removed it.</rd-reply>');
    t.toolUse('ExitPlanMode', toolInput(PLAN2));
    t.write(input.transcript_path);

    const run2 = planReview(hookInput({ tool_input: toolInput(PLAN2) }), FAST);
    // Replies are visible while the hook blocks for round 2.
    const meta2 = await waitFor(() => listMetas().find((m) => m.id === id && m.hook && m.currentRevision === 2));
    expect(meta2.status).toBe('awaiting_review');
    expect(meta2.delivered).toBeUndefined();
    expect(listMetas().filter((m) => m.kind === 'plan')).toHaveLength(1); // same review, not a new one
    const threads = listThreads(id);
    const byId = Object.fromEntries(threads.map((x) => [x.id, x]));
    expect(byId.t1.status).toBe('answered');
    expect(byId.t1.messages.map((m) => [m.author, m.text])).toEqual([
      ['user', 'Why migrate first?'],
      ['claude', 'Migration comes first because everything depends on it.'],
    ]);
    expect(byId.t2.messages[1]).toMatchObject({ author: 'claude' });
    expect(byId.t3.messages[1]).toMatchObject({ author: 'system', kind: 'unanswered', text: 'Claude did not answer this one separately' }) // fixed English: Claude sees it in resubmitted history, whatever the UI language;
    expect(pendingThreads(threads)).toEqual([]); // nothing is re-sent next round
    // Anchors followed the inserted line.
    expect(byId.t1.anchor).toMatchObject({ revision: 2, startLine: 4, orphaned: false });
    expect(readRevision(id, 2)).toBe(PLAN2);

    await approveReview(id);
    expect((await run2).outcome).toBe('approved');
  });

  it('round 2: answers recorded with `rd reply` are taken as they are: no transcript needed, no wait, no system note', async () => {
    const run1 = planReview(hookInput(), FAST);
    const { id } = await planReviewOf();
    await submitFeedback(id, [[3, 'Why migrate first?'], [4, 'Can we skip shipping?']]);
    expect((await run1).outcome).toBe('feedback');

    // Claude runs `rd reply` (Bash) for both threads before it calls ExitPlanMode again.
    const { reply } = await import('../src/cli/commands.js');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await reply(id, 't1', 'Everything depends on it.');
      await reply(id, 't2', 'Dropped.');
    } finally {
      out.mockRestore();
    }

    const PLAN2 = ['# Plan', '', 'Step one: migrate the store.'].join('\n');
    const started = Date.now();
    // There is no transcript file at all and the recovery window is long: nothing may wait for it.
    const run2 = planReview(hookInput({ tool_input: toolInput(PLAN2) }), { ...FAST, recoverTimeoutMs: 8000 });
    await waitFor(() => listMetas().find((m) => m.id === id && m.hook && m.currentRevision === 2));
    expect(Date.now() - started).toBeLessThan(2000);
    const threads = listThreads(id);
    expect(threads.map((t) => t.messages.map((m) => m.author))).toEqual([['user', 'claude'], ['user', 'claude']]);
    expect(threads.map((t) => t.status)).toEqual(['answered', 'answered']);
    expect(pendingThreads(threads)).toEqual([]);
    await approveReview(id);
    await run2;
  });

  it('round 2: threads left unanswered by `rd reply` still fall back to <rd-reply> blocks, then to the system note', async () => {
    const input = hookInput();
    const run1 = planReview(input, FAST);
    const { id } = await planReviewOf();
    await submitFeedback(id, [[3, 'one'], [4, 'two'], [2, 'three']]);
    const deny = (await run1).output.hookSpecificOutput.decision.message;

    await replyToThread(id, 't1', 'via rd reply', { round: 1 });
    const t = createTranscript(SID);
    t.toolResult(t.toolUse('ExitPlanMode', toolInput()), deny, { isError: true });
    t.assistantText('<rd-reply thread="t2">via text</rd-reply>');
    t.write(input.transcript_path);

    const run2 = planReview(input, FAST);
    await waitFor(() => getMeta(id).hook && pendingThreads(listThreads(id)).length === 0 && getMeta(id).status === 'awaiting_review');
    const msgs = Object.fromEntries(listThreads(id).map((x) => [x.id, x.messages.map((m) => [m.author, m.text])]));
    expect(msgs.t1).toEqual([['user', 'one'], ['claude', 'via rd reply']]);
    expect(msgs.t2).toEqual([['user', 'two'], ['claude', 'via text']]);
    expect(msgs.t3).toEqual([['user', 'three'], ['system', 'Claude did not answer this one separately']]);
    await approveReview(id);
    await run2;
  });

  it('an unchanged plan after a question-only round keeps one revision', async () => {
    const input = hookInput();
    const run1 = planReview(input, FAST);
    const { id } = await planReviewOf();
    await submitFeedback(id, [[3, 'just a question']]);
    const deny = (await run1).output.hookSpecificOutput.decision.message;
    const t = createTranscript(SID);
    t.toolResult(t.toolUse('ExitPlanMode', toolInput()), deny, { isError: true });
    t.assistantText('<rd-reply thread="t1">Answer.</rd-reply>');
    t.write(input.transcript_path);

    const run2 = planReview(input, FAST);
    await waitFor(() => getMeta(id).hook && listThreads(id)[0].status === 'answered');
    expect(getMeta(id)).toMatchObject({ currentRevision: 1, status: 'awaiting_review' });
    expect(getMeta(id).revisions).toHaveLength(1);
    await approveReview(id);
    await run2;
  });

  it('a follow-up sent while Claude was still answering stays pending and is denied right away', async () => {
    const input = hookInput();
    const run1 = planReview(input, FAST);
    const { id } = await planReviewOf();
    await submitFeedback(id, [[3, 'first question']]);
    const deny = (await run1).output.hookSpecificOutput.decision.message;
    // User keeps typing in the TUI after the deny: round 2, queued while the plan is "delivered".
    await addUserMessage(id, 't1', { text: 'and another thing', send: true });
    expect(getMeta(id)).toMatchObject({ status: 'feedback_pending', round: 2 });

    const t = createTranscript(SID);
    t.toolResult(t.toolUse('ExitPlanMode', toolInput()), deny, { isError: true });
    t.assistantText('<rd-reply thread="t1">Answer to the first.</rd-reply>');
    t.write(input.transcript_path);

    const r = await planReview(input, FAST);
    expect(r.outcome).toBe('feedback');
    const msgs = listThreads(id)[0].messages;
    expect(msgs.map((m) => [m.author, m.text, m.round])).toEqual([
      ['user', 'first question', 1],
      ['claude', 'Answer to the first.', 1],
      ['user', 'and another thing', 2],
    ]);
    // The second deny carries the whole thread with its history, and a fresh marker for round 2.
    expect(r.output.hookSpecificOutput.decision.message).toContain(denyMarker(id, 2));
    expect(r.output.hookSpecificOutput.decision.message).toContain('**Claude (round 1):** Answer to the first.');
    expect(getMeta(id).delivered.round).toBe(2);
  });

  it('feedback queued before the hook (re)started is delivered immediately', async () => {
    // Simulate: hook killed, user submits, Claude re-submits the same plan.
    const ac = new AbortController();
    const killed = planReview(hookInput({ session_id: 'sess-k' }), { ...FAST, signal: ac.signal });
    const k = await planReviewOf('sess-k');
    ac.abort();
    expect((await killed).outcome).toBe('aborted');
    await submitFeedback(k.id, [[3, 'pending feedback']]);
    expect(getMeta(k.id).status).toBe('feedback_pending');

    const r = await planReview(hookInput({ session_id: 'sess-k' }), FAST);
    expect(r.outcome).toBe('feedback');
    expect(r.output.hookSpecificOutput.decision.message).toContain('pending feedback');
    expect(listMetas().filter((m) => m.sessionId === 'sess-k')).toHaveLength(1);
  });

  it('tolerates a missing transcript: unanswered threads get the system note', async () => {
    const input = hookInput({ transcript_path: path.join(home(), 'does-not-exist.jsonl') });
    const run1 = planReview(input, FAST);
    const { id } = await planReviewOf();
    await submitFeedback(id, [[3, 'q']]);
    await run1;
    const run2 = planReview(input, FAST);
    await waitFor(() => getMeta(id).hook && listThreads(id)[0].messages.length === 2);
    expect(listThreads(id)[0].messages[1]).toMatchObject({ author: 'system' });
    await approveReview(id);
    await run2;
  });

  it('status=delivered without the bookkeeping record (set by hand) is still recovered', async () => {
    const input = hookInput();
    const run1 = planReview(input, FAST);
    const { id } = await planReviewOf();
    await submitFeedback(id, [[3, 'q']]);
    const deny = (await run1).output.hookSpecificOutput.decision.message;
    const { withReview } = await import('../src/store/reviews.js');
    await withReview(id, (ctx) => {
      delete ctx.meta.delivered;
    });
    const t = createTranscript(SID);
    t.toolResult(t.toolUse('ExitPlanMode', toolInput()), deny, { isError: true });
    t.assistantText('<rd-reply thread="t1">hand-set ok</rd-reply>');
    t.write(input.transcript_path);
    const run2 = planReview(input, FAST);
    await waitFor(() => getMeta(id).hook && listThreads(id)[0].messages.length === 2);
    expect(listThreads(id)[0].messages[1]).toMatchObject({ author: 'claude', text: 'hand-set ok' });
    await approveReview(id);
    await run2;
  });
});

describe('plan-review: ways out without a decision', () => {
  it('closing the review makes the hook exit silently (Claude Code shows its own dialog)', async () => {
    const run = planReview(hookInput(), FAST);
    const { id } = await planReviewOf();
    await closeReview(id);
    const r = await run;
    expect(r).toMatchObject({ outcome: 'closed', reviewId: id });
    expect(r.output).toBeUndefined();
  });

  it('abort (SIGTERM) leaves the review awaiting_review and clears the hook marker', async () => {
    const ac = new AbortController();
    const run = planReview(hookInput(), { ...FAST, signal: ac.signal });
    const { id } = await planReviewOf();
    ac.abort();
    const r = await run;
    expect(r.outcome).toBe('aborted');
    expect(getMeta(id)).toMatchObject({ status: 'awaiting_review' });
    expect(getMeta(id).hook).toBeUndefined();
  });

  it('an orphaned hook (claude died) exits and keeps the review', async () => {
    let alive = true;
    const run = planReview(hookInput(), { ...FAST, isClaudeAlive: () => alive });
    const { id } = await planReviewOf();
    alive = false;
    expect((await run).outcome).toBe('orphaned');
    expect(getMeta(id).status).toBe('awaiting_review');
  });

  it('a stale hook stands down when a newer hook process took over the review', async () => {
    const stale = planReview(hookInput(), FAST);
    const { id } = await planReviewOf();
    const { withReview } = await import('../src/store/reviews.js');
    await withReview(id, (ctx) => {
      ctx.meta.hook = { pid: process.pid + 100000, since: new Date().toISOString() }; // someone else
    });
    const r = await stale;
    expect(r.outcome).toBe('superseded');
    expect(r.output).toBeUndefined();
    expect(getMeta(id).hook.pid).toBe(process.pid + 100000); // the new owner's marker is untouched
  });

  it('a deleted review directory ends the hook', async () => {
    const run = planReview(hookInput(), FAST);
    const { id } = await planReviewOf();
    fs.rmSync(paths.reviewDir(id), { recursive: true });
    expect((await run).outcome).toBe('vanished');
  });

  it('skips malformed input without creating anything', async () => {
    for (const bad of [{}, { session_id: SID }, hookInput({ tool_input: {} }), hookInput({ tool_input: { plan: '  ' } }), hookInput({ session_id: '../x' })]) {
      expect((await planReview(bad, FAST)).outcome).toBe('skipped');
    }
    expect(listMetas()).toEqual([]);
  });

  it('errors are swallowed by the dispatcher (silent fallback to the native dialog)', async () => {
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(paths.reviewsDir(), 'a file where the reviews directory should be');
    const out = await dispatchHook('plan-review', hookInput(), FAST);
    expect(out).toBeUndefined();
    expect(fs.readFileSync(paths.log(), 'utf8')).toContain('hook plan-review');
  });
});

describe('plan-review: uses the session registry', () => {
  it('records the session turn on the revision', async () => {
    await updateSession(SID, { turn: 7 });
    const run = planReview(hookInput(), FAST);
    const { id } = await planReviewOf();
    expect(getMeta(id).revisions[0]).toMatchObject({ source: 'ExitPlanMode', turn: 7 });
    await approveReview(id);
    await run;
  });
});

// --- plan text sources, updatedInput, native dialog, bell, claude pid (spike findings) ----------

const APPROVED_TEXT = 'User has approved your plan. You can now start coding.\n\n## Approved Plan:\nPlan: print hello\n';
const REJECTED_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
const transcriptFile = () => path.join(home(), 'transcript.jsonl');
const NOBELL = { bell: false };

describe('plan-review: where the plan text comes from', () => {
  it('uses tool_input.plan and returns tool_input unchanged as updatedInput (extra keys kept)', async () => {
    const ti = { plan: PLAN, planFilePath: '/x/p.md', extra: { a: 1 } };
    const run = planReview(hookInput({ tool_input: ti }), { ...FAST, ...NOBELL });
    const { id } = await planReviewOf();
    await approveReview(id);
    expect((await run).output.hookSpecificOutput.decision.updatedInput).toEqual(ti);
  });

  it('falls back to the plan file when tool_input has only planFilePath; updatedInput gains the plan', async () => {
    const file = path.join(home(), 'plan-on-disk.md');
    fs.writeFileSync(file, PLAN);
    const ti = { planFilePath: file };
    const run = planReview(hookInput({ tool_input: ti }), { ...FAST, ...NOBELL });
    const meta = await planReviewOf();
    expect(readRevision(meta.id, 1)).toBe(PLAN);
    await approveReview(meta.id);
    const r = await run;
    expect(r.output.hookSpecificOutput.decision.updatedInput).toEqual({ planFilePath: file, plan: PLAN });
  });

  it('tool_input {} -> the newest ExitPlanMode tool_use in the transcript; updatedInput is {plan}', async () => {
    const t = createTranscript(SID);
    t.user('plan it');
    t.toolResult(t.toolUse('ExitPlanMode', { plan: '# Old round\nstale' }), REJECTED_TEXT, { isError: true });
    t.toolUse('ExitPlanMode', { plan: PLAN });
    t.write(transcriptFile());
    const run = planReview(hookInput({ tool_input: {} }), { ...FAST, ...NOBELL });
    const meta = await planReviewOf();
    expect(readRevision(meta.id, 1)).toBe(PLAN); // not the stale one
    await approveReview(meta.id);
    const r = await run;
    expect(r.output.hookSpecificOutput.decision.updatedInput).toEqual({ plan: PLAN });
  });

  it('an unreadable plan file falls through to the transcript', async () => {
    const t = createTranscript(SID);
    t.toolUse('ExitPlanMode', { plan: PLAN });
    t.write(transcriptFile());
    const run = planReview(hookInput({ tool_input: { planFilePath: path.join(home(), 'missing.md') } }), { ...FAST, ...NOBELL });
    const meta = await planReviewOf();
    expect(readRevision(meta.id, 1)).toBe(PLAN);
    await approveReview(meta.id);
    await run;
  });

  it('waits briefly for a lagging transcript', async () => {
    createTranscript(SID).user('plan it').write(transcriptFile());
    const late = createTranscript(SID);
    late.toolUse('ExitPlanMode', { plan: PLAN });
    setTimeout(() => late.append(transcriptFile()), 150);
    const run = planReview(hookInput({ tool_input: {} }), { ...FAST, ...NOBELL, planTimeoutMs: 3000 });
    const meta = await planReviewOf();
    expect(readRevision(meta.id, 1)).toBe(PLAN);
    await approveReview(meta.id);
    await run;
  });

  it('finds no plan anywhere -> exits silently, creates no review, logs why', async () => {
    createTranscript(SID).user('no plan here').write(transcriptFile());
    const r = await planReview(hookInput({ tool_input: {} }), { ...FAST, ...NOBELL, planTimeoutMs: 100 });
    expect(r).toEqual({ outcome: 'skipped' });
    expect(listMetas()).toEqual([]);
    expect(fs.readFileSync(paths.log(), 'utf8')).toMatch(/no plan text/);
    // no transcript at all must not stall for the retry window either
    const t0 = Date.now();
    expect((await planReview(hookInput({ tool_input: {}, transcript_path: undefined }), { ...FAST, ...NOBELL, planTimeoutMs: 5000 })).outcome).toBe('skipped');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('plan-review: the native dialog is answered instead of the review', () => {
  /** Start the hook with a transcript whose last ExitPlanMode tool_use is pending; returns helpers. */
  async function startWithPendingToolUse(extra = {}) {
    const t = createTranscript(SID);
    t.user('plan it');
    // an earlier deny round that is already resolved (must not confuse the watcher)
    t.toolResult(t.toolUse('ExitPlanMode', { plan: '# Earlier\nx' }), 'earlier deny', { isError: true });
    const toolUseId = t.toolUse('ExitPlanMode', { plan: PLAN });
    t.write(transcriptFile());
    const run = planReview(hookInput(), { ...FAST, ...NOBELL, ...extra });
    const meta = await planReviewOf();
    return { run, meta, toolUseId, append: (build) => { const l = createTranscript(SID); build(l); l.append(transcriptFile()); } };
  }

  it('native approval (tool_result) marks the review approved via native and exits silently', async () => {
    const { run, meta, toolUseId, append } = await startWithPendingToolUse();
    await sleep(60);
    expect(getMeta(meta.id).status).toBe('awaiting_review'); // nothing happened yet
    append((l) => {
      l.toolResult(toolUseId, APPROVED_TEXT);
      l.attachment({ type: 'plan_mode_exit', planFilePath: '/x/plan.md', planExists: true });
    });
    const r = await run;
    expect(r.outcome).toBe('native-approved');
    expect(r.output).toBeUndefined();
    expect(getMeta(meta.id)).toMatchObject({ status: 'approved', approvedVia: 'native' });
    expect(getMeta(meta.id).hook).toBeUndefined();
  });

  it('native rejection leaves the review and its threads untouched, clears the hook marker, exits silently', async () => {
    const { run, meta, toolUseId, append } = await startWithPendingToolUse();
    await addThread(meta.id, { anchor: anchorOn(PLAN, 3), text: 'a draft the user wrote' }); // draft, not sent
    append((l) => l.toolResult(toolUseId, REJECTED_TEXT, { isError: true }));
    const r = await run;
    expect(r.outcome).toBe('native-rejected');
    expect(r.output).toBeUndefined();
    const after = getMeta(meta.id);
    expect(after.status).toBe('awaiting_review');
    expect(after.approvedVia).toBeUndefined();
    expect(after.hook).toBeUndefined();
    expect(listThreads(meta.id)).toHaveLength(1);
  });

  it('a bare plan_mode_exit attachment after the hook started counts as native approval', async () => {
    const { run, meta, append } = await startWithPendingToolUse();
    append((l) => l.attachment({ type: 'plan_mode_exit', planFilePath: '/x/plan.md', planExists: true }));
    expect((await run).outcome).toBe('native-approved');
    expect(getMeta(meta.id)).toMatchObject({ status: 'approved', approvedVia: 'native' });
  });

  it('records from before the hook started (old plan_mode_exit, the resolved earlier round) do not trigger it', async () => {
    const t = createTranscript(SID);
    t.attachment({ type: 'plan_mode_exit', planFilePath: '/old.md', planExists: true });
    t.toolResult(t.toolUse('ExitPlanMode', { plan: '# Earlier' }), 'earlier', { isError: true });
    t.toolUse('ExitPlanMode', { plan: PLAN });
    t.write(transcriptFile());
    const ac = new AbortController();
    const run = planReview(hookInput(), { ...FAST, ...NOBELL, signal: ac.signal });
    const { id } = await planReviewOf();
    await sleep(120);
    expect(getMeta(id).status).toBe('awaiting_review');
    expect(getMeta(id).hook).toBeTruthy(); // still waiting
    ac.abort();
    expect((await run).outcome).toBe('aborted');
  });

  it('tool_use not yet in the transcript when the hook starts is adopted when it arrives', async () => {
    createTranscript(SID).user('plan it').write(transcriptFile()); // lagging: no ExitPlanMode record yet
    const run = planReview(hookInput(), { ...FAST, ...NOBELL });
    const { id } = await planReviewOf();
    const l = createTranscript(SID);
    const toolUseId = l.toolUse('ExitPlanMode', { plan: PLAN });
    l.append(transcriptFile());
    await sleep(60);
    const l2 = createTranscript(SID);
    l2.toolResult(toolUseId, REJECTED_TEXT, { isError: true });
    l2.append(transcriptFile());
    expect((await run).outcome).toBe('native-rejected');
    expect(getMeta(id).status).toBe('awaiting_review');
  });

  it('our own deny round does not look like a native answer (the hook already returned)', async () => {
    // Round 1 -> deny; the deny tool_result (is_error) is in the transcript when round 2 starts.
    const input = hookInput();
    const run1 = planReview(input, { ...FAST, ...NOBELL });
    const { id } = await planReviewOf();
    await addThread(id, { anchor: anchorOn(PLAN, 3), text: 'q', send: true });
    const deny = (await run1).output.hookSpecificOutput.decision.message;
    const t = createTranscript(SID);
    t.toolResult(t.toolUse('ExitPlanMode', toolInput()), deny, { isError: true });
    t.attachment({ type: 'hook_permission_decision', decision: 'deny', toolUseID: 'x', hookEvent: 'PermissionRequest' });
    t.assistantText('<rd-reply thread="t1">ok</rd-reply>');
    t.toolUse('ExitPlanMode', toolInput());
    t.write(input.transcript_path);
    const ac = new AbortController();
    const run2 = planReview(input, { ...FAST, ...NOBELL, signal: ac.signal });
    await waitFor(() => getMeta(id).hook);
    await sleep(120);
    expect(getMeta(id).hook).toBeTruthy(); // still blocking
    ac.abort();
    expect((await run2).outcome).toBe('aborted');
  });

  it('the TUI approval still wins when the transcript says nothing', async () => {
    const { run, meta } = await startWithPendingToolUse();
    await approveReview(meta.id);
    expect((await run).outcome).toBe('approved');
    expect(getMeta(meta.id).approvedVia).toBeUndefined();
  });
});

describe('plan-review: claude pid and bell', () => {
  it('rings claude once, after the review is registered, with the pid from findClaudeProcess', async () => {
    const calls = [];
    const claude = { pid: 4321, via: 'env', startTime: null };
    const run = planReview(hookInput(), {
      pollMs: 15,
      claude,
      isClaudeAlive: () => true,
      bell: true,
      ringBell: (pid) => calls.push([pid, getMeta(listMetas()[0].id).hook?.pid]),
    });
    const { id } = await planReviewOf();
    await sleep(60);
    expect(calls).toEqual([[4321, process.pid]]); // the review was already marked as waiting
    await approveReview(id);
    await run;
  });

  it('notify.bell=false in config.json (or bell:false) silences it; a pid that is only the parent shell never rings', async () => {
    fs.writeFileSync(path.join(home(), 'config.json'), JSON.stringify({ notify: { bell: false } }));
    const spy = [];
    const base = { pollMs: 15, isClaudeAlive: () => true, claude: { pid: 99, via: 'env', startTime: null }, ringBell: (p) => spy.push(p) };
    const a = planReview(hookInput({ session_id: 's-a' }), base);
    await planReviewOf('s-a');
    await approveReview((await planReviewOf('s-a')).id);
    await a;
    fs.rmSync(path.join(home(), 'config.json'));
    const b = planReview(hookInput({ session_id: 's-b' }), { ...base, claude: { pid: 99, via: 'ppid', startTime: null } });
    await approveReview((await planReviewOf('s-b')).id);
    await b;
    const c = planReview(hookInput({ session_id: 's-c' }), { ...base, bell: false });
    await approveReview((await planReviewOf('s-c')).id);
    await c;
    expect(spy).toEqual([]);
    // default config rings
    const d = planReview(hookInput({ session_id: 's-d' }), base);
    await approveReview((await planReviewOf('s-d')).id);
    await d;
    expect(spy).toEqual([99]);
  });

  it('CLAUDE_PID is used for liveness: the hook ends when that claude process dies', async () => {
    const { spawn } = await import('node:child_process');
    // A stand-in whose argv0 is "claude", like the real native binary.
    const fake = spawn('sleep', ['30'], { argv0: 'claude', stdio: 'ignore' });
    try {
      await waitFor(() => fs.existsSync(`/proc/${fake.pid}/cmdline`));
      const run = planReview(hookInput(), { pollMs: 20, bell: false, env: { CLAUDE_PID: String(fake.pid) } });
      const { id } = await planReviewOf();
      await sleep(100);
      expect(getMeta(id).hook).toBeTruthy(); // claude alive: still waiting
      fake.kill('SIGKILL');
      const r = await run;
      expect(r.outcome).toBe('orphaned');
      expect(getMeta(id).status).toBe('awaiting_review');
      expect(getMeta(id).hook).toBeUndefined();
    } finally {
      fake.kill('SIGKILL');
    }
  });
});

// --- M2: instant Q&A on plans ----------------------------------------------------------------------------------

describe('plan-review: approval while Claude waits in `rd await` (approvedPendingExit)', () => {
  /** A plan review that was approved while no hook was waiting. */
  async function approvedWithoutHook(plan = PLAN) {
    const { createReview } = await import('../src/store/reviews.js');
    const meta = await createReview({ kind: 'plan', sessionId: SID, cwd: '/work/p', content: plan, source: 'ExitPlanMode' });
    await approveReview(meta.id);
    expect(getMeta(meta.id).approvedPendingExit).toBe(true);
    return meta;
  }

  it('allows the re-submitted plan at once: same updatedInput rule as an approval, flag cleared, no new review', async () => {
    const meta = await approvedWithoutHook();
    const input = hookInput();
    const r = await planReview(input, FAST);
    expect(r.outcome).toBe('approved');
    expect(r.viaAwait).toBe(true);
    expect(r.reviewId).toBe(meta.id);
    expect(r.output).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: input.tool_input } },
    });
    expect(listMetas()).toHaveLength(1);
    expect(getMeta(meta.id).approvedPendingExit).toBeUndefined();
    expect(getMeta(meta.id).exitedAt).toBeTruthy();
    expect(getMeta(meta.id).hook).toBeUndefined();
    // single use: the same call again is a new plan review
    const again = planReview(hookInput(), FAST);
    const second = await waitFor(() => listMetas().find((m) => m.id !== meta.id && m.hook));
    await approveReview(second.id);
    expect((await again).outcome).toBe('approved');
  });

  it('fills in the approved plan when Claude calls ExitPlanMode with an empty tool_input', async () => {
    await approvedWithoutHook();
    const r = await planReview(hookInput({ tool_input: {} }), FAST);
    expect(r.output.hookSpecificOutput.decision).toEqual({ behavior: 'allow', updatedInput: { plan: PLAN } });
  });

  it('only lets the approved plan through: different text drops the stale approval and is reviewed as a new plan', async () => {
    const meta = await approvedWithoutHook();
    const run = planReview(hookInput({ tool_input: toolInput('# A different plan\nSomething else entirely') }), FAST);
    const second = await waitFor(() => listMetas().find((m) => m.id !== meta.id && m.hook));
    expect(readRevision(second.id, 1)).toContain('A different plan');
    expect(getMeta(meta.id).approvedPendingExit).toBeUndefined();
    await approveReview(second.id);
    expect((await run).outcome).toBe('approved');
    expect(fs.readFileSync(paths.log(), 'utf8')).toContain('differs from the approved revision');
  });

  it('ignores approvals of other sessions and approvals that a hook delivered itself', async () => {
    await updateSession('other-session', { cwd: '/x' });
    const { createReview } = await import('../src/store/reviews.js');
    const other = await createReview({ kind: 'plan', sessionId: 'other-session', cwd: '/x', content: PLAN, source: 'ExitPlanMode' });
    await approveReview(other.id);
    const run = planReview(hookInput(), FAST);
    const mine = await waitFor(() => listMetas().find((m) => m.sessionId === SID && m.hook));
    expect(mine.id).not.toBe(other.id);
    expect(getMeta(other.id).approvedPendingExit).toBe(true); // untouched
    await approveReview(mine.id);
    await run;
    expect(getMeta(mine.id).approvedPendingExit).toBeUndefined(); // the hook was alive: nothing left pending
  });
});

describe('plan-review: instant mode', () => {
  it('the deny message carries the instant Q&A loop (rd await --review, rd done, end-plan)', async () => {
    const run = planReview(hookInput(), FAST);
    const { id } = await planReviewOf();
    await addThread(id, { anchor: anchorOn(PLAN, 3), text: 'Why migrate first?', send: true }); // instant: one message, one deny
    const r = await run;
    const msg = r.output.hookSpecificOutput.decision.message;
    expect(msg).toContain(`rd reply ${id} <threadId>`);
    expect(msg).toContain(`rd await --review ${id}`);
    expect(msg).toContain('run_in_background: true');
    expect(msg).toContain('Read the "output file"');
    expect(msg).toContain('`end-plan`');
    expect(msg).toContain('simply call ExitPlanMode again with the unchanged plan'); // the safe fallback if Claude declines the loop
  });

  it('while the hook waits, an `rd await` of the session does not take the feedback; the hook does', async () => {
    const { runAwait } = await import('../src/delivery/await.js');
    const { DEFAULT_CONFIG } = await import('../src/config.js');
    const run = planReview(hookInput(), FAST);
    const { id } = await planReviewOf();
    const controller = new AbortController();
    const awaiting = runAwait(
      { session: SID, pollMs: 15 },
      { env: {}, signal: controller.signal, claude: { pid: process.pid, via: 'env', startTime: null }, isClaudeAlive: () => true, config: DEFAULT_CONFIG },
    );
    await sleep(50);
    await addThread(id, { anchor: anchorOn(PLAN, 3), text: 'question', send: true });
    const r = await run;
    expect(r.outcome).toBe('feedback'); // delivered by the hook's deny, not by the await
    await sleep(60);
    controller.abort();
    expect((await awaiting).result).toBe('aborted'); // it never had anything to print
    expect(readJson(paths.outbox(id))).toEqual([]);
  });
});
