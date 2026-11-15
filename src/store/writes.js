import fs from 'node:fs';
import { paths, canonicalPath } from './paths.js';
import { appendJsonl, readJsonl } from './io.js';
import { nowIso } from './time.js';

/** Unconditionally record a Write/Edit/MultiEdit (append-only, no locking needed). */
export function recordWrite({ path: p, sessionId, cwd, tool, agentId }) {
  appendJsonl(paths.writes(), { path: canonicalPath(p), sessionId, cwd, tool, ...(agentId ? { agentId } : {}), at: nowIso() });
}

/** All writers of a path, newest first. */
export function writersOf(p) {
  const target = canonicalPath(p);
  return readJsonl(paths.writes())
    .filter((w) => w.path === target)
    .reverse();
}

export const lastWriter = (p) => writersOf(p)[0] ?? null;

/**
 * When was `p` last written by Claude (epoch ms), or null? Reads only the tail of writes.jsonl, so it is cheap
 * enough for a TUI poll even when the log has grown large.
 */
export function lastWriteAt(p, { tailBytes = 256 * 1024 } = {}) {
  const target = canonicalPath(p);
  let fd;
  try {
    fd = fs.openSync(paths.writes(), 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the first line is cut off
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(target)) continue; // cheap pre-filter
      try {
        const w = JSON.parse(lines[i]);
        if (w.path === target) return Date.parse(w.at) || null;
      } catch {
        /* torn line */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
