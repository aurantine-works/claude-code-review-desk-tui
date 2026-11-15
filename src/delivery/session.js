// Which Claude Code session does a process (an `rd await` / `rd show` run by Claude's Bash tool) belong to?
//
//  1. $CLAUDE_CODE_SESSION_ID, exported by Claude Code to hooks and the Bash tool; it follows /clear;
//  2. the claude process (CLAUDE_PID, or a /proc walk) looked up in the session registry by pid.
import { readSessions } from '../store/sessions.js';
import { claudeSessionIdFromEnv, findClaudeProcess } from '../store/proc.js';

/** Registered session of that claude pid: the live one (not ended) that registered last. */
export function sessionByPid(pid, sessions = readSessions()) {
  const hits = Object.values(sessions).filter((s) => s.pid === pid && s.state !== 'ended');
  hits.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return hits[0]?.sessionId ?? null;
}

/**
 * @param {object} [opts] env, sessions (registry, for tests), findProcess() (for tests)
 * @returns {{sessionId: string, via: 'env'|'pid'} | null}
 */
export function resolveSession({ env = process.env, sessions, findProcess = () => findClaudeProcess({ env }) } = {}) {
  const fromEnv = claudeSessionIdFromEnv(env);
  if (fromEnv) return { sessionId: fromEnv, via: 'env' };
  const reg = sessions ?? readSessions();
  const proc = findProcess();
  if (proc && proc.via !== 'ppid') {
    const sid = sessionByPid(proc.pid, reg);
    if (sid) return { sessionId: sid, via: 'pid' };
  }
  return null;
}
