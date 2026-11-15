// How the wake-up watcher changes the other channels: wording (`auto`), the wake-up turn, Stop, plan deny, rd await, planDelivery.
import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { dispatchHook } from '../src/hooks/index.js';
import { classifyPrompt } from '../src/hooks/prompt-submit.js';
import { runAwait } from '../src/delivery/await.js';
import { planReview } from '../src/hooks/plan-review.js';
import { planDelivery, deliver, injectWake, deliveryState } from '../src/delivery/index.js';
import { createReview, getMeta, listMetas } from '../src/store/reviews.js';
import { addThread } from '../src/store/threads.js';
import { getSession, updateSession } from '../src/store/sessions.js';
import { readJson } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';
import { makeAnchor } from '../src/anchor/index.js';
import { renderInstructions, renderInjection, renderAwaitOutput, renderSlashCommand, renderWatchOutput, renderResumeNotice, LEAD_A, LEAD_B, LEAD_AUTO, LEAD_WATCH } from '../src/feedback/instructions.js';
import { renderPlanDeny } from '../src/feedback/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { WATCH_MESSAGE, WATCH_SUMMARY } from '../src/cli/install.js';

useTempHome();
const SID = 'wi-session';
const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const deps = { findPid: () => process.pid, env: {} };
const content = ['# Report', '', 'Risk is low.', 'Takes two weeks.'].join('\n');
const anchor = (line) => makeAnchor(content, { startLine: line, endLine: line }, 1);
const mk = (over = {}) => createReview({ kind: 'doc', docPath: '/w/docs/a.md', sessionId: SID, cwd: '/w', content, source: 'Write', ...over });
const watcher = (pid = process.pid) => ({ since: ago(5), pid, startTime: null });
const DEAD_PID = 2 ** 22 + 4242;
const outbox = (id) => readJson(paths.outbox(id), []);
const meta = { id: 'doc-20261109-142301-a3f9', kind: 'doc', docPath: '/w/docs/a.md', currentRevision: 1, round: 1 };
const planMeta = { ...meta, id: 'plan-20261111-094819-87hw', kind: 'plan', docPath: null };
const threads = [{ id: 't1', status: 'open', anchor: { revision: 1, startLine: 3, endLine: 3, quote: 'Risk is low.', before: '', after: '' }, messages: [{ id: 'm1', author: 'user', text: 'why?', round: 1, state: 'sent' }] }];

describe('instructions: the watcher variant', () => {
  it('doc: same per-thread steps and rd done, but "end your turn" instead of the rd await loop', () => {
    const t = renderInstructions(meta, { auto: true });
    expect(t).toContain(`rd reply ${meta.id} <threadId> <<'EOF'\n      your answer\n      EOF`);
    expect(t).toContain(`rd done ${meta.id}`);
    expect(t).toContain('end your turn');
    expect(t).toContain('delivers the user\'s further comments to you automatically');
    expect(t).toContain('do NOT start `rd await`');
    expect(t).not.toContain('BACKGROUND');
    expect(t).not.toContain('run_in_background');
    expect(t).not.toContain('already-waiting');
  });

  it('plan: still `rd reply` first and the revise-or-not decision, no rd await, approval arrives by itself', () => {
    const t = renderInstructions(planMeta, { auto: true });
    expect(t).toContain('BEFORE calling ExitPlanMode');
    expect(t).toContain('call ExitPlanMode again with the full revised plan');
    expect(t).toContain('do NOT start `rd await`');
    expect(t).toContain('If the user approves the plan you will be told to call ExitPlanMode once more');
    expect(t).not.toContain('BACKGROUND');
    expect(t).not.toContain(`rd await --review ${planMeta.id}`);
  });

  it('the watcher variants ask for the plain command (auto mode refuses an `rd reply` with an `echo $?` appended); the fallback wording does not', () => {
    for (const m of [meta, planMeta]) {
      expect(renderInstructions(m, { auto: true })).toContain('single plain command with nothing added after it (no `echo $?`');
      expect(renderInstructions(m)).not.toContain('plain command');
    }
    expect(renderInstructions(meta, { auto: true })).toContain(`run \`rd done ${meta.id}\` on its own`);
  });

  it('without a watcher (auto false) the original wording, with the whole rd await loop, is unchanged', () => {
    for (const m of [meta, planMeta]) expect(renderInstructions(m, { auto: false })).toBe(renderInstructions(m));
    expect(renderInstructions(meta)).toContain('start `rd await` as a BACKGROUND');
    expect(renderInstructions(planMeta)).toContain(`rd await --review ${planMeta.id}`);
    expect(renderInstructions(meta, { headless: true, auto: true })).toBe(renderInstructions(meta, { headless: true })); // a headless run never has a watcher
  });

  it('channel A/B injections, the plan deny and the rd await output follow `auto`', () => {
    const items = [{ meta, threads }];
    expect(renderInjection(items, { lead: LEAD_A, auto: true })).toContain('do NOT start `rd await`');
    expect(renderInjection(items, { lead: LEAD_B, auto: true })).not.toContain('BACKGROUND');
    expect(renderInjection(items, { lead: LEAD_A })).toContain('BACKGROUND');
    expect(renderPlanDeny(planMeta, threads, { auto: true })).toContain('do NOT start `rd await`');
    expect(renderPlanDeny(planMeta, threads, { auto: true })).not.toContain(`rd await --review ${planMeta.id}`);
    expect(renderPlanDeny(planMeta, threads)).toContain(`rd await --review ${planMeta.id}`);
    expect(renderAwaitOutput('feedback', { items, auto: true })).toContain('do NOT start `rd await`');
    expect(renderAwaitOutput('feedback', { items })).toContain('start `rd await` as a BACKGROUND');
  });

  it('a /review-reply prompt (instructions come from the command) gets the notice that a watcher is running', () => {
    const lean = renderInjection([{ meta, threads }], { lead: LEAD_A, withInstructions: false, auto: true });
    expect(lean).toContain(LEAD_AUTO);
    expect(lean).not.toContain('How to handle');
    expect(renderInjection([{ meta, threads }], { lead: LEAD_A, withInstructions: false })).not.toContain(LEAD_AUTO);
    expect(LEAD_AUTO).toContain('do NOT start `rd await`');
  });

  it('the slash command stays static text with a conditional step 4 that names both situations', () => {
    const c = renderSlashCommand();
    expect(c).toContain('says that further comments are delivered to you automatically');
    expect(c).toContain('a Review Desk watcher is running');
    expect(c).toContain('start `rd await` as a BACKGROUND Bash task'); // the fallback is still there
    expect(c).toContain('non-interactive run');
    expect(c).toBe(renderSlashCommand());
  });

  it('the watcher message: lead that says "not an error", the comments, and for an approved plan the end-plan request', () => {
    const out = renderWatchOutput([{ meta, threads }], { approvedPlans: [planMeta] });
    expect(out.startsWith(LEAD_WATCH)).toBe(true);
    expect(LEAD_WATCH).toContain('this is not an error');
    expect(LEAD_WATCH).toContain('own Review Desk tool');
    expect(out).toContain('**User:** why?');
    expect(out).toContain(`The user approved your plan in Review Desk (${planMeta.id}). Call ExitPlanMode now with the plan you submitted, unchanged.`);
    const only = renderWatchOutput([], { approvedPlans: [planMeta] });
    expect(only).toContain('this is not an error');
    expect(only).not.toContain('How to handle');
  });

  it('the resume notice no longer promises that the feedback only comes with the next message', () => {
    const t = renderResumeNotice([{ id: meta.id, threads: 1 }]);
    expect(t).toContain('heads-up');
    expect(t).toContain('may send it by itself');
  });
});

describe('the wake-up turn (UserPromptSubmit)', () => {
  const WAKE = '<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": Review Desk: this is not an error.\n\n</system-reminder>';
  const WAKE_START = WAKE.replace('"Stop"', '"SessionStart:startup"');

  it('is recognised (also when armed by SessionStart, and with the rewakeSummary / rewakeMessage rd install sets); a real task notification and typed prompts are not', () => {
    expect(classifyPrompt(WAKE)).toBe('hook-wake');
    expect(classifyPrompt(WAKE_START)).toBe('hook-wake');
    // what the real Claude Code 2.1.325 delivered with the installed rewake texts
    const installed = `<task-notification>\n<summary>${WATCH_SUMMARY}</summary>\n</task-notification>\n<system-reminder>\n${WATCH_MESSAGE} Review Desk: this is not an error.\n\n</system-reminder>`;
    expect(classifyPrompt(installed)).toBe('hook-wake');
    expect(classifyPrompt('<task-notification>\n<task-id>b1</task-id>\n<output-file>/tmp/x</output-file>\n<status>completed</status>\n</task-notification>')).toBe('task-notification');
    expect(classifyPrompt('<task-notification>\n<task-id>b1</task-id>\n</task-notification>')).toBe('task-notification');
    expect(classifyPrompt('Stop hook feedback')).toBe('user');
    expect(classifyPrompt('/review-reply')).toBe('user');
  });

  it('updates busy state and the turn counter, attaches nothing (not even waiting feedback) and logs no error', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/w' }, deps);
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    const turn = getSession(SID).turn;
    const out = await dispatchHook('prompt-submit', { session_id: SID, prompt: WAKE }, deps);
    expect(out).toBeUndefined();
    expect(getSession(SID)).toMatchObject({ state: 'busy', lastPromptKind: 'hook-wake', turn: turn + 1 });
    expect(outbox(id)[0].receivedAt).toBeUndefined(); // the next watcher / Stop delivers it, nothing is attached twice
    const { default: fs } = await import('node:fs');
    const log = fs.existsSync(paths.log()) ? fs.readFileSync(paths.log(), 'utf8') : '';
    expect(log).not.toMatch(/ERROR/);
  });

  it('channel A says "no rd await" when a watcher is alive, with or without the instructions, and also for a bare /review-reply', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/w' }, deps);
    await updateSession(SID, { watcher: watcher() });
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    const plain = (await dispatchHook('prompt-submit', { session_id: SID, prompt: 'carry on' }, deps)).hookSpecificOutput.additionalContext;
    expect(plain).toContain('do NOT start `rd await`');
    expect(plain).not.toContain('BACKGROUND');

    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    const cmd = (await dispatchHook('prompt-submit', { session_id: SID, prompt: `/review-reply ${id}` }, deps)).hookSpecificOutput.additionalContext;
    expect(cmd).toContain(LEAD_AUTO);
    expect(cmd).not.toContain('How to handle');

    const bare = await dispatchHook('prompt-submit', { session_id: SID, prompt: '/review-reply' }, deps); // nothing waiting
    expect(bare.hookSpecificOutput.additionalContext).toBe(LEAD_AUTO);
    expect(await dispatchHook('prompt-submit', { session_id: SID, prompt: 'hello' }, deps)).toBeUndefined();

    // without a live watcher: the old wording, and no note for a bare command
    await updateSession(SID, { watcher: watcher(DEAD_PID) });
    expect(await dispatchHook('prompt-submit', { session_id: SID, prompt: '/review-reply' }, deps)).toBeUndefined();
    await addThread(id, { anchor: anchor(3), text: 'q3', send: true });
    expect((await dispatchHook('prompt-submit', { session_id: SID, prompt: 'x' }, deps)).hookSpecificOutput.additionalContext).toContain('BACKGROUND');
  });
});

describe('channel B (Stop) next to the watcher', () => {
  const stopInput = (over = {}) => ({ session_id: SID, stop_hook_active: false, background_tasks: [], ...over });

  it('injects as before (the take is exclusive with the watcher) but tells Claude to end its turn when a watcher is alive', async () => {
    await dispatchHook('session-start', { session_id: SID, cwd: '/w' }, deps);
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await updateSession(SID, { watcher: watcher() });
    const out = await dispatchHook('stop', stopInput(), deps);
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('**User:** q');
    expect(ctx).toContain('do NOT start `rd await`');
    expect(outbox(id)[0]).toMatchObject({ deliveredVia: 'B' });
    // the Stop of a wake-up turn is left alone: the watcher armed by this very Stop delivers what is left
    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    expect(await dispatchHook('stop', stopInput({ stop_hook_active: true }), deps)).toBeUndefined();
    expect(outbox(id).find((e) => e.messageId && !e.receivedAt)).toBeTruthy();
    // no watcher: the old text
    await updateSession(SID, { watcher: undefined });
    expect((await dispatchHook('stop', stopInput(), deps)).hookSpecificOutput.additionalContext).toContain('BACKGROUND');
  });
});

describe('session records', () => {
  it('SessionEnd clears the watcher record; SessionStart under a different claude pid clears a stale one', async () => {
    await updateSession(SID, { pid: 111, state: 'idle', watcher: watcher() });
    await dispatchHook('session-end', { session_id: SID, reason: 'clear' }, deps);
    expect(getSession(SID)).toMatchObject({ state: 'ended' });
    expect(getSession(SID).watcher).toBeUndefined();
    await updateSession(SID, { pid: 111, state: 'idle', watcher: watcher() });
    await dispatchHook('session-start', { session_id: SID, cwd: '/w', source: 'resume' }, { ...deps, findPid: () => 222 });
    expect(getSession(SID)).toMatchObject({ pid: 222, state: 'idle' });
    expect(getSession(SID).watcher).toBeUndefined();
  });
});

describe('plan deny and rd await mention the watcher only when it is alive', () => {
  it('rd await prints the "end your turn" wording when a watcher is alive', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await updateSession(SID, { watcher: watcher() });
    const fast = { env: {}, claude: { pid: process.pid, via: 'env', startTime: null }, isClaudeAlive: () => true, config: DEFAULT_CONFIG };
    const r = await runAwait({ session: SID, pollMs: 15 }, fast);
    expect(r.output).toContain('do NOT start `rd await`');
    expect(r.output).not.toContain('BACKGROUND');
    await addThread(id, { anchor: anchor(4), text: 'q2', send: true });
    await updateSession(SID, { watcher: undefined });
    expect((await runAwait({ session: SID, pollMs: 15 }, fast)).output).toContain('BACKGROUND');
  });

  it('the plan-review hook tells Claude to end its turn when a watcher is alive', async () => {
    const PLAN = ['# Plan', '', 'Step one: migrate the store.', 'Step two: ship it.'].join('\n');
    const deny = async (sid, withWatcher) => {
      await updateSession(sid, { cwd: '/w', pid: process.pid, state: 'idle', ...(withWatcher ? { watcher: watcher() } : {}) });
      const run = planReview({ session_id: sid, cwd: '/w', tool_input: { plan: PLAN } }, { pollMs: 15, isClaudeAlive: () => true, bell: false });
      let m;
      for (let i = 0; i < 300 && !m; i++) {
        m = listMetas().find((x) => x.kind === 'plan' && x.sessionId === sid && x.hook);
        if (!m) await new Promise((r) => setTimeout(r, 10));
      }
      await addThread(m.id, { anchor: makeAnchor(PLAN, { startLine: 3, endLine: 3 }, 1), text: 'why?', send: true });
      const r = await run;
      expect(r.outcome).toBe('feedback');
      return { id: m.id, message: r.output.hookSpecificOutput.decision.message };
    };
    const auto = await deny(SID, true);
    expect(auto.message).toContain('do NOT start `rd await`');
    expect(auto.message).not.toContain(`rd await --review ${auto.id}`);
    const old = await deny('wi-old', false);
    expect(old.message).toContain(`rd await --review ${old.id}`);
  });
});

describe('planDelivery / deliver / deliveryState with a watcher', () => {
  const config = DEFAULT_CONFIG;
  const TMUX = { kind: 'tmux', target: '%7' };
  async function session(over = {}) {
    return updateSession(SID, { cwd: '/w', pid: process.pid, state: 'idle', stateSince: ago(30), injector: { kind: 'none' }, ...over });
  }
  const plan1 = (id, over = {}) => planDelivery(id, { config, now: NOW, ...over });

  it('a live watcher means channel "watch" (idle or busy, with or without an injector); a dead record changes nothing', async () => {
    const { id } = await mk();
    await session({ watcher: watcher() });
    expect(plan1(id)).toMatchObject({ channel: 'watch', reason: 'watcher-alive', sessionState: 'idle' });
    await session({ state: 'busy', watcher: watcher() });
    expect(plan1(id)).toMatchObject({ channel: 'watch', sessionState: 'busy' });
    await session({ state: 'idle', injector: TMUX, watcher: watcher() });
    expect(plan1(id).channel).toBe('watch'); // not 'inject'
    await session({ watcher: watcher(DEAD_PID), injector: TMUX });
    expect(plan1(id).channel).toBe('inject');
    await session({ watcher: undefined, injector: { kind: 'none' } });
    expect(plan1(id).channel).toBe('A');
  });

  it('the hook and a live rd await still come first; ended sessions stay on channel C', async () => {
    const { id } = await mk();
    await session({ watcher: watcher(), awaiting: { reviewId: null, since: ago(5), pid: process.pid } });
    expect(plan1(id).channel).toBe('await');
    await session({ awaiting: undefined, state: 'ended' });
    expect(plan1(id)).toMatchObject({ channel: 'C', reason: 'session-ended' });
    await session({ state: 'idle', pid: DEAD_PID });
    expect(plan1(id)).toMatchObject({ channel: 'C', reason: 'process-gone' });
  });

  it('deliver() never types /review-reply while a watcher is alive', async () => {
    const { id } = await mk();
    await addThread(id, { anchor: anchor(3), text: 'q', send: true });
    await session({ injector: TMUX, watcher: watcher() });
    const adapter = { isAlive: vi.fn(async () => true), inject: vi.fn(async () => {}) };
    const base = { config, adapter, now: () => NOW, sleep: async () => {} };
    expect(await deliver(id, {}, base)).toMatchObject({ channel: 'watch', action: 'none' });
    expect(await deliver(id, { whenIdle: true }, base)).toMatchObject({ channel: 'watch', action: 'none' });
    expect(await injectWake(SID, { reviewId: id }, base)).toMatchObject({ ok: false, reason: 'watcher-alive' });
    expect(adapter.inject).not.toHaveBeenCalled();
    await session({ watcher: undefined, injector: TMUX });
    expect((await deliver(id, {}, base)).action).toBe('injected');
  });

  it('deliveryState reports the watcher record and whether it is alive', async () => {
    const { id } = await mk();
    await session({ watcher: watcher() });
    expect(deliveryState(id, { now: NOW }).watcher).toMatchObject({ alive: true, pid: process.pid });
    await session({ watcher: watcher(DEAD_PID) });
    expect(deliveryState(id, { now: NOW }).watcher).toMatchObject({ alive: false });
    await session({ watcher: undefined });
    expect(deliveryState(id, { now: NOW }).watcher).toBeNull();
    expect(getMeta(id).status).toBe('awaiting_review');
  });
});
