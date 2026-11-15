// `rd gc [--days 30] [--dry-run] [--yes]`: delete what has outlived its use.
//
//   reviews      closed / approved and last updated more than N days ago (the whole directory), plus the docs-index entries
//                and `rd await` records that still point at them
//   sessions     ended more than N days ago and not referenced by any remaining review
//   writes.jsonl only the lines of the last N days stay (atomic rewrite, under a lock)
//   logs/        headless-<review>.log older than N days; rd.log above 5 MB is cut down to its last 1 MB
//   tmp/         leftovers of an `$EDITOR` hand-over that crashed (older than an hour)
//
// planGc() only looks; applyGc() deletes. `--dry-run` prints the plan and stops. Without `--yes` a terminal is asked (y/N); with
// no terminal and no `--yes` nothing is deleted.
import fs from 'node:fs';
import path from 'node:path';
import { paths, rdHome } from '../store/paths.js';
import { readJson, writeJsonAtomic, writeFileAtomic, withLock } from '../store/io.js';
import { REVIEW_ID_RE } from '../store/ids.js';
import { isFinalStatus } from '../store/outbox.js';
import { awaitingAlive } from '../store/proc.js';
import { askYesNo } from './installCmd.js';

const DAY_MS = 86_400_000;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP_BYTES = 1024 * 1024;
export const TMP_GRACE_MS = 3600_000;

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? null : t;
};

const statOrNull = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/** Bytes used by a file or a directory tree (lstat: symlinks count as themselves, never followed). */
export function sizeOf(p) {
  const st = statOrNull(p);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(p);
  } catch {
    /* unreadable: count what we have */
  }
  for (const name of names) n += sizeOf(path.join(p, name));
  return n;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ageDays = (t, now) => Math.floor((now - t) / DAY_MS);

/**
 * What would be deleted. Read-only.
 * @param {{days?: number, now?: number}} [opts]
 */
export function planGc({ days = 30, now = Date.now() } = {}) {
  const cutoff = now - days * DAY_MS;
  const plan = { days, now, cutoff, reviews: [], sessions: [], writes: null, logs: [], tmp: [], docsIndex: [], awaiting: [], bytes: 0 };

  // reviews
  const keep = new Set();
  let names = [];
  try {
    names = fs.readdirSync(paths.reviewsDir());
  } catch {
    /* no reviews */
  }
  for (const name of names) {
    if (!REVIEW_ID_RE.test(name)) continue;
    let meta = null;
    try {
      meta = readJson(paths.meta(name), null);
    } catch {
      /* unreadable: never delete what cannot be understood */
    }
    const updated = meta ? (ms(meta.updatedAt) ?? statOrNull(paths.meta(name))?.mtimeMs ?? null) : null;
    if (meta && isFinalStatus(meta.status) && updated !== null && updated < cutoff) {
      plan.reviews.push({ id: name, status: meta.status, title: meta.title ?? '', ageDays: ageDays(updated, now), bytes: sizeOf(paths.reviewDir(name)) });
    } else {
      keep.add(name);
    }
  }
  const gone = new Set(plan.reviews.map((r) => r.id));

  // docs-index entries of deleted reviews, and dangling ones (their review directory is not there any more)
  try {
    for (const [doc, id] of Object.entries(readJson(paths.docsIndex(), {}))) {
      if (gone.has(id) || (typeof id === 'string' && REVIEW_ID_RE.test(id) && !keep.has(id))) plan.docsIndex.push({ path: doc, id });
    }
  } catch {
    /* corrupt index: doctor reports it */
  }

  // sessions
  let sessions = {};
  try {
    sessions = readJson(paths.sessions(), {});
  } catch {
    /* ignore */
  }
  const referenced = new Set();
  for (const name of keep) {
    try {
      const m = readJson(paths.meta(name), null);
      if (m?.sessionId) referenced.add(m.sessionId);
    } catch {
      /* ignore */
    }
  }
  for (const s of Object.values(sessions)) {
    const ended = s.state === 'ended' ? (ms(s.endedAt) ?? ms(s.updatedAt)) : null;
    if (ended !== null && ended < cutoff && !referenced.has(s.sessionId)) plan.sessions.push({ sessionId: s.sessionId, cwd: s.cwd ?? '', ageDays: ageDays(ended, now) });
    else if (s.awaiting && gone.has(s.awaiting.reviewId) && !awaitingAlive(s)) plan.awaiting.push(s.sessionId);
  }

  // writes.jsonl: lines of the last N days stay (an unparsable, torn line goes)
  const wst = statOrNull(paths.writes());
  if (wst?.isFile()) {
    const lines = fs.readFileSync(paths.writes(), 'utf8').split('\n').filter((l) => l.trim());
    const kept = lines.filter((l) => {
      try {
        return (ms(JSON.parse(l)?.at) ?? 0) >= cutoff;
      } catch {
        return false;
      }
    });
    if (kept.length < lines.length) {
      plan.writes = { total: lines.length, drop: lines.length - kept.length, bytes: Math.max(0, wst.size - Buffer.byteLength(kept.map((l) => l + '\n').join(''))) };
    }
  }

  // logs
  try {
    for (const name of fs.readdirSync(paths.logs())) {
      const p = path.join(paths.logs(), name);
      const st = statOrNull(p);
      if (!st?.isFile()) continue;
      if (/^headless-.+\.log$/.test(name) && st.mtimeMs < cutoff) plan.logs.push({ file: p, name, kind: 'delete', bytes: st.size, ageDays: ageDays(st.mtimeMs, now) });
      else if (name === 'rd.log' && st.size > LOG_MAX_BYTES) plan.logs.push({ file: p, name, kind: 'truncate', bytes: st.size - LOG_KEEP_BYTES, size: st.size });
    }
  } catch {
    /* no logs directory */
  }

  // tmp/
  try {
    for (const name of fs.readdirSync(paths.tmp())) {
      const p = path.join(paths.tmp(), name);
      const st = statOrNull(p);
      if (st && now - st.mtimeMs > TMP_GRACE_MS) plan.tmp.push({ file: p, name, bytes: sizeOf(p) });
    }
  } catch {
    /* no tmp directory */
  }

  plan.bytes = plan.reviews.reduce((n, r) => n + r.bytes, 0) + (plan.writes?.bytes ?? 0) + plan.logs.reduce((n, l) => n + l.bytes, 0) + plan.tmp.reduce((n, t) => n + t.bytes, 0);
  return plan;
}

export const isEmptyPlan = (p) => !p.reviews.length && !p.sessions.length && !p.writes && !p.logs.length && !p.tmp.length && !p.docsIndex.length && !p.awaiting.length;

/** Keep the bytes appended to `file` after `size` when a rewrite replaces it (a hook may append while gc works). */
function appendedSince(file, size) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const end = fs.fstatSync(fd).size;
      if (end <= size) return Buffer.alloc(0);
      const buf = Buffer.alloc(end - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
}

/** Rewrite `file` as the lines `keep(line)` accepts, plus whatever was appended meanwhile. */
function rewriteLines(file, keep) {
  const raw = fs.readFileSync(file);
  const kept = raw
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim() && keep(l))
    .map((l) => l + '\n')
    .join('');
  writeFileAtomic(file, Buffer.concat([Buffer.from(kept), appendedSince(file, raw.length)]));
}

/**
 * Carry the plan out. Every step re-checks what it deletes (a review reopened or a session resumed since the plan was made is
 * left alone). Returns what was actually removed.
 */
export async function applyGc(plan) {
  const done = { reviews: [], sessions: [], writesDropped: 0, logs: [], tmp: [], docsIndex: 0, awaiting: 0, bytes: 0, errors: [] };
  const guarded = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      done.errors.push(`${what}: ${err.message}`);
    }
  };
  fs.mkdirSync(rdHome(), { recursive: true, mode: 0o700 });
  await withLock(path.join(rdHome(), 'gc'), async () => {
    // reviews: move out of sight first, then delete
    for (const r of plan.reviews) {
      await guarded(`review ${r.id}`, async () => {
        const meta = readJson(paths.meta(r.id), null);
        const updated = meta ? (ms(meta.updatedAt) ?? statOrNull(paths.meta(r.id))?.mtimeMs ?? null) : null;
        if (!meta || !isFinalStatus(meta.status) || updated === null || updated >= plan.cutoff) return;
        const trash = path.join(paths.tmp(), `gc-${process.pid}-${r.id}`);
        fs.mkdirSync(paths.tmp(), { recursive: true, mode: 0o700 });
        try {
          fs.renameSync(paths.reviewDir(r.id), trash);
        } catch {
          fs.rmSync(paths.reviewDir(r.id), { recursive: true, force: true });
        }
        fs.rmSync(trash, { recursive: true, force: true });
        done.reviews.push(r.id);
        done.bytes += r.bytes;
      });
    }
    const gone = new Set(done.reviews);

    await guarded('docs-index.json', async () => {
      if (!plan.docsIndex.length) return;
      await withLock(paths.docsIndex(), () => {
        const all = readJson(paths.docsIndex(), {});
        for (const e of plan.docsIndex) {
          if (all[e.path] === e.id && !fs.existsSync(paths.meta(e.id))) {
            delete all[e.path];
            done.docsIndex++;
          }
        }
        if (done.docsIndex) writeJsonAtomic(paths.docsIndex(), all);
      });
    });

    await guarded('sessions.json', async () => {
      if (!plan.sessions.length && !plan.awaiting.length) return;
      await withLock(paths.sessions(), () => {
        const all = readJson(paths.sessions(), {});
        // references are checked again against the reviews that are left
        const referenced = new Set();
        for (const name of fs.existsSync(paths.reviewsDir()) ? fs.readdirSync(paths.reviewsDir()) : []) {
          try {
            const m = readJson(paths.meta(name), null);
            if (m?.sessionId) referenced.add(m.sessionId);
          } catch {
            /* ignore */
          }
        }
        for (const s of plan.sessions) {
          const cur = all[s.sessionId];
          const ended = cur?.state === 'ended' ? (ms(cur.endedAt) ?? ms(cur.updatedAt)) : null;
          if (cur && ended !== null && ended < plan.cutoff && !referenced.has(s.sessionId)) {
            delete all[s.sessionId];
            done.sessions.push(s.sessionId);
          }
        }
        for (const sid of plan.awaiting) {
          const cur = all[sid];
          if (cur?.awaiting && gone.has(cur.awaiting.reviewId) && !awaitingAlive(cur)) {
            delete cur.awaiting;
            done.awaiting++;
          }
        }
        if (done.sessions.length || done.awaiting) writeJsonAtomic(paths.sessions(), all);
      });
    });

    await guarded('writes.jsonl', async () => {
      if (!plan.writes) return;
      await withLock(paths.writes(), () => {
        const before = fs.statSync(paths.writes()).size;
        rewriteLines(paths.writes(), (l) => {
          try {
            return (ms(JSON.parse(l)?.at) ?? 0) >= plan.cutoff;
          } catch {
            return false; // a torn line
          }
        });
        const after = fs.statSync(paths.writes()).size;
        done.writesDropped = plan.writes.drop;
        done.bytes += Math.max(0, before - after);
      });
    });

    for (const l of plan.logs) {
      await guarded(l.name, async () => {
        if (l.kind === 'delete') {
          fs.rmSync(l.file, { force: true });
          done.logs.push(l.name);
          done.bytes += l.bytes;
          return;
        }
        // rd.log: keep the last LOG_KEEP_BYTES, starting at a line boundary
        const raw = fs.readFileSync(l.file);
        if (raw.length <= LOG_MAX_BYTES) return;
        let from = raw.length - LOG_KEEP_BYTES;
        const nl = raw.indexOf(10, from);
        from = nl === -1 ? raw.length : nl + 1;
        writeFileAtomic(l.file, Buffer.concat([raw.subarray(from), appendedSince(l.file, raw.length)]));
        done.logs.push(`${l.name} (truncated)`);
        done.bytes += from;
      });
    }

    for (const t of plan.tmp) {
      await guarded(`tmp/${t.name}`, async () => {
        const st = statOrNull(t.file);
        if (!st || Date.now() - st.mtimeMs <= TMP_GRACE_MS) return;
        fs.rmSync(t.file, { recursive: true, force: true });
        done.tmp.push(t.name);
        done.bytes += t.bytes;
      });
    }
  });
  return done;
}

/** The plan as text. */
export function formatPlan(plan, { dryRun = false } = {}) {
  const lines = [];
  const date = new Date(plan.cutoff).toISOString().slice(0, 10);
  lines.push(`# rd gc --days ${plan.days} (older than ${date})${dryRun ? ' --dry-run: nothing is deleted' : ''}`);
  if (isEmptyPlan(plan)) {
    lines.push('Nothing to delete.');
    return lines.join('\n');
  }
  if (plan.reviews.length) {
    lines.push(`reviews: ${plan.reviews.length} (${formatBytes(plan.reviews.reduce((n, r) => n + r.bytes, 0))})`);
    for (const r of plan.reviews) lines.push(`  - ${r.id}  ${r.status}  ${r.ageDays}d  ${formatBytes(r.bytes)}  ${r.title}`);
  }
  if (plan.docsIndex.length) lines.push(`docs-index.json: ${plan.docsIndex.length} stale entr${plan.docsIndex.length === 1 ? 'y' : 'ies'}`);
  if (plan.sessions.length) {
    lines.push(`sessions: ${plan.sessions.length} ended`);
    for (const s of plan.sessions) lines.push(`  - ${s.sessionId.slice(0, 8)}  ${s.ageDays}d  ${s.cwd}`);
  }
  if (plan.awaiting.length) lines.push(`sessions.json: ${plan.awaiting.length} \`rd await\` record(s) of deleted reviews`);
  if (plan.writes) lines.push(`writes.jsonl: ${plan.writes.drop} of ${plan.writes.total} line(s) older than ${plan.days} days (${formatBytes(plan.writes.bytes)})`);
  for (const l of plan.logs) lines.push(l.kind === 'delete' ? `logs/${l.name}: ${l.ageDays}d old, ${formatBytes(l.bytes)}` : `logs/${l.name}: ${formatBytes(l.size)} -> keep the last ${formatBytes(LOG_KEEP_BYTES)}`);
  if (plan.tmp.length) lines.push(`tmp/: ${plan.tmp.length} leftover(s) (${formatBytes(plan.tmp.reduce((n, t) => n + t.bytes, 0))})`);
  lines.push(`frees about ${formatBytes(plan.bytes)}`);
  return lines.join('\n');
}

/**
 * rd gc [--days N] [--dry-run] [--yes]
 * @param {object} opts { days, dryRun, yes }
 * @param {object} [deps] { out(line), confirm(question)->bool, now }
 */
export async function gcCommand(opts = {}, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s + '\n'));
  const confirm = deps.confirm ?? askYesNo;
  const days = opts.days === undefined ? 30 : Number(opts.days);
  if (!Number.isInteger(days) || days < 0) throw new Error(`--days must be a whole number of days (got ${JSON.stringify(opts.days)})`);

  const plan = planGc({ days, now: deps.now });
  out(formatPlan(plan, { dryRun: !!opts.dryRun }));
  if (opts.dryRun || isEmptyPlan(plan)) return { plan, done: null };
  if (!opts.yes && !(await confirm('Delete these?'))) {
    out('Aborted, nothing was deleted.');
    return { plan, done: null };
  }
  const done = await applyGc(plan);
  out(`Deleted ${done.reviews.length} review(s), ${done.sessions.length} session(s)${done.writesDropped ? `, ${done.writesDropped} write record(s)` : ''}${done.logs.length ? `, ${done.logs.length} log(s)` : ''}${done.tmp.length ? `, ${done.tmp.length} temp file(s)` : ''}; freed about ${formatBytes(done.bytes)}.`);
  for (const e of done.errors) out(`  ! ${e}`);
  if (done.errors.length) process.exitCode = 1;
  return { plan, done };
}
