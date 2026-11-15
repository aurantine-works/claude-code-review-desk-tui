// Document reviews: registering what Claude wrote (post-tool-use hook) or what the user points at (`rd add`, `rd open <path>`),
// binding a review to another session, and noticing edits made outside Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import { paths, canonicalPath } from './paths.js';
import { readJson, writeJsonAtomic, withLock } from './io.js';
import { createReview, getMeta, withReview, sha1 } from './reviews.js';
import { appendRevision } from './revisions.js';
import { isFinalStatus } from './outbox.js';
import { assertReviewId } from './ids.js';
import { isPending } from './threads.js';
import { getSession, isSessionId } from './sessions.js';
import { lastWriteAt } from './writes.js';

/** Documents above this size are never registered or adopted (the post-tool-use hook has the same cap). */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;
/** A change to a file Claude wrote this recently is Claude's own, still being registered by the hook: not reported as external. */
export const EXTERNAL_SETTLE_MS = 5000;

/** Claude Code session ids are UUIDs. */
export const isUuidSessionId = (sid) => typeof sid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid);

/**
 * Read a document for registration or adoption: a regular file, at most 2 MB, text (no NUL byte).
 * @throws Error with `.code` 'not-found' | 'not-file' | 'too-large' | 'binary' | 'unreadable'
 */
export function readDocText(abs) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  let st;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    throw fail(err.code === 'ENOENT' ? 'not-found' : 'unreadable', err.code === 'ENOENT' ? `file not found: ${abs}` : `cannot read ${abs}: ${err.message}`);
  }
  if (!st.isFile()) throw fail('not-file', `not a regular file: ${abs}`);
  if (st.size > MAX_DOC_BYTES) throw fail('too-large', `file is larger than ${MAX_DOC_BYTES / 1024 / 1024} MB: ${abs}`);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    throw fail('unreadable', `cannot read ${abs}: ${err.message}`);
  }
  if (buf.includes(0)) throw fail('binary', `not a text file (contains NUL bytes): ${abs}`);
  return buf.toString('utf8');
}

/** The active (existing, unfinished) review of an index entry; a stale entry is dropped from `index`. */
function liveEntry(index, key) {
  const id = index[key] ?? null;
  if (!id) return null;
  const meta = readJson(paths.meta(id), null);
  if (!meta || isFinalStatus(meta.status)) {
    // Stale entry (review closed behind our back, or its directory was removed).
    delete index[key];
    writeJsonAtomic(paths.docsIndex(), index);
    return null;
  }
  return id;
}

/**
 * A document was written (Write / Edit / MultiEdit). The whole check-and-create runs under the docs-index lock,
 * so two concurrent hooks never open two reviews for one file.
 *  - the path has an active review  -> new revision of it (same turn merges), whether or not it matches the globs;
 *  - otherwise, when `autoRegister` -> a new doc review bound to the session;
 *  - otherwise                      -> nothing.
 * @returns {Promise<{action: 'revision'|'created'|'ignored', id?: string, n?: number, changed?: boolean, merged?: boolean}>}
 */
export function registerDocWrite({ docPath, content, sessionId, cwd, tool, turn, autoRegister }) {
  const key = canonicalPath(docPath);
  return withLock(paths.docsIndex(), async () => {
    const index = readJson(paths.docsIndex(), {});
    const id = liveEntry(index, key);
    if (id) {
      const r = await appendRevision(id, content, { source: tool, turn, sessionId });
      return { action: 'revision', id, ...r };
    }
    if (!autoRegister) return { action: 'ignored' };
    const meta = await createReview({ kind: 'doc', docPath: key, sessionId, cwd, content, source: tool, turn: turn ?? 0 });
    index[key] = meta.id;
    writeJsonAtomic(paths.docsIndex(), index);
    return { action: 'created', id: meta.id };
  });
}

/**
 * `rd add` / `rd open <path>`: register a document by hand, bound to the session that wrote it.
 * An already active review of the path is returned as it is (`action: 'existing'`); otherwise a new doc review
 * (revision source `manual`, status awaiting_review) is created with `meta.writers` = the other sessions that could
 * answer for the file (so the user can rebind later).
 * @param {{docPath: string, content: string, sessionId: string, cwd: string, writers?: object[]}} p
 * @returns {Promise<{action: 'existing'|'created', id: string}>}
 */
export function registerManualDoc({ docPath, content, sessionId, cwd, writers = [] }) {
  const key = canonicalPath(docPath);
  return withLock(paths.docsIndex(), async () => {
    const index = readJson(paths.docsIndex(), {});
    const existing = liveEntry(index, key);
    if (existing) return { action: 'existing', id: existing };
    const meta = await createReview({ kind: 'doc', docPath: key, sessionId, cwd, content, source: 'manual', turn: 0, extra: { writers } });
    index[key] = meta.id;
    writeJsonAtomic(paths.docsIndex(), index);
    return { action: 'created', id: meta.id };
  });
}

/**
 * Bind a document review to another session (the file was written by several; the default is the last writer).
 * Allowed ids: the sessions in `meta.writers`, or any other well-formed UUID (explicitly named by the user) or session
 * rd already knows. Refused while Claude is answering (a message was received and its thread is still unanswered): the
 * answer would land in a session that no longer owns the review. Messages still waiting for delivery stay in the outbox
 * and go to the new session (their `injectedAt` marks belonged to the old terminal and are dropped).
 * `meta.cwd` becomes the new session's directory (`opts.cwd`, the writers entry, the registry record, in that order).
 * The previous headless-run record is dropped; the new session is added to `meta.writers` when it was not listed.
 * @returns {Promise<object>} the updated meta
 * @throws Error ('not a document review', 'invalid session id', 'Claude is answering…', finished review)
 */
export async function rebindSession(id, sessionId, opts = {}) {
  assertReviewId(id);
  if (!isSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  return withReview(id, (ctx) => {
    const { meta } = ctx;
    if (meta.kind !== 'doc') throw new Error('only document reviews can be bound to another session');
    if (isFinalStatus(meta.status)) throw new Error(`review ${id} is ${meta.status}`);
    const writers = Array.isArray(meta.writers) ? meta.writers : [];
    const known = writers.find((w) => w?.sessionId === sessionId);
    if (!known && !isUuidSessionId(sessionId) && !getSession(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)} (expected a Claude Code session UUID)`);
    if (meta.sessionId === sessionId) return meta;

    const pendingIds = new Set(ctx.threads.filter(isPending).map((t) => t.id));
    if (ctx.outbox.some((e) => e.receivedAt && pendingIds.has(e.threadId))) {
      throw new Error('Claude is answering this review right now; wait for the answer before binding another session');
    }
    const cwd = opts.cwd ?? known?.cwd ?? getSession(sessionId)?.cwd ?? meta.cwd;
    meta.sessionId = sessionId;
    meta.cwd = cwd;
    delete meta.headless;
    for (const e of ctx.outbox) if (!e.receivedAt) delete e.injectedAt;
    if (!known) meta.writers = [...writers, { sessionId, cwd, project: cwd ? path.basename(cwd) : '', lastAt: null, firstPrompt: '', source: 'explicit' }];
    return meta;
  });
}

/**
 * Has the document been changed outside Claude Code? Compares the sha1 of the file with the latest revision.
 * Synchronous and cheap (one small read; no locking), meant for the TUI's poll.
 *
 *  - `{state: 'same', sha}`                                  identical to the latest revision
 *  - `{state: 'changed', sha}`                               different (`tooLarge` / `binary` when the file cannot be adopted)
 *  - `{state: 'missing'}`                                    the file is gone (or unreadable): only the snapshot can be shown
 *  - `{state: 'same', settling: true, sha}`                  different, but Claude wrote the path less than 5 s ago: the post-tool-use
 *                                                            hook is about to register that write, so it is not an external edit
 *  - `{state: 'same', skipped: true}`                        plan reviews, finished reviews, reviews without a file are not checked
 * The TUI additionally waits until a `changed` verdict (same sha) has lasted 3 s before it warns.
 * @param {string} id
 * @param {{now?: number}} [deps]
 */
export function checkExternal(id, deps = {}) {
  const meta = getMeta(assertReviewId(id));
  if (meta.kind !== 'doc' || !meta.docPath || isFinalStatus(meta.status)) return { state: 'same', skipped: true };
  const latest = meta.revisions[meta.revisions.length - 1];
  let st;
  try {
    st = fs.statSync(meta.docPath);
    if (!st.isFile()) return { state: 'missing' };
  } catch {
    return { state: 'missing' };
  }
  if (st.size > MAX_DOC_BYTES) return { state: 'changed', tooLarge: true };
  let buf;
  try {
    buf = fs.readFileSync(meta.docPath);
  } catch {
    return { state: 'missing' };
  }
  const sha = sha1(buf.toString('utf8'));
  if (sha === latest.sha1) return { state: 'same', sha };
  if (buf.includes(0)) return { state: 'changed', sha, binary: true };
  const wrote = lastWriteAt(meta.docPath);
  if (wrote !== null && (deps.now ?? Date.now()) - wrote < EXTERNAL_SETTLE_MS) return { state: 'same', settling: true, sha };
  return { state: 'changed', sha };
}

/**
 * Take the file's current content as a new revision (source `manual`), re-anchoring the threads as usual.
 * No-op (`changed: false`) when it already equals the latest revision.
 * @returns {Promise<{n: number, changed: boolean, merged: boolean}>}
 * @throws Error when the file is gone / too large / not text, or the review is not an unfinished document review
 */
export async function adoptExternal(id) {
  const meta = getMeta(assertReviewId(id));
  if (meta.kind !== 'doc' || !meta.docPath) throw new Error('only document reviews follow a file');
  if (isFinalStatus(meta.status)) throw new Error(`review ${id} is ${meta.status}`);
  return appendRevision(id, readDocText(meta.docPath), { source: 'manual' });
}
