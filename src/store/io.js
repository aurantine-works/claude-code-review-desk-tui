// Atomic JSON IO + cross-process locking. All state lives in plain files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Never silently overwrite a corrupt file.
    throw new Error(`corrupt JSON in ${file}: ${err.message}`);
  }
}

/** Write to a temp file in the same directory, fsync, then rename over the target. */
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn/corrupt line */
    }
  }
  return out;
}

// proper-lockfile (and graceful-fs behind it) costs ~25ms to load. Read-only callers
// (statusline, hooks that only read) must not pay for it, so it is imported on first use.
let lockfilePromise;
const loadLockfile = () => (lockfilePromise ??= import('proper-lockfile').then((m) => m.default ?? m));

/**
 * Run fn while holding an exclusive lock on `resource` (a path; the lock is a
 * sibling `<resource>.lock` directory, so the resource itself need not exist).
 */
export async function withLock(resource, fn) {
  fs.mkdirSync(path.dirname(resource), { recursive: true, mode: 0o700 });
  const lockfile = await loadLockfile();
  const release = await lockfile.lock(resource, {
    realpath: false,
    stale: 10000,
    update: 2000,
    retries: { retries: 200, factor: 1, minTimeout: 10, maxTimeout: 60, randomize: true },
  });
  try {
    return await fn();
  } finally {
    await release().catch(() => {});
  }
}
