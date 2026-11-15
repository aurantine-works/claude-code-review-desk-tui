import { paths } from './paths.js';
import { readJson, writeJsonAtomic, withLock } from './io.js';
import { nowIso } from './time.js';

export const readSessions = () => readJson(paths.sessions(), {});
export const getSession = (sid) => readSessions()[sid] ?? null;

/**
 * Claude Code session ids are UUIDs; the registry only needs a safe object key. The first character must be alphanumeric: an id
 * is also passed to `claude --resume <id>` as an argv element, where a leading `-` would read as an option.
 */
export const isSessionId = (sid) => typeof sid === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sid) && sid !== '__proto__';

/**
 * Merge a patch into a session record (creating it if needed). `patch` may be
 * a function of the current record so read-modify-write stays inside the lock
 * (e.g. incrementing `turn`). Keys set to undefined are removed.
 */
export function updateSession(sid, patch) {
  if (!isSessionId(sid)) throw new Error(`invalid session id: ${JSON.stringify(sid)}`);
  return withLock(paths.sessions(), () => {
    const all = readJson(paths.sessions(), {});
    const at = nowIso();
    const cur = all[sid] ?? { sessionId: sid, startedAt: at, state: 'idle' };
    const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch), updatedAt: at };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    all[sid] = next;
    writeJsonAtomic(paths.sessions(), all);
    return next;
  });
}

export function removeSession(sid) {
  return withLock(paths.sessions(), () => {
    const all = readJson(paths.sessions(), {});
    delete all[sid];
    writeJsonAtomic(paths.sessions(), all);
  });
}

/** True if the registered claude process still exists. */
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
