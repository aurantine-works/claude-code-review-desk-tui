import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scanTranscript, assistantTextSince, denyMarker, scanLastExitPlan, snapshotTranscript, findPendingExitPlan, TranscriptTail, ExitPlanWatcher,
} from '../src/feedback/transcript.js';
import { parseRdReplies, renderPlanDeny } from '../src/feedback/index.js';
import { createTranscript } from './helpers/transcript.js';

const ID = 'plan-20261111-101010-abcd';
const marker = denyMarker(ID, 1);
const deny = `The user reviewed your plan in Review Desk (review ${ID}, round 1) and did NOT approve it yet.\n\n## Thread t1`;

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-tr-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function planTranscript() {
  const t = createTranscript();
  t.user('make a plan');
  t.assistantText('Here is my plan.');
  const exit1 = t.toolUse('ExitPlanMode', { plan: '# Plan\nstep', planFilePath: '/x/plan.md' });
  t.toolResult(exit1, deny, { isError: true });
  return t;
}

describe('denyMarker', () => {
  it('matches the text renderPlanDeny emits', () => {
    const out = renderPlanDeny({ id: ID, round: 1 }, []);
    expect(out).toContain(denyMarker(ID, 1));
  });
});

describe('scanTranscript (real record shapes)', () => {
  it('returns assistant text after the deny tool_result, from type=assistant records only', () => {
    const t = planTranscript();
    t.assistantText('<rd-reply thread="t1">Because X.</rd-reply>');
    t.assistantText('Revised plan below.\n<rd-reply thread="t2">No change needed.</rd-reply>');
    t.toolUse('ExitPlanMode', { plan: '# Plan\nstep 2' });
    const r = scanTranscript(t.lines.join('\n'), marker);
    expect(r.found).toBe(true);
    // api-request-blob duplicates must not double the text
    expect(r.text.match(/Because X\./g)).toHaveLength(1);
    expect(parseRdReplies(r.text)).toEqual([
      { threadId: 't1', text: 'Because X.' },
      { threadId: 't2', text: 'No change needed.' },
    ]);
  });

  it('excludes text from before the marker, sidechain text and thinking blocks', () => {
    const t = planTranscript();
    t.sidechainText('<rd-reply thread="t1">from a subagent</rd-reply>');
    t.assistantBlocks([{ type: 'thinking', thinking: '<rd-reply thread="t1">secret thinking</rd-reply>', signature: 's' }]);
    t.assistantText('<rd-reply thread="t1">real answer</rd-reply>');
    const r = scanTranscript(t.lines.join('\n'), marker);
    expect(r.text).toContain('real answer');
    expect(r.text).not.toContain('subagent');
    expect(r.text).not.toContain('secret thinking');
    expect(r.text).not.toContain('Here is my plan.');
  });

  it('uses the LAST marker occurrence (several deny rounds)', () => {
    const t = planTranscript();
    t.assistantText('<rd-reply thread="t1">round one answer</rd-reply>');
    const e2 = t.toolUse('ExitPlanMode', { plan: 'p2' });
    t.toolResult(e2, deny); // the marker appears again (a repeated deny)
    t.assistantText('<rd-reply thread="t1">second answer</rd-reply>');
    const r = scanTranscript(t.lines.join('\n'), marker);
    expect(r.text).toContain('second answer');
    expect(r.text).not.toContain('round one answer');
  });

  it('finds the marker in a tool_result whose content is an array of text blocks', () => {
    const t = createTranscript();
    t.user('go');
    const id = t.toolUse('ExitPlanMode', { plan: 'p' });
    t.toolResult(id, [{ type: 'text', text: deny }], { isError: true });
    t.assistantText('answer text');
    expect(scanTranscript(t.lines.join('\n'), marker)).toEqual({ found: true, text: 'answer text' });
  });

  it('is not fooled by assistant text or api blobs that quote the marker', () => {
    const t = createTranscript();
    t.user('go');
    t.assistantText(`I will mention ${marker} in my own words`);
    const r = scanTranscript(t.lines.join('\n'), marker);
    expect(r.found).toBe(false);
  });

  it('tolerates torn and garbage lines', () => {
    const t = planTranscript();
    t.raw('{"type":"assistant","message":{"content":[{"type":"te');
    t.raw('not json at all');
    t.assistantText('ok');
    const r = scanTranscript(t.lines.join('\n') + '\n{"type":"assis', marker);
    expect(r).toEqual({ found: true, text: 'ok' });
  });

  it('reports found=false without the marker', () => {
    expect(scanTranscript(createTranscript().user('hi').lines.join('\n'), marker)).toEqual({ found: false, text: '' });
  });
});

describe('assistantTextSince', () => {
  it('reads the file', async () => {
    const t = planTranscript();
    t.assistantText('hello there');
    const f = t.write(path.join(dir, 's.jsonl'));
    expect(await assistantTextSince(f, marker)).toBe('hello there');
  });

  it('returns "" for a missing file after the timeout', async () => {
    const t0 = Date.now();
    expect(await assistantTextSince(path.join(dir, 'nope.jsonl'), marker, { timeoutMs: 150, intervalMs: 30 })).toBe('');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it('retries until a lagging transcript catches up', async () => {
    const t = planTranscript();
    const f = t.write(path.join(dir, 's.jsonl'));
    const late = createTranscript();
    setTimeout(() => {
      late.assistantText('<rd-reply thread="t1">late</rd-reply>');
      late.append(f);
    }, 120);
    const text = await assistantTextSince(f, marker, {
      timeoutMs: 2000,
      intervalMs: 30,
      ready: (r) => r.found && r.text.includes('</rd-reply>'),
    });
    expect(text).toContain('late');
  });
});

// --- ExitPlanMode tracking -------------------------------------------------------------------

const APPROVED = 'User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan:\nPlan: print hello\n';
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

describe('scanLastExitPlan', () => {
  it('finds the newest ExitPlanMode tool_use and its plan; api-request-blob copies (input {}) are ignored', () => {
    const t = createTranscript();
    t.user('go');
    const a = t.toolUse('ExitPlanMode', { plan: 'old plan' });
    t.toolResult(a, deny, { isError: true });
    const b = t.toolUse('ExitPlanMode', { plan: 'new plan' });
    t.raw(JSON.stringify({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'tool_use', id: b, name: 'ExitPlanMode', input: {} }] } }));
    expect(scanLastExitPlan(t.lines.join('\n'))).toEqual({ id: b, plan: 'new plan', resolved: false, error: false });
  });

  it('reports resolved / error from the matching tool_result only', () => {
    const t = createTranscript();
    const a = t.toolUse('ExitPlanMode', { plan: 'p' });
    const other = t.toolUse('Bash', { command: 'ls' });
    t.toolResult(other, 'x');
    expect(scanLastExitPlan(t.lines.join('\n')).resolved).toBe(false);
    t.toolResult(a, APPROVED);
    expect(scanLastExitPlan(t.lines.join('\n'))).toMatchObject({ resolved: true, error: false });
    const t2 = createTranscript();
    t2.toolResult(t2.toolUse('ExitPlanMode', {}), REJECTED, { isError: true });
    expect(scanLastExitPlan(t2.lines.join('\n'))).toEqual({ id: expect.any(String), plan: null, resolved: true, error: true });
  });

  it('is null without any ExitPlanMode call (and ignores sidechains)', () => {
    const t = createTranscript().user('hi');
    expect(scanLastExitPlan(t.lines.join('\n'))).toBeNull();
    t.raw(JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'x', name: 'ExitPlanMode', input: { plan: 'p' } }] } }));
    expect(scanLastExitPlan(t.lines.join('\n'))).toBeNull();
  });
});

describe('findPendingExitPlan', () => {
  it('snapshotTranscript returns the offset after the last complete line', () => {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":');
    const snap = snapshotTranscript(f);
    expect(snap.offset).toBe(16);
    expect(snap.raw).toBe('{"a":1}\n{"b":2}\n');
    expect(snapshotTranscript(path.join(dir, 'nope'))).toBeNull();
    expect(snapshotTranscript(undefined)).toBeNull();
  });

  it('ignores a resolved (earlier round) tool_use and waits for the new one when the transcript lags', async () => {
    const f = path.join(dir, 's.jsonl');
    const t = createTranscript();
    t.toolResult(t.toolUse('ExitPlanMode', { plan: 'round 1' }), deny, { isError: true });
    t.write(f);
    const late = createTranscript();
    const id = late.toolUse('ExitPlanMode', { plan: 'round 2' });
    setTimeout(() => late.append(f), 120);
    const r = await findPendingExitPlan(f, { timeoutMs: 2000, intervalMs: 30, needPlan: true });
    expect(r.pending).toMatchObject({ id, plan: 'round 2' });
    expect(r.offset).toBe(fs.statSync(f).size);
  });

  it('gives up after the timeout, and does not wait at all without a transcript path', async () => {
    const f = path.join(dir, 's.jsonl');
    createTranscript().user('x').write(f);
    const t0 = Date.now();
    const r = await findPendingExitPlan(f, { timeoutMs: 120, intervalMs: 30, needPlan: true });
    expect(r.pending).toBeNull();
    expect(r.offset).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    const t1 = Date.now();
    expect(await findPendingExitPlan(undefined, { timeoutMs: 2000 })).toEqual({ pending: null, offset: null });
    expect(Date.now() - t1).toBeLessThan(100);
  });
});

describe('TranscriptTail', () => {
  it('returns only appended complete records, keeps a torn line for the next poll, survives truncation', () => {
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, '{"n":1}\n');
    const tail = new TranscriptTail(f, fs.statSync(f).size);
    expect(tail.poll()).toEqual([]);
    fs.appendFileSync(f, '{"n":2}\n{"n":3');
    expect(tail.poll()).toEqual([{ n: 2 }]);
    fs.appendFileSync(f, '}\ngarbage\n{"n":4}\n');
    expect(tail.poll()).toEqual([{ n: 3 }, { n: 4 }]);
    fs.writeFileSync(f, '{"n":9}\n'); // rewritten and shorter: no replay of history
    expect(tail.poll()).toEqual([]);
    fs.appendFileSync(f, '{"n":10}\n');
    expect(tail.poll()).toEqual([{ n: 10 }]);
    fs.rmSync(f);
    expect(tail.poll()).toEqual([]); // missing file: quiet
    expect(new TranscriptTail(undefined, 0).poll()).toEqual([]);
  });
});

describe('ExitPlanWatcher (native dialog answered)', () => {
  const watch = (t, over = {}) => {
    const f = t.write(path.join(dir, 's.jsonl'));
    const id = scanLastExitPlan(t.lines.join('\n'))?.id ?? null;
    const w = new ExitPlanWatcher(f, { offset: fs.statSync(f).size, targetId: id, ...over });
    return { f, w, id };
  };
  const later = () => createTranscript();

  it('native approval: a non-error tool_result for the watched tool_use', () => {
    const t = createTranscript();
    t.user('go');
    t.toolUse('ExitPlanMode', { plan: 'p' });
    const { f, w, id } = watch(t);
    expect(w.check()).toBeNull();
    const l = later();
    l.toolResult(id, APPROVED);
    l.attachment({ type: 'plan_mode_exit', planFilePath: '/x/plan.md', planExists: true });
    l.append(f);
    expect(w.check()).toEqual({ kind: 'approved', via: 'tool_result', toolUseId: id });
  });

  it('native rejection: an is_error tool_result', () => {
    const t = createTranscript();
    t.toolUse('ExitPlanMode', { plan: 'p' });
    const { f, w, id } = watch(t);
    const l = later();
    l.toolResult(id, REJECTED, { isError: true });
    l.append(f);
    expect(w.check()).toEqual({ kind: 'rejected', via: 'tool_result', toolUseId: id });
  });

  it('a plan_mode_exit attachment alone counts as approval; one from before the watch started does not', () => {
    const t = createTranscript();
    t.attachment({ type: 'plan_mode_exit', planFilePath: '/old.md', planExists: true });
    t.toolUse('ExitPlanMode', { plan: 'p' });
    const { f, w } = watch(t);
    expect(w.check()).toBeNull();
    later().attachment({ type: 'plan_mode_exit', planFilePath: '/x.md', planExists: true }).append(f);
    expect(w.check()).toMatchObject({ kind: 'approved', via: 'plan_mode_exit' });
  });

  it('ignores results of other tool_uses, hook-decision attachments and unrelated records', () => {
    const t = createTranscript();
    t.toolUse('ExitPlanMode', { plan: 'p' });
    const { f, w } = watch(t);
    const l = later();
    const bash = l.toolUse('Bash', { command: 'ls' });
    l.toolResult(bash, 'file', {});
    l.toolResult('toolu_some_older_exit_plan', REJECTED, { isError: true }); // a stale round resolving late
    l.attachment({ type: 'hook_permission_decision', decision: 'deny', toolUseID: 'x', hookEvent: 'PermissionRequest' });
    l.assistantText('thinking out loud');
    l.append(f);
    expect(w.check()).toBeNull();
  });

  it('adopts a tool_use that only reaches the file after the watch started, and the newest one wins', () => {
    const t = createTranscript().user('go'); // lagging: our ExitPlanMode tool_use is not written yet
    const { f, w } = watch(t, { targetId: null });
    const l = later();
    const mine = l.toolUse('ExitPlanMode', { plan: 'p' });
    l.append(f);
    expect(w.check()).toBeNull();
    expect(w.targetId).toBe(mine);
    const l2 = later();
    l2.toolResult(mine, APPROVED);
    l2.append(f);
    expect(w.check()).toMatchObject({ kind: 'approved', toolUseId: mine });
  });

  it('a tool_use and its tool_result arriving in the same poll are matched in order', () => {
    const t = createTranscript().user('go');
    const { f, w } = watch(t, { targetId: null });
    const l = later();
    const id = l.toolUse('ExitPlanMode', { plan: 'p' });
    l.toolResult(id, REJECTED, { isError: true });
    l.append(f);
    expect(w.check()).toMatchObject({ kind: 'rejected', toolUseId: id });
  });

  it('is inert without a transcript offset', () => {
    expect(new ExitPlanWatcher(undefined, { offset: null }).check()).toBeNull();
  });
});
