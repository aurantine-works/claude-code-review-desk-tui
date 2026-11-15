// Process-tree helpers (Linux /proc). Used to find the claude process that owns a
// hook invocation (session-start) or a background `rd await` (M2).
import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive } from './sessions.js';

const MAX_DEPTH = 40;

/** Parent pid, start time (clock ticks since boot, the PID-reuse guard) and argv of a process, or null. */
export function readProc(pid, procRoot = '/proc') {
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    // "pid (comm) S ppid ..." where comm may itself contain spaces and parentheses.
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' '); // fields[0] is the state, fields[1] is ppid
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid)) return null;
    const startTime = Number(fields[19]); // field 22 of proc(5): starttime
    const raw = fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
    const argv = raw.split('\0');
    if (argv[argv.length - 1] === '') argv.pop();
    return { pid, ppid, argv, startTime: Number.isFinite(startTime) ? startTime : null };
  } catch {
    return null;
  }
}

const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno']);
const base = (p) => path.basename(String(p ?? ''));

/**
 * Does this argv look like the Claude Code CLI?
 *  - native build:  argv0 is `claude` (the process title is set to it)
 *  - npm build:     `node …/@anthropic-ai/claude-code/cli.js` or `node …/bin/claude`
 */
export function looksLikeClaude(argv) {
  if (!argv || argv.length === 0) return false;
  const a0 = base(argv[0]);
  if (a0 === 'claude' || a0 === 'claude.exe') return true;
  if (RUNTIMES.has(a0)) {
    // Skip runtime flags such as --no-warnings; the script is the first non-flag argument.
    const script = argv.slice(1).find((x) => !x.startsWith('-'));
    if (!script) return false;
    return /[\\/]@anthropic-ai[\\/]claude-code[\\/]/.test(script) || base(script) === 'claude';
  }
  return false;
}

const validPid = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 1 ? n : null;
};

/**
 * The claude process that owns this hook / Bash call.
 *  1. env CLAUDE_PID, exported by Claude Code to hooks and the Bash tool (verified: it is alive and,
 *     where /proc is readable, its argv looks like claude, which rejects a recycled pid);
 *  2. a /proc walk from `start` (our parent, normally `/bin/sh -c <hook>`) to the first claude process;
 *  3. `start` itself.
 * Returns { pid, via: 'env' | 'walk' | 'ppid', startTime }.
 */
export function findClaudeProcess({ start = process.ppid, env = process.env, procRoot = '/proc', alive = isPidAlive } = {}) {
  const hinted = validPid(env.CLAUDE_PID);
  if (hinted && alive(hinted)) {
    const p = readProc(hinted, procRoot);
    if (!p || looksLikeClaude(p.argv)) return { pid: hinted, via: 'env', startTime: p?.startTime ?? null };
  }
  let pid = start;
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
    const p = readProc(pid, procRoot);
    if (!p) break;
    if (looksLikeClaude(p.argv)) return { pid, via: 'walk', startTime: p.startTime };
    pid = p.ppid;
  }
  return { pid: start, via: 'ppid', startTime: null };
}

/** pid of the claude process above us; falls back to our parent pid. */
export const findClaudePid = (opts) => findClaudeProcess(opts).pid;

/**
 * Is the process found by findClaudeProcess() still the same one? Compares the /proc start time so a
 * recycled pid does not count; without /proc it degrades to kill(pid, 0).
 */
export function isSameProcessAlive({ pid, startTime }, { procRoot = '/proc', alive = isPidAlive } = {}) {
  if (!alive(pid)) return false;
  if (startTime == null) return true;
  const p = readProc(pid, procRoot);
  return !p || p.startTime == null || p.startTime === startTime;
}

/**
 * Session id Claude Code exports to hooks and to the Bash tool (it follows /clear). `rd await` and
 * `rd reply` run from the Bash tool can use it directly instead of walking the process tree.
 */
export function claudeSessionIdFromEnv(env = process.env) {
  const sid = env.CLAUDE_CODE_SESSION_ID;
  return typeof sid === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(sid) && sid !== '__proto__' ? sid : null;
}

/** Is the process a session-record entry (`{pid, startTime, ...}`) describes still the same live process? */
function recordAlive(rec, opts) {
  if (!rec || !Number.isInteger(rec.pid)) return false;
  return isSameProcessAlive({ pid: rec.pid, startTime: rec.startTime ?? null }, opts);
}

/**
 * Is the `rd await` recorded in a session record (`awaiting: {pid, startTime, ...}`) still the same live process?
 * The start time guards against a recycled pid; records without one fall back to kill(pid, 0).
 */
export const awaitingAlive = (session, opts) => recordAlive(session?.awaiting, opts);

/** Same for the automatic wake-up watcher (`rd hook watch`, `watcher: {pid, startTime, since}`). */
export const watcherAlive = (session, opts) => recordAlive(session?.watcher, opts);
