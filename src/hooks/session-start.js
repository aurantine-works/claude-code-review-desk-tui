// SessionStart: register the session (id, cwd, transcript, claude pid, injector target).
//
// Also the "resume" half of delivery channel C: when a session starts (or is resumed with `claude --resume`) and
// review feedback is waiting for it that nobody has received yet, the hook announces that through
// `additionalContext`. It is only a heads-up (the feedback itself rides along with the user's next message,
// channel A); a headless run (`claude -p`, started by `rd` itself with the /review-reply prompt) gets no such notice.
import { updateSession, isSessionId } from '../store/sessions.js';
import { findClaudePid } from '../store/proc.js';
import { detectInjector } from './injector.js';
import { nowIso } from '../store/time.js';
import { logLine } from '../store/log.js';
import { isHeadlessEnv } from '../feedback/marker.js';

/** SessionStart sources that can carry old feedback: a resumed session, or a fresh one under an old id. */
const NOTICE_SOURCES = new Set(['resume', 'startup']);

/** The announcement text for the feedback waiting for `sid`, or null when there is none. */
export async function resumeNotice(sid) {
  const { reviewsWithUnreceived, planHookAlive } = await import('../store/outbox.js');
  const waiting = reviewsWithUnreceived(sid, { skip: planHookAlive });
  if (waiting.length === 0) return null;
  const { renderResumeNotice } = await import('../feedback/instructions.js');
  return renderResumeNotice(waiting.map((r) => ({ id: r.meta.id, threads: new Set(r.waiting.map((e) => e.threadId)).size })));
}

export default async function sessionStart(input, deps = {}) {
  const sid = input?.session_id;
  if (!isSessionId(sid)) return;
  const env = deps.env ?? process.env;
  const pid = (deps.findPid ?? findClaudePid)();
  // A headless run (`claude -p`, CLAUDE_CODE_SESSION_ATTENDED=0) inherits the env of the interactive claude that spawned it,
  // TMUX_PANE included, but has no terminal of its own to type into.
  const headless = isHeadlessEnv(env);
  const injector = headless ? { kind: 'none' } : (deps.detectInjector ?? detectInjector)(env, deps);
  await updateSession(sid, (cur) => ({
    cwd: input.cwd ?? cur.cwd,
    transcriptPath: input.transcript_path ?? cur.transcriptPath,
    pid,
    injector,
    state: 'idle',
    stateSince: nowIso(),
    turn: cur.turn ?? 0, // keep the counter across resume/clear/compact
    source: input.source,
    // `claude --resume <id> -p` keeps the session id of the interactive session: the record says which kind of run owns it
    // now (planDelivery keeps such a session on channel C; the next interactive start clears the flag).
    headless: headless ? true : undefined,
    // A resumed session was marked ended by its last SessionEnd; it is live again.
    endedAt: undefined,
    endReason: undefined,
    // A different claude process means any recorded `rd await` (and wake-up watcher) died with the old one.
    ...(cur.pid !== undefined && cur.pid !== pid ? { awaiting: undefined, watcher: undefined } : {}),
  }));

  if (headless || !NOTICE_SOURCES.has(input.source)) return;
  try {
    const text = await resumeNotice(sid);
    if (text) {
      logLine('hook session-start', `announced waiting review feedback (source ${input.source})`);
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
    }
  } catch (err) {
    logLine('hook session-start', err); // the session is registered; the notice is a courtesy
  }
}
