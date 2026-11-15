// Arrival bell for a blocking plan review.
//
// A hook has no controlling terminal (`/dev/tty` fails with ENXIO) and `terminalSequence` is only
// processed when the hook RETURNS, so the "plan arrived" signal is written straight to claude's own
// terminal through /proc/<claudePid>/fd/1. Verified (spike on Claude Code 2.1.322) that this rings
// immediately while the hook is still blocked. Best effort: Linux, same uid, never throws.
import fs from 'node:fs';

const TTY_RE = /^\/dev\/(pts\/\d+|tty[\w/]*|console)$/;

/**
 * Write BEL to the tty behind claude's stdout. Returns true when something was written.
 * @param {number} claudePid
 * @param {object} [deps] procRoot, readlink, open, write, close (tests)
 */
export function ringBell(claudePid, deps = {}) {
  try {
    if (!Number.isInteger(claudePid) || claudePid <= 1) return false;
    const procRoot = deps.procRoot ?? '/proc';
    const fd1 = `${procRoot}/${claudePid}/fd/1`;
    const target = (deps.readlink ?? fs.readlinkSync)(fd1);
    // Only ever touch a real terminal: stdout may be a pipe, a socket or a log file.
    if (!TTY_RE.test(target)) return false;
    const open = deps.open ?? ((p) => fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_NOCTTY));
    const fd = open(fd1);
    try {
      (deps.write ?? fs.writeSync)(fd, '\u0007');
    } finally {
      (deps.close ?? fs.closeSync)(fd);
    }
    return true;
  } catch {
    return false;
  }
}
