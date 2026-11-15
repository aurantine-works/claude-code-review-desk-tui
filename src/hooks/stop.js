// Stop: the turn finished; this is also delivery channel B (feedback that arrived while Claude was busy).
//
// When the user sent review feedback for this session and nobody received it yet, it is handed to Claude
// right here so that the turn continues with it. Not done when
//  - `stop_hook_active` is true (this Stop already follows one hook continuation: never loop),
//  - a background `rd await` is alive (listed in `background_tasks`, or `awaiting` in the session record):
//    it delivers within a second and Claude is already in the instant Q&A loop,
//  - nothing is waiting. Only the earliest waiting review is injected per Stop; each entry is received once.
//
// Every Stop also arms the next wake-up watcher (`rd hook watch`, a second hook of the same event running in parallel with this one,
// delivery/watch.js). The two do not conflict: both hand feedback over through takeUnreceived(), so each entry is delivered once, by
// whoever is first. The Stop that ends a wake-up turn has `stop_hook_active: true` and is skipped here on purpose: whatever the user
// sent meanwhile is picked up by the watcher this very Stop arms (it delivers within a second, as a new wake-up).
// When a watcher is alive the injected text tells Claude to end its turn instead of starting `rd await`.
import { updateSession, isSessionId, getSession } from '../store/sessions.js';
import { findClaudePid, awaitingAlive, watcherAlive } from '../store/proc.js';
import { nowIso } from '../store/time.js';
import { logLine } from '../store/log.js';
import { isHeadlessEnv } from '../feedback/marker.js';

/**
 * How the injection reaches Claude. Verified at runtime on Claude Code 2.1.322:
 * `hookSpecificOutput.additionalContext` on Stop makes Claude continue the turn and act on the text, so the
 * original design's `decision: 'block'` is not needed (it stays available as the other style, selectable with
 * the RD_STOP_STYLE environment variable).
 * @type {'block' | 'additionalContext'}
 */
export const STOP_STYLE = 'additionalContext';

const AWAIT_CMD_RE = /(^|[\s/;&|(])rd(\.js)?\s+await(\s|$)/;

/** Does `background_tasks` (Stop input) contain a running `rd await` shell task? */
export function hasAwaitTask(tasks) {
  return (
    Array.isArray(tasks) &&
    tasks.some((t) => t && t.type === 'shell' && (t.status === undefined || t.status === 'running') && typeof t.command === 'string' && AWAIT_CMD_RE.test(t.command))
  );
}

async function injection(sid, headless, auto) {
  const { reviewsWithUnreceived, takeUnreceived, planHookAlive } = await import('../store/outbox.js');
  const first = reviewsWithUnreceived(sid, { skip: planHookAlive })[0];
  if (!first) return null;
  const taken = await takeUnreceived(first.meta.id, { via: 'B', injected: true });
  if (!taken) return null;
  const { renderInjection, LEAD_B } = await import('../feedback/instructions.js');
  return renderInjection([taken], { lead: LEAD_B, headless, auto });
}

export function stopOutput(text, style = STOP_STYLE) {
  return style === 'additionalContext'
    ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } }
    : { decision: 'block', reason: text };
}

export default async function stop(input, deps = {}) {
  const sid = input?.session_id;
  if (!isSessionId(sid)) return;

  let text = null;
  try {
    const session = getSession(sid);
    const skip = input.stop_hook_active === true || hasAwaitTask(input.background_tasks) || awaitingAlive(session);
    if (!skip) text = await injection(sid, isHeadlessEnv(deps.env ?? process.env), watcherAlive(session));
  } catch (err) {
    logLine('hook stop', err); // never fail the turn over a delivery problem
  }

  await updateSession(sid, (cur) => ({
    // An injection continues the turn, so the session is not idle.
    state: text ? 'busy' : 'idle',
    stateSince: nowIso(),
    ...(cur.cwd ? {} : { cwd: input.cwd }),
    ...(cur.transcriptPath ? {} : { transcriptPath: input.transcript_path }),
    ...(cur.pid ? {} : { pid: (deps.findPid ?? findClaudePid)() }),
  }));
  if (!text) return undefined;
  // RD_STOP_STYLE: escape hatch for experiments with another Claude Code version (see STOP_STYLE).
  const style = deps.stopStyle ?? (['block', 'additionalContext'].includes(process.env.RD_STOP_STYLE) ? process.env.RD_STOP_STYLE : STOP_STYLE);
  logLine('hook stop', `injected review feedback (${text.length} chars, style ${style})`);
  return stopOutput(text, style);
}
