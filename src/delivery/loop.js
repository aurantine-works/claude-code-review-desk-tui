// Pieces shared by the two polling processes that hand review feedback to a session: `rd await` (started by Claude as a
// background task, delivery/await.js) and `rd hook watch` (started by Claude Code itself, delivery/watch.js).
//
// Both register themselves in the session record under the sessions lock (`awaiting` / `watcher`: {pid, startTime, since, ...}),
// poll the session's outbox once per second, hand the entries over through takeUnreceived() (the lock makes that exclusive against
// every other channel) and clear their registration BEFORE they print anything.
import { getSession, updateSession } from '../store/sessions.js';
import { readProc } from '../store/proc.js';
import { takeUnreceived, unreceived } from '../store/outbox.js';
import { readJson } from '../store/io.js';
import { paths } from '../store/paths.js';
import { nowIso } from '../store/time.js';
import { logLine } from '../store/log.js';

export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** The review's meta + outbox (read without locking), whatever its status; null when it vanished or is unreadable. */
export function readReview(id) {
  try {
    const meta = readJson(paths.meta(id), null);
    return meta ? { meta, outbox: readJson(paths.outbox(id), []) } : null;
  } catch {
    return null;
  }
}

/**
 * Register this process as `sessions[sid][field]` unless another live process already holds it. The check-and-set runs inside
 * the sessions lock, so two starts cannot both win. `isAlive(session)` says whether the recorded holder is still running;
 * `extra` goes into the record next to {pid, startTime, since}. The claude pid is filled into the session record when it
 * has none (and the pid is trustworthy: not the `ppid` fallback).
 * @returns {Promise<boolean>} whether this process holds the registration now
 */
export async function claimSlot(sid, field, { isAlive, claude, extra = {} }) {
  let won = false;
  await updateSession(sid, (cur) => {
    if (cur[field] && cur[field].pid !== process.pid && isAlive(cur)) return {};
    won = true;
    return {
      [field]: { ...extra, since: nowIso(), pid: process.pid, startTime: readProc(process.pid)?.startTime ?? null },
      ...(cur.pid || claude.via === 'ppid' ? {} : { pid: claude.pid }),
    };
  });
  return won;
}

/** Clear `sessions[sid][field]` when it is still ours (never somebody else's record). Failures are logged, not thrown. */
export const clearSlot = (sid, field, scope) =>
  updateSession(sid, (cur) => (cur[field]?.pid === process.pid ? { [field]: undefined } : {})).catch((err) => logLine(scope, err));

/** The session record, or null when it is unreadable (a loop must keep running over a transient read problem). */
export function safeSession(sid) {
  try {
    return getSession(sid);
  } catch {
    return null;
  }
}

/**
 * Take the unreceived feedback of every review in `reviews` ([{meta, outbox}] as readSessionReviews gives them) that `skip(meta)`
 * does not exclude. Returns the snapshots takeUnreceived() made ([{meta, threads, entries}]); a review someone else delivered
 * first yields nothing.
 */
export async function takeReady(reviews, { via, skip = () => false }) {
  const items = [];
  for (const r of reviews) {
    if (skip(r.meta) || unreceived(r.outbox).length === 0) continue;
    const taken = await takeUnreceived(r.meta.id, { via });
    if (taken) items.push(taken);
  }
  return items;
}
