// SessionEnd: Claude Code gives this hook ~1.5s, so do exactly one locked write
// and give up quietly if the lock is not obtained in time.
import { updateSession, isSessionId } from '../store/sessions.js';
import { nowIso } from '../store/time.js';

const BUDGET_MS = 1200;

export default async function sessionEnd(input, deps = {}) {
  const sid = input?.session_id;
  if (!isSessionId(sid)) return;
  const budget = deps.budgetMs ?? BUDGET_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('session-end: lock budget exceeded')), budget);
  });
  const at = nowIso(); // one stamp: headlessStatus() compares stateSince with endedAt
  const write = updateSession(sid, { state: 'ended', stateSince: at, endedAt: at, endReason: input.reason, awaiting: undefined, watcher: undefined });
  write.catch(() => {}); // when the budget wins the race, a late failure must not become an unhandled rejection
  try {
    await Promise.race([write, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
