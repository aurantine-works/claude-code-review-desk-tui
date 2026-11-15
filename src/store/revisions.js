import { paths } from './paths.js';
import { writeFileAtomic } from './io.js';
import { withReview, sha1, deriveTitle } from './reviews.js';
import { reanchor } from '../anchor/index.js';
import { nowIso } from './time.js';

/**
 * Record new content for a review.
 *  - identical sha1 to the latest revision -> no-op
 *  - same turn as the latest revision      -> overwrite that snapshot (merge)
 *  - otherwise                             -> new revision
 * Unresolved threads are re-anchored against the new content. The title is derived again from the new content (the same rule
 * as at creation) unless it was given explicitly (`meta.titleExplicit`).
 * `sessionId`: the session that wrote it. A different session takes the review over (the newest writer
 * can answer for the file) and its turn counter is unrelated to the previous one, so nothing is merged then.
 * Status becomes awaiting_review, except that feedback still queued for delivery stays feedback_pending.
 */
export function appendRevision(id, content, { source, turn, threshold, sessionId } = {}) {
  return withReview(id, (ctx) => {
    const { meta } = ctx;
    if (meta.status === 'closed' || meta.status === 'approved') {
      throw new Error(`review ${id} is ${meta.status}`);
    }
    const latest = meta.revisions[meta.revisions.length - 1];
    const hash = sha1(content);
    if (latest.sha1 === hash) return { n: latest.n, changed: false, merged: false };

    const rebind = !!sessionId && !!meta.sessionId && sessionId !== meta.sessionId;
    // A manual revision (the user adopted an external edit) is never merged into, and never merges into the previous one.
    const merged = !rebind && turn != null && latest.turn === turn && source !== 'ExitPlanMode' && source !== 'manual' && latest.source !== 'manual';
    let n = latest.n;
    if (merged) {
      latest.sha1 = hash;
      latest.at = nowIso();
      latest.source = source ?? latest.source;
    } else {
      n = latest.n + 1;
      meta.revisions.push({ n, at: nowIso(), source, sha1: hash, turn: turn ?? 0 });
      meta.currentRevision = n;
    }
    writeFileAtomic(paths.revision(id, n), content);
    if (!meta.titleExplicit) meta.title = deriveTitle(meta.docPath, content); // follows a renamed top heading
    reanchor(ctx.threads, content, n, { threshold });
    if (rebind) meta.sessionId = sessionId;
    meta.status = ctx.outbox.some((e) => !e.receivedAt) ? 'feedback_pending' : 'awaiting_review';
    return { n, changed: true, merged };
  });
}
