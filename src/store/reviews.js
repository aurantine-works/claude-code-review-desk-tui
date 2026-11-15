// Review metadata, revisions and the per-review transaction primitive.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { paths, ensureHome } from './paths.js';
import { readJson, writeJsonAtomic, writeFileAtomic, withLock } from './io.js';
import { assertReviewId, newReviewId } from './ids.js';
import { nowIso } from './time.js';

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

const title = (content, fallback) => {
  const m = /^#\s+(.+)$/m.exec(content);
  return (m ? m[1].trim() : fallback) || 'untitled';
};

/**
 * The title a review gets from its content: the first `# heading`, else the file name (documents) or 'plan'. Used when the
 * review is created and again for every new revision (Claude may rename the heading), unless the title was given explicitly.
 */
export const deriveTitle = (docPath, content) => title(content, docPath ? docPath.split('/').pop() : 'plan');

/** `extra`: more fields for meta.json (e.g. `writers` of a manually registered document); the core fields win. */
export async function createReview({ kind, docPath = null, title: t, sessionId, cwd, content, source, turn = 0, extra = {} }) {
  ensureHome();
  const id = newReviewId(kind);
  const at = nowIso();
  const meta = {
    ...extra,
    id,
    kind,
    docPath,
    title: t || deriveTitle(docPath, content),
    ...(t ? { titleExplicit: true } : {}), // appendRevision() keeps an explicit title; a derived one follows the content
    sessionId,
    cwd,
    status: 'awaiting_review',
    round: 0,
    currentRevision: 1,
    revisions: [{ n: 1, at, source, sha1: sha1(content), turn }],
    createdAt: at,
    updatedAt: at,
  };
  fs.mkdirSync(paths.revisionsDir(id), { recursive: true, mode: 0o700 });
  writeFileAtomic(paths.revision(id, 1), content);
  writeJsonAtomic(paths.threads(id), []);
  writeJsonAtomic(paths.outbox(id), []);
  writeJsonAtomic(paths.meta(id), meta);
  return meta;
}

export function getMeta(id) {
  assertReviewId(id);
  const meta = readJson(paths.meta(id), null);
  if (!meta) throw new Error(`review not found: ${id}`);
  return meta;
}

export function listMetas() {
  let names;
  try {
    names = fs.readdirSync(paths.reviewsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const m = readJson(paths.meta(name), null);
      if (m) out.push(m);
    } catch {
      /* skip broken review dirs */
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function readRevision(id, n) {
  assertReviewId(id);
  return fs.readFileSync(paths.revision(id, n), 'utf8');
}

/**
 * Transaction on one review: lock its directory, load meta/threads/outbox,
 * run fn(ctx), persist whatever changed. fn may be async.
 */
export async function withReview(id, fn) {
  assertReviewId(id);
  if (!fs.existsSync(paths.meta(id))) throw new Error(`review not found: ${id}`);
  return withLock(paths.meta(id), async () => {
    const ctx = {
      meta: readJson(paths.meta(id), null),
      threads: readJson(paths.threads(id), []),
      outbox: readJson(paths.outbox(id), []),
    };
    const before = {
      meta: JSON.stringify(ctx.meta),
      threads: JSON.stringify(ctx.threads),
      outbox: JSON.stringify(ctx.outbox),
    };
    const result = await fn(ctx);
    let changed = false;
    if (JSON.stringify(ctx.threads) !== before.threads) {
      writeJsonAtomic(paths.threads(id), ctx.threads);
      changed = true;
    }
    if (JSON.stringify(ctx.outbox) !== before.outbox) {
      writeJsonAtomic(paths.outbox(id), ctx.outbox);
      changed = true;
    }
    if (changed || JSON.stringify(ctx.meta) !== before.meta) {
      ctx.meta.updatedAt = nowIso();
      writeJsonAtomic(paths.meta(id), ctx.meta);
    }
    return result;
  });
}

export const setStatus = (id, status) =>
  withReview(id, (ctx) => {
    ctx.meta.status = status;
    return ctx.meta;
  });
