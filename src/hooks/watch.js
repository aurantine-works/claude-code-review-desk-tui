// `rd hook watch`: the wake-up watcher. Registered on SessionStart and Stop with `asyncRewake: true` (rd install), so Claude Code
// runs it in the background and, when it exits with code 2, shows its stderr to Claude and WAKES the session even when it is idle
// (verified on Claude Code 2.1.325). That is how review comments reach an idle session with nothing typed in Claude.
//
// This file is the fast entry: it runs on EVERY Stop, and nearly always finds a live watcher for the session already and exits
// at once (one lock-free read of sessions.json, no further imports). The loop itself is delivery/watch.js.
import { isSessionId, getSession } from '../store/sessions.js';
import { watcherAlive } from '../store/proc.js';
import { isHeadlessEnv } from '../feedback/marker.js';
import { HookExit } from './result.js';

/** Does another live process already watch this session? */
export const watchedByOther = (session) => !!session?.watcher && session.watcher.pid !== process.pid && watcherAlive(session);

/** @returns {Promise<HookExit | undefined>} HookExit(2, text) only for a real delivery; anything else (also an error) is exit code 0 */
export default async function watch(input, deps = {}) {
  const sid = input?.session_id;
  // A headless run (`claude -p`, channel C [h]) ends with its turn and kills background hooks at teardown: nothing to arm.
  if (!isSessionId(sid) || isHeadlessEnv(deps.env ?? process.env)) return undefined;
  if (watchedByOther(getSession(sid))) return undefined;
  const { runWatch } = await import('../delivery/watch.js');
  const r = await runWatch(input, deps);
  return r.output ? new HookExit({ code: 2, stderr: r.output }) : undefined;
}
