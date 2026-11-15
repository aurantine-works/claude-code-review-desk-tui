// Watch mode: deciding which review to open automatically.

/** Identity of one "please look at this" event: a new review, a new revision, or a hook that started waiting again. */
export const autoOpenKey = (meta) => `${meta.id}|${meta.currentRevision}|${meta.round ?? 0}|${meta.hook?.since ?? ''}`;

/**
 * The oldest unseen review that is waiting for the user, or null.
 *  - plan: status awaiting_review *and* its hook process is alive (otherwise Claude is not waiting any more)
 *  - doc:  status awaiting_review, only when config.docs.autoOpen is on
 * @param {{metas: object[], hookAlive: Record<string, boolean>}} data
 * @param {Set<string>} seen
 * @param {{docsAutoOpen?: boolean}} [opts]
 * @returns {{id: string, key: string, meta: object} | null}
 */
export function findAutoOpen(data, seen, { docsAutoOpen = false } = {}) {
  const cands = data.metas
    .filter((m) => m.status === 'awaiting_review')
    .filter((m) => (m.kind === 'plan' ? data.hookAlive[m.id] === true : docsAutoOpen))
    .filter((m) => !seen.has(autoOpenKey(m)))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  const m = cands[0];
  return m ? { id: m.id, key: autoOpenKey(m), meta: m } : null;
}

/**
 * Reviews that turned `answered` since the previous look (watch mode rings the bell once for each).
 * @param {Map<string, string>} prev  id -> status at the previous poll
 * @param {{id: string, status: string}[]} metas
 * @returns {string[]} ids
 */
export function newlyAnswered(prev, metas) {
  return metas.filter((m) => m.status === 'answered' && prev.has(m.id) && prev.get(m.id) !== 'answered').map((m) => m.id);
}
