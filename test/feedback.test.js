import { describe, it, expect } from 'vitest';
import { renderPrompt, renderPlanDeny, parseRdReplies, NOTICE } from '../src/feedback/index.js';
import { renderInstructions, renderInjection, renderAwaitOutput, renderSlashCommand, AWAIT_MARKER, COMMAND_MARKER, LEAD_A } from '../src/feedback/instructions.js';

const anchor = (o = {}) => ({ revision: 2, startLine: 14, endLine: 15, startCol: null, endCol: null, quote: 'Migrating the old store is low risk\nit only affects the device and policy slices', before: '', after: '', orphaned: false, ...o });
const meta = { id: 'doc-20261109-142301-a3f9', kind: 'doc', docPath: '/home/j/proj/reports/week-45.md', currentRevision: 2, round: 2 };
const u = (id, text, round, state = 'sent') => ({ id, author: 'user', text, round, state });

describe('renderPrompt', () => {
  it('renders header, quotes with line numbers, and only pending threads', () => {
    const threads = [
      { id: 't1', status: 'open', anchor: anchor(), messages: [u('m1', 'What makes the risk low?', 2)] },
      { id: 't2', status: 'resolved', anchor: anchor({ startLine: 20, endLine: 20, quote: 'x' }), messages: [u('m2', 'old', 1)] },
    ];
    const out = renderPrompt(meta, threads);
    expect(out).toContain('# Review feedback · doc-20261109-142301-a3f9 · round 2');
    expect(out).toContain('Document: /home/j/proj/reports/week-45.md (revision 2)');
    expect(out).toContain(NOTICE);
    expect(out).toContain('## Thread t1 · lines 14-15\n> 14 | Migrating the old store is low risk\n> 15 | it only affects the device and policy slices\n**User:** What makes the risk low?');
    expect(out).not.toContain('t2');
  });

  it('includes history with round labels for earlier rounds only', () => {
    const t = {
      id: 't3', status: 'open', anchor: anchor({ startLine: 40, endLine: 40, quote: 'Expected to take two weeks' }),
      messages: [u('m1', 'Does it include testing?', 1), { id: 'm2', author: 'claude', text: 'No, it does not', round: 1 }, u('m3', 'Then please change the schedule', 2), u('m4', 'draft!', 2, 'draft')],
    };
    const out = renderPrompt(meta, [t]);
    expect(out).toContain('## Thread t3 · lines 40-40 (previous discussion)');
    expect(out).toContain('**User (round 1):** Does it include testing?\n**Claude (round 1):** No, it does not\n**User:** Then please change the schedule');
    expect(out).not.toContain('draft!');
  });

  it('flags orphaned anchors and handles plans / empty input', () => {
    const t = { id: 't1', status: 'open', anchor: anchor({ orphaned: true }), messages: [u('m1', 'q', 2)] };
    expect(renderPrompt({ ...meta, kind: 'plan', docPath: null }, [t])).toMatch(/Plan \(revision 2\)[\s\S]*no longer exists/);
    expect(renderPrompt(meta, [])).toContain('(no open threads)');
  });
});

describe('renderPlanDeny', () => {
  it('asks for rd-reply blocks and embeds the threads', () => {
    const t = { id: 't1', status: 'open', anchor: anchor(), messages: [u('m1', 'why', 2)] };
    const out = renderPlanDeny({ ...meta, kind: 'plan' }, [t]);
    expect(out).toContain('did NOT approve');
    expect(out).toContain('<rd-reply thread="<threadId>">'); // the fallback
    expect(out).toContain('## Thread t1');
    expect(out).not.toContain('# Review feedback');
  });

  it('asks for `rd reply` (a Bash call) first, because Claude may answer in its thinking and the transcript lags', () => {
    const t = { id: 't1', status: 'open', anchor: anchor(), messages: [u('m1', 'why', 2)] };
    const out = renderPlanDeny({ ...meta, id: 'plan-20261111-094819-87hw', round: 2, kind: 'plan' }, [t]);
    expect(out).toContain("rd reply plan-20261111-094819-87hw <threadId> <<'EOF'");
    expect(out.indexOf('rd reply plan-')).toBeLessThan(out.indexOf('<rd-reply thread='));
    expect(out).toMatch(/BEFORE calling ExitPlanMode/);
  });
});

describe('parseRdReplies', () => {
  it('extracts multi-line replies, last one per thread wins, ignores bad ids', () => {
    const text = 'blah\n<rd-reply thread="t1">first</rd-reply>\ntext <rd-reply thread="t2">line a\nline b</rd-reply>\n<rd-reply thread="t1"> second </rd-reply><rd-reply thread="../x">no</rd-reply><rd-reply thread="t3">  </rd-reply>';
    expect(parseRdReplies(text)).toEqual([
      { threadId: 't1', text: 'second' },
      { threadId: 't2', text: 'line a\nline b' },
    ]);
  });
});

describe('instructions: slash command, injection, rd await output', () => {
  const pending = [{ id: 't1', status: 'open', anchor: anchor(), messages: [u('m1', 'why low?', 2)] }];
  const plan = { ...meta, id: 'plan-20261111-094819-87hw', kind: 'plan', docPath: null };

  it('the instructions for a doc review name the review id and the wait loop; for a plan they cover ExitPlanMode and end-plan', () => {
    const doc = renderInstructions(meta);
    expect(doc).toContain(`rd reply ${meta.id} <threadId> <<'EOF'\n      your answer\n      EOF`);
    expect(doc).toContain(`rd done ${meta.id}`);
    expect(doc).toContain('start `rd await` as a BACKGROUND');
    expect(doc).not.toContain('ExitPlanMode');
    expect(renderInstructions(meta, { awaitCmd: 'rd await --review x' })).toContain('start `rd await --review x`');
    const p = renderInstructions(plan);
    expect(p).toContain('call ExitPlanMode again with the full revised plan');
    expect(p).toContain(`rd await --review ${plan.id}`);
    expect(p).toContain('`end-plan`');
    expect(p).toContain('simply call ExitPlanMode again with the unchanged plan'); // fallback when the loop is declined
    expect(p).not.toContain('rd done'); // plan reviews do not depend on it (rd reply marks the review answered)
    expect(p).toContain('BEFORE calling ExitPlanMode');
  });

  it('renderInjection: lead, per-review instructions (optional), rd show output, notice once', () => {
    const items = [{ meta, threads: pending }, { meta: { ...meta, id: 'doc-20261109-142301-bbbb' }, threads: pending }];
    const full = renderInjection(items, { lead: LEAD_A });
    expect(full.startsWith(LEAD_A)).toBe(true);
    expect(full).toContain(`## How to handle review ${meta.id}`);
    expect(full).toContain('## How to handle review doc-20261109-142301-bbbb');
    expect(full).toContain('# Review feedback · doc-20261109-142301-bbbb · round 2');
    expect(full.split(NOTICE).length - 1).toBe(2); // once per review (in the rd show header), not once more at the end
    const lean = renderInjection(items, { withInstructions: false });
    expect(lean).not.toContain('How to handle');
    expect(lean).toContain('**User:** why low?');
  });

  it('renderInjection clips huge feedback', () => {
    const big = [{ id: 't1', status: 'open', anchor: anchor(), messages: [u('m1', 'x'.repeat(100_000), 2)] }];
    const out = renderInjection([{ meta, threads: big }]);
    expect(Buffer.byteLength(out)).toBeLessThan(62 * 1024);
    expect(out).toContain('truncated');
  });

  it('renderAwaitOutput: marker, keyword on line 2, then text; unknown results throw', () => {
    for (const result of ['feedback', 'end', 'end-plan', 'already-waiting']) {
      const out = renderAwaitOutput(result, { items: [{ meta, threads: pending }], reason: 'because' });
      expect(out.split('\n').slice(0, 2)).toEqual([AWAIT_MARKER, result]);
      expect(out.endsWith('\n')).toBe(true);
    }
    expect(AWAIT_MARKER).toBe('# rd-await v1');
    expect(renderAwaitOutput('feedback', { items: [{ meta, threads: pending }] })).toContain('**User:** why low?');
    expect(renderAwaitOutput('end', { reason: 'the review was closed' })).toContain('(the review was closed)');
    expect(renderAwaitOutput('end-plan')).toContain('ExitPlanMode');
    expect(() => renderAwaitOutput('maybe')).toThrow(/unknown rd await result/);
  });

  it('renderSlashCommand follows the documented text, plus the output-file hint', () => {
    const c = renderSlashCommand();
    expect(c).toContain('If $ARGUMENTS is empty, run `rd show --pending --format prompt`');
    expect(c).toContain('otherwise run `rd show $ARGUMENTS --format prompt`');
    expect(c).toContain('Do not resolve threads yourself; only the user resolves them.');
    expect(c).toContain('Read the "output file"');
    expect(c).toContain(COMMAND_MARKER);
    expect(c.endsWith('\n')).toBe(true);
  });
});
