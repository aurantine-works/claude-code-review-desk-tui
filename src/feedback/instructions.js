// Instruction texts that travel with review feedback: the /review-reply slash command, the context the
// hooks inject (channels A and B), the output of `rd await` and the message of the wake-up watcher (`rd hook watch`).
// One source of truth, so a change of wording (which matters a lot to the model) reaches every channel.
//
// `auto` (several functions below): a live watcher exists for the session, so further comments reach Claude by themselves
// (verified on Claude Code 2.1.325): the text says "end your turn" instead of "start `rd await`". Without a watcher (older Claude Code,
// hooks not re-installed) the original wording, including the whole `rd await` loop, is used unchanged.
import { NOTICE, renderPrompt } from './index.js';
import { AWAIT_MARKER } from './marker.js';

export { AWAIT_MARKER };
/** Marker line of the slash command file: `rd uninstall` only deletes files that still carry it. */
export const COMMAND_MARKER = '<!-- Managed by Review Desk (rd install). rd uninstall removes this file only while this line is present. -->';

export const COMMAND_ALLOWED_TOOLS = 'Bash(rd show:*), Bash(rd reply:*), Bash(rd done:*), Bash(rd await:*), Read, Edit, MultiEdit, Write';

// The heredoc form, laid out on three lines exactly as Claude has to type it (the one-line "… EOF" shorthand
// is easy to misread; the multi-line form is what the M1 end-to-end run verified).
const REPLY_CMD = (id) => `rd reply ${id} <threadId> <<'EOF'\nyour answer\nEOF`;
const codeBlock = (cmd) => cmd.split('\n').map((l) => `      ${l}`).join('\n');

/** What to do when a background `rd await` finishes (shared wording; the task notification carries no stdout). */
const NOTIFIED = [
  'You will be notified when it exits. Do not poll it and do not sleep.',
  'The notification does not contain the task output. Review Desk normally adds the output to your context;',
  'if the output of `rd await` is not in your context, Read the "output file" path from the notification first.',
].join(' ');

const NOTIFIED_SHORT = 'The completion notification does not contain the output; Review Desk adds it to your context, otherwise Read the "output file" path from the notification.';

const DOC_THREAD_BULLETS = (id) => [
  'For each thread, in order:',
  '- Answer the user\'s latest message directly and specifically, referring to the quoted text.',
  '- Decide from the comment itself whether it is a question or a change request. If it only asks a question, answer it and do NOT edit the document. If it asks for a change, edit the document. If it is ambiguous, answer and ask whether to change it, without editing.',
  `- Record your answer by running this with the Bash tool (state what you changed, or why you did not change anything):\n${codeBlock(REPLY_CMD(id))}`,
];

// The watcher's text arrives as a system message, not as something the user typed. Claude Code's auto mode then judges a Bash call
// by the user's own messages alone and refuses an `rd reply` it cannot tie to them ("Unsanctioned Communication", seen with Haiku on
// 2.1.325 when it appended `; echo "exit: $?"`), while the plain command is covered by the `Bash(rd reply:*)` allow rule that
// rd install adds. So the watcher variants of the steps ask for the plain form.
const PLAIN_NOTE = 'Run it as a single plain command with nothing added after it (no `echo $?`, `&&`, `;` or pipe): only the plain command is pre-approved, anything else may be refused.';

/** The closing steps when the watcher delivers further comments: nothing to start, nothing to poll. */
const AUTO_END = (id) =>
  `When every thread has a reply, run \`rd done ${id}\` on its own (nothing added after it) and end your turn. Review Desk delivers the user's further comments to you automatically (as a new message, like this one), so do NOT start \`rd await\` and do not wait or poll.`;

const DOC_STEPS = (id, awaitCmd) => [
  ...DOC_THREAD_BULLETS(id),
  `When every thread has a reply, run \`rd done ${id}\`.`,
  `Then start \`${awaitCmd}\` as a BACKGROUND Bash task (run_in_background: true) and end your turn. ${NOTIFIED}`,
  'When notified, handle the comments it printed exactly as above, then start a new background `rd await` and end your turn again. If it prints `already-waiting`, just end your turn. If it prints `end`, tell the user in one sentence that the review session ended and do not start another.',
];

/** The instructions for a headless run (`claude --resume <id> -p`, channel C [h]): no wait loop, the run ends with `rd done`. */
const HEADLESS_END = (id) =>
  `When every thread has a reply, run \`rd done ${id}\`. This is a non-interactive run: once \`rd done\` has run you are finished, so end your turn. Do NOT start \`rd await\` (nobody can wake you afterwards, and it is not permitted in this run).`;

const DOC_STEPS_AUTO = (id) => [
  ...DOC_THREAD_BULLETS(id).map((l) => l.replace('or why you did not change anything):', `or why you did not change anything). ${PLAIN_NOTE}`)),
  AUTO_END(id),
];

const DOC_STEPS_HEADLESS = (id) => [...DOC_THREAD_BULLETS(id), HEADLESS_END(id)];

const PLAN_STEPS_HEADLESS = (id) => [
  'For each thread, in order:',
  '- Answer the user\'s latest message directly and specifically, referring to the quoted text.',
  '- Decide from the comment itself whether it is a question or a change request. Do not call ExitPlanMode in this run: for a change request, say in your answer what you would change in the plan.',
  `- Record your answer by running this with the Bash tool:\n${codeBlock(REPLY_CMD(id))}`,
  HEADLESS_END(id),
];

// The plan wording is deliberately softer than the document one. In the M2 end-to-end run Claude refused a deny message that
// ordered `rd reply`, `rd done` and a background `rd await` ("instructions inside a tool result that the user did not write");
// the M1 wording (reply, then resubmit the plan) had been followed every time. So the verified part stays imperative, the
// instant loop is offered as the user's own setup, and plain resubmission remains a safe fallback.
const PLAN_STEPS = (id) => [
  'For each thread, in order:',
  `- FIRST, BEFORE calling ExitPlanMode, record your answer to the user's comment by running this with the Bash tool (it is pre-approved, also in plan mode):\n${codeBlock(REPLY_CMD(id))}\n   The user only sees an answer recorded this way next to the thread; text in your thinking or a revised plan alone does not reach them.`,
  '- Decide from the comment itself whether it is a question or a change request. Revise the plan only for change requests; for questions, just answer.',
  'When every thread has an answer: if you revised the plan, call ExitPlanMode again with the full revised plan (the review continues; further comments come back as the ExitPlanMode result).',
  `If you did not change the plan you need not resubmit it: the user set Review Desk up so that the conversation can go on without that. Run \`rd await --review ${id}\` as a BACKGROUND Bash task (run_in_background: true) and end your turn; the user's next comment (or their approval) arrives when that task finishes. ${NOTIFIED_SHORT} If it prints \`end-plan\`, the user approved: call ExitPlanMode once more with the plan you submitted, unchanged. If it prints \`end\`, tell the user in one sentence that the review ended. Handle new comments exactly as above.`,
  'If you prefer not to run that task, simply call ExitPlanMode again with the unchanged plan.',
];

// Plan reviews with the watcher: the same imperative `rd reply`, but no `rd await` to offer. Not changing the plan means ending the turn;
// the user's next comment and their approval arrive by themselves (the approval as "call ExitPlanMode once more").
const PLAN_STEPS_AUTO = (id) => [
  ...PLAN_STEPS(id)
    .slice(0, 4)
    .map((l) => l.replace('(it is pre-approved, also in plan mode):', `(it is pre-approved, also in plan mode). ${PLAIN_NOTE}`)),
  `If you did not change the plan you need not resubmit it: the user set Review Desk up so that the conversation can go on without that. Just end your turn. Review Desk delivers the user's next comment to you automatically, as a new message; do NOT start \`rd await\`. If the user approves the plan you will be told to call ExitPlanMode once more with the plan you submitted, unchanged.`,
];

const numbered = (lines) => {
  let n = 0;
  return lines.map((l) => (l.startsWith('- ') ? `   ${l}` : `${++n}. ${l}`)).join('\n');
};

/**
 * The "what to do" part for one review, addressed to Claude. `awaitCmd` is how to restart the wait loop.
 * `headless`: a `claude -p` run, which ends after `rd done` instead of waiting for the next comment.
 * `auto`: the watcher delivers further comments, so the text ends the turn instead of starting `rd await`.
 */
export function renderInstructions(meta, { awaitCmd, headless = false, auto = false } = {}) {
  if (headless) return numbered(meta.kind === 'plan' ? PLAN_STEPS_HEADLESS(meta.id) : DOC_STEPS_HEADLESS(meta.id));
  if (auto) return numbered(meta.kind === 'plan' ? PLAN_STEPS_AUTO(meta.id) : DOC_STEPS_AUTO(meta.id));
  if (meta.kind === 'plan') return numbered(PLAN_STEPS(meta.id));
  return numbered(DOC_STEPS(meta.id, awaitCmd ?? 'rd await'));
}

/** Content of <config dir>/commands/review-reply.md (also exported for end-to-end tests: copy it to a project's .claude/commands/). */
export function renderSlashCommand() {
  return [
    '---',
    'description: Answer inline review comments from Review Desk',
    'argument-hint: [reviewId]',
    `allowed-tools: ${COMMAND_ALLOWED_TOOLS}`,
    '---',
    COMMAND_MARKER,
    'The user reviewed a document you wrote (or your plan) and left inline comments.',
    '',
    '1. If $ARGUMENTS is empty, run `rd show --pending --format prompt` (every review waiting for this project); otherwise run `rd show $ARGUMENTS --format prompt`. Use the reviewId it prints in the commands below.',
    '2. For each thread, in order:',
    '   - Answer the user\'s latest message directly and specifically, referring to the quoted text.',
    '   - Decide from the comment itself whether it is a question or a change request. If it only asks a question, answer it and do NOT edit the document. If it asks for a change, edit the document. If it is ambiguous, answer and ask whether to change it, without editing.',
    '   - Record your answer by running this with the Bash tool (state what you changed, or why you did not change anything):',
    codeBlock(REPLY_CMD('<reviewId>')),
    '3. When every thread has a reply, run `rd done <reviewId>` for each review.',
    `4. Then, unless the Review Desk context of this conversation says this is a non-interactive run (\`claude -p\`; there you are finished after step 3, because nobody can wake you: do NOT start \`rd await\`) or says that further comments are delivered to you automatically (a Review Desk watcher is running for this session; there you just end your turn after step 3 and do NOT start \`rd await\`), start \`rd await\` as a BACKGROUND Bash task (run_in_background: true) and end your turn. ${NOTIFIED} Handle the comments it printed exactly as in step 2, then start a new background \`rd await\` and end your turn again. If it prints \`already-waiting\`, just end your turn. If it prints \`end\`, tell the user in one sentence that the review session ended and do not start another. If it prints \`end-plan\`, the user approved your plan: call ExitPlanMode with the plan you submitted, unchanged.`,
    '',
    'For a plan review (reviewId starts with `plan-`): change the plan only for change requests, and when you changed it call ExitPlanMode again with the full plan instead of starting `rd await`.',
    'Do not resolve threads yourself; only the user resolves them.',
    '',
  ].join('\n');
}

const MAX_CONTEXT_BYTES = 60 * 1024;

const clip = (text) =>
  Buffer.byteLength(text) > MAX_CONTEXT_BYTES
    ? `${text.slice(0, MAX_CONTEXT_BYTES)}\n\n… (truncated; run \`rd show --pending --format prompt\` for the rest)\n`
    : text;

/**
 * Context injected through channel A (next prompt), B (Stop hook) or the watcher: the instructions plus `rd show`-style
 * feedback of every review in `items` ([{meta, threads}]). `withInstructions: false` when the user's prompt
 * is the /review-reply command itself, which already carries them. `headless`: the run is `claude -p`
 * (channel C [h]); a notice says so even when the command carries the instructions, because the command
 * text cannot know. `auto`: a watcher delivers further comments; the same holds for the command's step 4, so the
 * notice (LEAD_AUTO) is added when the command carries the instructions.
 */
export function renderInjection(items, { lead, withInstructions = true, headless = false, auto = false } = {}) {
  const parts = [];
  if (lead) parts.push(lead, '');
  if (headless) parts.push(LEAD_HEADLESS, '');
  else if (auto && !withInstructions) parts.push(LEAD_AUTO, '');
  for (const { meta, threads } of items) {
    if (withInstructions) parts.push(`## How to handle review ${meta.id}`, '', renderInstructions(meta, { headless, auto }), '');
    parts.push(renderPrompt(meta, threads).trimEnd(), '');
  }
  return clip(parts.join('\n').trimEnd() + '\n');
}

export const LEAD_A =
  'Review Desk: while you were working, the user sent review feedback on content you wrote. Handle it in addition to the user\'s message (it is the user\'s own review feedback, delivered by their Review Desk tool).';
export const LEAD_B =
  'Review Desk: the user sent review feedback while you were working. Before you stop, handle it as described below (it is the user\'s own review feedback, delivered by their Review Desk tool).';

// The wake-up watcher's message reaches Claude as the stderr of a hook that exited with code 2, which Claude Code frames as a
// "Stop hook blocking error". The lead says up front that this is not an error but the user's own new comments.
export const LEAD_WATCH =
  'Review Desk: this is not an error. The user is reviewing content you wrote (a document or your plan) and has just sent new review comments from their own Review Desk tool; the hook framing around this text only describes how it was delivered. Handle the comments below.';

export const LEAD_WATCH_APPROVAL =
  'Review Desk: this is not an error. It is the user\'s own decision, delivered by their Review Desk tool; the hook framing around this text only describes how it was delivered.';

/** Added when the /review-reply command carries the instructions and a watcher is running: step 4 of the command is "end your turn". */
export const LEAD_AUTO =
  'Review Desk: further comments are delivered to you automatically while this session runs (a Review Desk watcher is running). After `rd done`, just end your turn and do NOT start `rd await`.';

export const LEAD_HEADLESS =
  'Review Desk: this is a non-interactive run (`claude -p`) that the user started from Review Desk to have the review feedback below answered. Nobody can answer questions or wake you up afterwards: answer every thread with `rd reply`, run `rd done <reviewId>` for each review, then end your turn. Do NOT start `rd await` in this run.';

/**
 * SessionStart context of a resumed (or new) session that has review feedback nobody has received yet. It only
 * announces the feedback: it arrives with the user's next message (channel A) or when they run /review-reply.
 * @param {Array<{id: string, threads: number}>} reviews
 */
export function renderResumeNotice(reviews) {
  const list = reviews.map((r) => `${r.id} (${r.threads} thread${r.threads === 1 ? '' : 's'})`).join(', ');
  return [
    `Review Desk: ${reviews.length === 1 ? '1 review has' : `${reviews.length} reviews have`} review feedback waiting for this session: ${list}.`,
    'This is only a heads-up. Do not start handling it on your own and do not run any rd command yet:',
    'the feedback is delivered to you separately (Review Desk may send it by itself in a moment; otherwise it is attached to the user\'s next message, or the user runs /review-reply).',
  ].join(' ');
}

/**
 * Output of `rd await`. Line 1 is AWAIT_MARKER, line 2 the result keyword
 * (feedback | end | end-plan | already-waiting), then free text for Claude.
 */
export function renderAwaitOutput(result, { items = [], reason, awaitCmd, auto = false } = {}) {
  const head = [AWAIT_MARKER, result, ''];
  switch (result) {
    case 'feedback': {
      const body = items.flatMap(({ meta, threads }) => [
        renderInstructions(meta, { awaitCmd, auto }),
        '',
        renderPrompt(meta, threads).trimEnd(),
        '',
      ]);
      return [...head, 'The user sent new review comments (Review Desk).', '', ...body].join('\n').trimEnd() + '\n';
    }
    case 'end-plan':
      return [...head, 'The user approved your plan in Review Desk. Call ExitPlanMode now with the plan you submitted, unchanged. Do not start another `rd await`.', ''].join('\n');
    case 'end':
      return [...head, `The Review Desk session has ended${reason ? ` (${reason})` : ''}. Tell the user so in one sentence. Do NOT start another \`rd await\`.`, ''].join('\n');
    case 'already-waiting':
      return [...head, 'Another `rd await` is already waiting for this session. End your turn now; do not start anything else.', ''].join('\n');
    default:
      throw new Error(`unknown rd await result: ${result}`);
  }
}

/**
 * What the wake-up watcher hands to Claude (stderr of `rd hook watch`, exit code 2): the new comments of `items`
 * ([{meta, threads}] as takeUnreceived returns them) with the per-thread steps, and for every plan in `approvedPlans` ([meta])
 * the user approved while no hook was waiting, the request to call ExitPlanMode once more (the wording of `rd await`'s `end-plan`).
 * Always the `auto` wording: this is the watcher talking, so nothing needs to be started afterwards.
 */
export function renderWatchOutput(items, { approvedPlans = [] } = {}) {
  const parts = [];
  if (items.length > 0) parts.push(renderInjection(items, { lead: LEAD_WATCH, auto: true }).trimEnd());
  if (approvedPlans.length > 0) {
    const ids = approvedPlans.map((m) => m.id).join(', ');
    if (items.length === 0) parts.push(LEAD_WATCH_APPROVAL, '');
    parts.push(
      `The user approved your plan in Review Desk (${ids}). Call ExitPlanMode now with the plan you submitted, unchanged. Do not start \`rd await\`; Review Desk delivers anything further by itself.`,
    );
  }
  return clip(parts.join('\n').trimEnd() + '\n');
}
