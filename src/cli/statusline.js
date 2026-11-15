// `rd statusline`: one line for Claude Code's status bar. Must be fast (<50ms budget):
// only fs + paths are loaded, meta.json files are read without any locking.
import fs from 'node:fs';
import { paths } from '../store/paths.js';
import { readStdin } from '../hooks/stdin.js';
import { awaitingAlive, watcherAlive } from '../store/proc.js';
import { t } from '../i18n/index.js';

/** Read every meta.json under reviews/ (unreadable ones are skipped). */
export function readMetasLight() {
  let names;
  try {
    names = fs.readdirSync(paths.reviewsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(paths.meta(name), 'utf8')));
    } catch {
      /* partially created or foreign directory */
    }
  }
  return out;
}

/**
 * Summary line, e.g. `rd: 1 plan · 2 doc to review · 1 answered · 1 awaiting delivery · instant Q&A`; '' when nothing is waiting.
 * With a sessionId only that session's reviews are counted; without one, all of them.
 *  - to review: awaiting_review / in_review (the ball is in the user's court)
 *  - answered: answered (Claude replied, the user has not looked yet)
 *  - awaiting delivery: feedback_pending (sent by the user, Claude has not received it yet)
 *  - instant Q&A: `opts.awaiting` (a live background `rd await` of the session: Claude is waiting for comments)
 *  - auto-delivery: `opts.watching` (the session's wake-up watcher is alive: comments reach Claude by themselves), shown only while the
 *    session has an unfinished review and no `rd await` is shown (every session has a watcher; the mark means something only then)
 */
export function summarize(metas, sessionId, { awaiting = false, watching = false } = {}) {
  let plan = 0;
  let doc = 0;
  let answered = 0;
  let pending = 0;
  let open = 0;
  for (const m of metas) {
    if (sessionId && m.sessionId !== sessionId) continue;
    if (m.status !== 'approved' && m.status !== 'closed') open++;
    if (m.status === 'awaiting_review' || m.status === 'in_review') {
      if (m.kind === 'plan') plan++;
      else doc++;
    } else if (m.status === 'answered') {
      answered++;
    } else if (m.status === 'feedback_pending') {
      pending++;
    }
  }
  const parts = [];
  const waiting = [plan && `${plan} plan`, doc && `${doc} doc`].filter(Boolean);
  if (waiting.length) parts.push(t('statusline.toReview', { list: waiting.join(' · ') }));
  if (answered) parts.push(t('statusline.answered', { n: answered }));
  if (pending) parts.push(t('statusline.pending', { n: pending }));
  if (awaiting) parts.push(t('statusline.awaiting'));
  else if (watching && open > 0) parts.push(t('statusline.watching'));
  return parts.length ? `rd: ${parts.join(' · ')}` : '';
}

/** The session's record from sessions.json (read without locking); null when unknown or unreadable. */
export function sessionRecord(sessionId) {
  if (!sessionId) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.sessions(), 'utf8'))[sessionId] ?? null;
  } catch {
    return null;
  }
}

/** Does this session have a live `rd await`? Reads sessions.json without locking. */
export const sessionAwaiting = (sessionId) => awaitingAlive(sessionRecord(sessionId));

/** Does this session have a live wake-up watcher? */
export const sessionWatching = (sessionId) => watcherAlive(sessionRecord(sessionId));

/** Pull session_id out of the (possibly truncated) stdin JSON without trusting its shape. */
export function sessionIdFromStdin(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.session_id === 'string') return v.session_id;
  } catch {
    /* fall through to the tolerant match */
  }
  const m = /"session_id"\s*:\s*"([^"]+)"/.exec(raw);
  return m ? m[1] : null;
}

export async function runStatusline({ stdin = process.stdin, stdout = process.stdout, readTimeoutMs = 20 } = {}) {
  const raw = await readStdin({ stream: stdin, timeoutMs: readTimeoutMs });
  const sid = sessionIdFromStdin(raw);
  const rec = sessionRecord(sid);
  const line = summarize(readMetasLight(), sid, { awaiting: awaitingAlive(rec), watching: watcherAlive(rec) });
  if (line) await new Promise((resolve) => stdout.write(line + '\n', resolve));
}
