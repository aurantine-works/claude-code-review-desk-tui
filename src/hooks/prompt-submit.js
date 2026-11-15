// UserPromptSubmit: the session is busy and a new turn started; this is also delivery channel A.
//
// The hook also fires for things the user never typed: background-task completions arrive as a
// `<task-notification>` prompt and subagent / cross-session hand-backs as `<agent-message …>`. Each of
// those is still a separate Claude turn, so `turn` (used to merge a turn's document writes into one
// revision) counts all of them; `lastPromptKind` records what started the turn.
//
// What the hook adds to the turn through `additionalContext`:
//  - kind 'user':              feedback the user queued for this session and nobody has received yet (channel A),
//                              with the /review-reply instructions unless the prompt is that command itself;
//  - kind 'task-notification': the output of a finished `rd await` background task. The notification only
//                              names an output file, and Claude does not reliably Read it;
//  - kind 'hook-wake':         the wake-up turn of an asyncRewake hook: the prompt is a
//                              `<task-notification>` that names no output file and carries the hook's stderr (for us, the
//                              watcher's message) in its system-reminder. Nothing is added: the text is already in
//                              the turn, and anything else waiting is the next watcher's business (it is armed by the
//                              Stop that ends this turn). The turn counter and the busy state are updated as for any prompt.
import fs from 'node:fs';
import { updateSession, isSessionId } from '../store/sessions.js';
import { findClaudePid, watcherAlive } from '../store/proc.js';
import { nowIso } from '../store/time.js';
import { logLine } from '../store/log.js';
import { AWAIT_MARKER, isHeadlessEnv } from '../feedback/marker.js';

/** 'user' | 'task-notification' | 'hook-wake' | 'agent-message' */
export function classifyPrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt.trimStart() : '';
  if (text.startsWith('<task-notification>') || text.startsWith('<task-notification ')) {
    // The wake-up of an asyncRewake hook: "<summary>…</summary>" and the hook's text in a <system-reminder>, but none of the
    // <task-id> / <output-file> a finished background task names (verified on 2.1.325; the summary and the prefix of the reminder
    // are what rewakeSummary / rewakeMessage set, "Stop hook feedback" and "Stop hook blocking error from command …" by default).
    const head = text.slice(0, 1200);
    return !head.includes('<output-file>') && !head.includes('<task-id>') && head.includes('<system-reminder>') ? 'hook-wake' : 'task-notification';
  }
  // Subagent hand-backs (`<agent-message from="…">`) and teammate / cross-session wrappers.
  if (/^<(agent-message|teammate-message|cross-session[\w-]*|peer-message)[\s>]/.test(text)) return 'agent-message';
  return 'user';
}

/** Is the prompt the /review-reply slash command (which already carries the instructions)? */
export const isReviewReplyCommand = (prompt) => typeof prompt === 'string' && /^\s*\/review-reply(\s|$)/.test(prompt);

const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * The text of a finished `rd await` task, or null. `prompt` is a `<task-notification>`; it names the
 * task's output file, which is only trusted (and read, at most 64 KB) when it starts with AWAIT_MARKER.
 */
export function readAwaitOutput(prompt) {
  const m = /<output-file>([^<\0]+)<\/output-file>/.exec(String(prompt));
  const file = m?.[1].trim();
  if (!file || !file.startsWith('/')) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_OUTPUT_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_OUTPUT_BYTES, 0);
    const text = buf.subarray(0, n).toString('utf8');
    return text.startsWith(AWAIT_MARKER) ? text : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Channel A: hand every review of the session its unreceived feedback. Returns the context text or null. */
async function channelA(sid, prompt, headless, auto) {
  const { reviewsWithUnreceived, takeUnreceived, planHookAlive } = await import('../store/outbox.js');
  const waiting = reviewsWithUnreceived(sid, { skip: planHookAlive });
  if (waiting.length === 0) return null;
  const items = [];
  for (const r of waiting) {
    const taken = await takeUnreceived(r.meta.id, { via: 'A' });
    if (taken) items.push(taken);
  }
  if (items.length === 0) return null;
  const { renderInjection, LEAD_A } = await import('../feedback/instructions.js');
  return renderInjection(items, { lead: LEAD_A, withInstructions: !isReviewReplyCommand(prompt), headless, auto });
}

export default async function promptSubmit(input, deps = {}) {
  const sid = input?.session_id;
  if (!isSessionId(sid)) return;
  const kind = classifyPrompt(input.prompt);
  const session = await updateSession(sid, (cur) => ({
    state: 'busy',
    stateSince: nowIso(),
    turn: (cur.turn ?? 0) + 1,
    lastPromptKind: kind,
    // Hooks installed mid-session never saw SessionStart: fill the record in.
    ...(cur.cwd ? {} : { cwd: input.cwd }),
    ...(cur.transcriptPath ? {} : { transcriptPath: input.transcript_path }),
    ...(cur.pid ? {} : { pid: (deps.findPid ?? findClaudePid)() }),
  }));

  let context = null;
  try {
    if (kind === 'task-notification') {
      const out = readAwaitOutput(input.prompt);
      if (out) {
        context = `Review Desk: output of the finished background \`rd await\` task (added here so you do not have to Read the output file):\n\n${out}`;
        logLine('hook prompt-submit', `injected rd await output (${out.length} chars)`);
      }
    } else if (kind === 'user') {
      const headless = isHeadlessEnv(deps.env ?? process.env);
      const auto = !headless && watcherAlive(session);
      context = await channelA(sid, input.prompt, headless, auto);
      if (context) logLine('hook prompt-submit', `delivered review feedback with the prompt (channel A, ${context.length} chars)`);
      // The command's step 4 is static text: with a watcher running, say that no `rd await` is needed even when nothing was waiting.
      else if (auto && isReviewReplyCommand(input.prompt)) context = (await import('../feedback/instructions.js')).LEAD_AUTO;
    }
  } catch (err) {
    logLine('hook prompt-submit', err); // never fail the prompt over a delivery problem
  }
  if (!context) return;
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
}
