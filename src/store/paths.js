// Filesystem layout for ~/.review-desk (overridable with RD_HOME for tests/isolation).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const rdHome = () => process.env.RD_HOME || path.join(os.homedir(), '.review-desk');

export const paths = {
  home: () => rdHome(),
  config: () => path.join(rdHome(), 'config.json'),
  sessions: () => path.join(rdHome(), 'sessions.json'),
  docsIndex: () => path.join(rdHome(), 'docs-index.json'),
  writes: () => path.join(rdHome(), 'writes.jsonl'),
  reviewsDir: () => path.join(rdHome(), 'reviews'),
  reviewDir: (id) => path.join(rdHome(), 'reviews', id),
  meta: (id) => path.join(rdHome(), 'reviews', id, 'meta.json'),
  threads: (id) => path.join(rdHome(), 'reviews', id, 'threads.json'),
  outbox: (id) => path.join(rdHome(), 'reviews', id, 'outbox.json'),
  revisionsDir: (id) => path.join(rdHome(), 'reviews', id, 'revisions'),
  revision: (id, n) => path.join(rdHome(), 'reviews', id, 'revisions', `${String(n).padStart(3, '0')}.md`),
  logs: () => path.join(rdHome(), 'logs'),
  log: () => path.join(rdHome(), 'logs', 'rd.log'),
  // Scratch files (the `$EDITOR` hand-over, gc's trash). Created on demand, 0700; `rd gc` removes leftovers.
  tmp: () => path.join(rdHome(), 'tmp'),
};

/** Create the home directory (mode 700) if needed. */
export function ensureHome() {
  const home = rdHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    /* best effort (e.g. not the owner) */
  }
  return home;
}

/** Create RD_HOME/tmp (mode 700) if needed and return it. */
export function ensureTmp() {
  ensureHome();
  const dir = paths.tmp();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Absolute + realpath-normalised path. For files that do not exist (yet), the
 * parent directory is resolved instead so the result is still stable.
 */
export function canonicalPath(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}
