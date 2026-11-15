// Delivery channel C: the review's Claude Code session is gone (ended, or its process died). The user may
//   [c] be shown the command that resumes the session in their own terminal (`resumeInfo().interactive`),
//   [h] have rd resume it in the background, headless, to answer the feedback (`startHeadless`),
//   [l] leave the feedback queued (nothing to call: the outbox is untouched).
// None of the three changes the review's state; the feedback stays in the outbox until some channel hands it over.
//
// What happens after a resume (verified on Claude Code 2.1.322: same session_id and transcript, slash commands expand in -p):
//  - interactive: the SessionStart hook announces the waiting feedback (additionalContext); the user's next message
//    brings it (channel A, prompt-submit hook), or the user types /review-reply; with an injector rd types it (deliver()).
//  - headless: `claude --resume <sid> -p "/review-reply <rid>"` runs the slash command; the prompt-submit hook attaches
//    the feedback (channel A) with a note that the run is non-interactive, Claude answers with `rd reply`, `rd done`, exits.
//
// Everything that runs a process uses argv arrays (never a shell); the only user-visible shell string is the
// display-only `interactive` command, whose parts are quoted.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { assertReviewId } from '../store/ids.js';
import { getMeta, listMetas, withReview } from '../store/reviews.js';
import { getSession, isSessionId, isPidAlive } from '../store/sessions.js';
import { readProc, isSameProcessAlive } from '../store/proc.js';
import { unreceived, isFinalStatus } from '../store/outbox.js';
import { isPending } from '../store/threads.js';
import { readJson, withLock } from '../store/io.js';
import { paths } from '../store/paths.js';
import { nowIso } from '../store/time.js';
import { logLine } from '../store/log.js';
import { loadConfig } from '../config.js';
import { planDelivery, deliver } from './index.js';

/** The only tools a headless run may use without asking (nobody can answer a prompt): no `rd await`, no arbitrary Bash. */
export const HEADLESS_ALLOWED_TOOLS = 'Bash(rd show:*),Bash(rd reply:*),Bash(rd done:*),Read,Edit,MultiEdit,Write';

/**
 * Environment variables that identify the CLAUDE the caller runs in (rd is often started from Claude's Bash tool, e.g. by an
 * end-to-end run). The resumed process must not inherit them: it is a different claude with its own session, pid and terminal.
 */
const SCRUBBED_ENV = ['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION', 'TMUX', 'TMUX_PANE'];

/** Quote one word for display in a POSIX shell command line. */
export function shellQuote(word) {
  const s = String(word);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

const claudeBin = (config) => {
  const bin = config?.delivery?.claudeBin;
  return typeof bin === 'string' && bin.trim() !== '' && !bin.includes('\0') ? bin : 'claude';
};

export const headlessLogPath = (reviewId) => path.join(paths.logs(), `headless-${assertReviewId(reviewId)}.log`);

/**
 * What the channel C dialog shows and runs for a review.
 * @param {string} reviewId
 * @param {{config?: object}} [deps]
 * @returns {{reviewId: string, sessionId: string, cwd: string|null,
 *   interactive: string,       // display only: `cd <cwd> && claude --resume <sid>` (every word shell-quoted)
 *   headlessArgv: string[],    // full argv of the headless run, the executable first (never joined into a shell string)
 *   log: string}}              // where the headless run appends its output
 * @throws when the id is invalid or the review has no (valid) session id
 */
export function resumeInfo(reviewId, deps = {}) {
  assertReviewId(reviewId);
  const meta = getMeta(reviewId);
  const sid = meta.sessionId;
  if (!sid) throw new Error(`review ${reviewId} has no session to resume`);
  if (!isSessionId(sid)) throw new Error(`review ${reviewId} has an invalid session id: ${JSON.stringify(sid)}`);
  const config = deps.config ?? loadConfig();
  // The directory claude was started in (the registry holds SessionStart's cwd); a hook's cwd can have moved on since.
  const cwd = getSession(sid)?.cwd ?? meta.cwd ?? null;
  const bin = claudeBin(config);
  return {
    reviewId,
    sessionId: sid,
    cwd,
    interactive: `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}${shellQuote(bin)} --resume ${shellQuote(sid)}`,
    headlessArgv: [bin, '--resume', sid, '-p', `/review-reply ${reviewId}`, '--allowedTools', HEADLESS_ALLOWED_TOOLS],
    log: headlessLogPath(reviewId),
  };
}

const REFUSALS = {
  'review-finished': 'the review is finished',
  'no-session': 'the review has no session to resume',
  'invalid-session-id': 'the review has an invalid session id',
  'nothing-waiting': 'no feedback is waiting for delivery',
  'session-alive': 'the session is still running: send the feedback through it (it arrives with the next message)',
  'headless-running': 'a headless run for this session is already in progress',
  'cwd-missing': 'the session\'s working directory no longer exists',
  'spawn-failed': 'could not start claude',
};

/** A live headless run (started by rd) for this session, from the review metas; null when none. */
function liveHeadlessOf(sessionId) {
  for (const m of listMetas()) {
    const h = m.headless;
    if (m.sessionId !== sessionId || !h || h.exitedAt) continue;
    if (isSameProcessAlive({ pid: h.pid, startTime: h.startTime ?? null })) return { reviewId: m.id, ...h };
  }
  return null;
}

/** Is the session's claude process (still) running? Same test as planDelivery uses for "not channel C". */
function sessionRunning(session) {
  if (!session || session.state === 'ended') return false;
  return !Number.isInteger(session.pid) || isPidAlive(session.pid);
}

/** Record how a headless run ended in the review's meta (only while meta.headless still describes that process). */
async function recordExit(reviewId, pid, exitCode, signal) {
  try {
    await withReview(reviewId, (ctx) => {
      const h = ctx.meta.headless;
      if (!h || h.pid !== pid || h.exitedAt) return;
      h.exitedAt = nowIso();
      h.exitCode = exitCode ?? null;
      if (signal) h.signal = signal;
    });
  } catch (err) {
    logLine('rd resume', err); // the review may have been removed meanwhile
  }
}

/**
 * [h]: resume the review's session in the background, headless, to answer the waiting feedback:
 *   claude --resume <sid> -p "/review-reply <rid>" --allowedTools "<HEADLESS_ALLOWED_TOOLS>"
 * run in the session's directory, detached, stdin /dev/null, stdout+stderr appended to RD_HOME/logs/headless-<rid>.log.
 *
 * Refused (`{ok: false, reason, message}`) when the review is finished or has no session, nothing is waiting, the
 * session's claude process is alive (the feedback should go through it), a headless run of the session is alive,
 * the working directory is gone, or the executable cannot be started. An invalid review id throws.
 * On success `meta.headless = {pid, startTime, startedAt, log}` is written; when the process ends, `exitedAt` and
 * `exitCode` are added (null when rd itself is gone by then: headlessStatus() still sees the process is dead).
 *
 * @param {string} reviewId
 * @param {object} [deps] config, spawn (child_process.spawn replacement), env
 * @returns {Promise<{ok: true, pid: number, startedAt: string, log: string, sessionId: string, cwd: string,
 *                    exited: Promise<{exitCode: number|null, signal: string|null}>}
 *                 | {ok: false, reason: string, message: string, error?: string}>}
 */
export async function startHeadless(reviewId, deps = {}) {
  assertReviewId(reviewId);
  const refuse = (reason, extra = {}) => ({ ok: false, reason, message: REFUSALS[reason] ?? reason, ...extra });
  const meta = getMeta(reviewId);
  if (isFinalStatus(meta.status)) return refuse('review-finished');
  if (!meta.sessionId) return refuse('no-session');
  if (!isSessionId(meta.sessionId)) return refuse('invalid-session-id');
  if (unreceived(readJson(paths.outbox(reviewId), [])).length === 0) return refuse('nothing-waiting');

  // One start at a time: two clicks (or two reviews of one session) must not launch two claude processes.
  return withLock(path.join(paths.home(), 'headless'), async () => {
    const session = getSession(meta.sessionId);
    if (sessionRunning(session)) return refuse(session.headless ? 'headless-running' : 'session-alive');
    if (liveHeadlessOf(meta.sessionId)) return refuse('headless-running');

    const info = resumeInfo(reviewId, deps);
    if (!info.cwd || !fs.statSync(info.cwd, { throwIfNoEntry: false })?.isDirectory()) return refuse('cwd-missing', { cwd: info.cwd });

    const env = { ...(deps.env ?? process.env) };
    for (const k of SCRUBBED_ENV) delete env[k];

    fs.mkdirSync(paths.logs(), { recursive: true, mode: 0o700 });
    const startedAt = nowIso();
    const logFd = fs.openSync(info.log, 'a', 0o600);
    let child;
    try {
      fs.writeSync(logFd, `\n=== ${startedAt} rd headless resume · review ${reviewId} · session ${info.sessionId} ===\n`);
      child = (deps.spawn ?? realSpawn)(info.headlessArgv[0], info.headlessArgv.slice(1), {
        cwd: info.cwd,
        detached: true, // its own process group: closing rd's terminal does not stop the run
        stdio: ['ignore', logFd, logFd], // stdin /dev/null: otherwise `claude -p` waits 3 s for input
        env,
      });
      // spawn() reports ENOENT / EACCES asynchronously.
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (err) {
      logLine('rd resume', `headless start failed for ${reviewId}: ${err.message}`, 'error');
      try {
        fs.writeSync(logFd, `rd: could not start ${info.headlessArgv[0]}: ${err.message}\n`);
      } catch {
        /* the log is a courtesy */
      }
      return refuse('spawn-failed', { error: err.message });
    } finally {
      fs.closeSync(logFd); // the child holds its own copy
    }

    child.unref();
    const pid = child.pid;
    const exited = new Promise((resolve) => {
      child.once('exit', async (code, signal) => {
        await recordExit(reviewId, pid, code, signal);
        resolve({ exitCode: code ?? null, signal: signal ?? null });
      });
    });
    const startTime = readProc(pid)?.startTime ?? null;
    await withReview(reviewId, (ctx) => {
      ctx.meta.headless = { pid, startTime, startedAt, log: info.log };
    });
    logLine('rd resume', `started headless resume for ${reviewId} (pid ${pid}, session ${info.sessionId})`);
    return { ok: true, pid, startedAt, log: info.log, sessionId: info.sessionId, cwd: info.cwd, exited };
  });
}

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? null : t;
};
const after = (iso, ref) => {
  const t = ms(iso);
  return t !== null && ref !== null && t > ref;
};

/**
 * When did the run end, as far as rd can tell (epoch ms, null when unknown)? rd's own exit record; failing that (rd was
 * closed while the run went on) the SessionEnd of the headless run itself, which is readable as long as the session record
 * still carries the run's `headless` flag.
 */
function runEnd(h, session) {
  return ms(h.exitedAt) ?? (session?.headless === true ? ms(session.endedAt) : null);
}

/**
 * Has anything happened since the run ended, so that its result is no longer what the review is waiting for? A finished /
 * failed run is only "the news" while nothing else touched the review; the TUI hides the headless status once this is true.
 * The rule (one for every case): a feedback entry queued or received after the end, or the session record changed state after
 * the end (the user resumed the session, it ran, it ended again - SessionStart, prompt-submit, Stop and SessionEnd all stamp `stateSince`).
 * When the end is unknown and the record no longer carries the run's `headless` flag, an interactive start (which clears the
 * flag) is detected by `stateSince` being newer than the run's start.
 */
function isSuperseded(h, session, outbox, end) {
  if (end !== null) {
    return after(session?.stateSince, end) || outbox.some((e) => after(e.at, end) || after(e.receivedAt, end));
  }
  return !!session && session.headless !== true && after(session.stateSince, ms(h.startedAt));
}

/**
 * State of the review's headless run, for the TUI's top bar. Read-only and cheap.
 *  running   the process is alive
 *  finished  it ended and (as far as known) did its job: exit code 0 / unknown and no feedback it should have taken is left
 *  failed    it ended with a non-zero exit code or a signal, or it ended without ever fetching the feedback
 * Only feedback queued before the run ended counts as "not taken": a comment sent after a successful run is a new situation
 * (channel C again), not a failure of that run.
 * `pending` counts the threads still waiting for an answer (a finished run that left some deserves a look at the log).
 * `superseded` is true for an ended run when something happened after its end (see isSuperseded): the TUI then hides the status.
 * @param {string} reviewId
 * @param {{meta?: object, session?: object|null}} [deps] meta / session: already loaded records (TUI poll)
 * @returns {null | {state: 'running'|'finished'|'failed', pid: number, startedAt: string, exitedAt: string|null,
 *                   exitCode: number|null, signal: string|null, log: string, pending: number, unreceived: number,
 *                   superseded: boolean}}
 */
export function headlessStatus(reviewId, deps = {}) {
  const meta = deps.meta ?? getMeta(assertReviewId(reviewId));
  const h = meta.headless;
  if (!h) return null;
  const running = !h.exitedAt && isSameProcessAlive({ pid: h.pid, startTime: h.startTime ?? null });
  const outbox = readJson(paths.outbox(meta.id), []);
  const threads = readJson(paths.threads(meta.id), []);
  const session = deps.session !== undefined ? deps.session : meta.sessionId ? getSession(meta.sessionId) : null;
  const end = runEnd(h, session);
  const waiting = unreceived(outbox);
  const untaken = end === null ? waiting.length : waiting.filter((e) => !after(e.at, end)).length;
  const pending = threads.filter(isPending).length;
  const exitCode = h.exitCode ?? null;
  const failed = !running && ((exitCode !== null && exitCode !== 0) || !!h.signal || untaken > 0);
  return {
    state: running ? 'running' : failed ? 'failed' : 'finished',
    pid: h.pid,
    startedAt: h.startedAt,
    exitedAt: h.exitedAt ?? null,
    exitCode,
    signal: h.signal ?? null,
    log: h.log,
    pending,
    unreceived: waiting.length,
    superseded: !running && isSuperseded(h, session, outbox, end),
  };
}

const oldestWaiting = (id) => unreceived(readJson(paths.outbox(id), [])).map((e) => e.at).sort()[0] ?? null;

/**
 * App-level "redeliver after a resume". When a session that was ended (channel C) with feedback waiting is alive and
 * idle again - the user resumed it with the [c] command - the feedback should not wait for the user's next message
 * if rd can type `/review-reply` for them: one `deliver(id, {whenIdle: true})` per resume (with an injector it types the
 * command; without one the call is a no-op and the feedback rides along with the next prompt, channel A).
 *
 * Pure logic with injectable parts, polled by the TUI like createWakeWatcher (src/tui/lib/wakeWatcher.js):
 *   const watcher = createResumeWatcher({ listReviews: () => metas });
 *   const done = await watcher.tick();   // [{sessionId, reviewId, result}] for the deliveries made in this run
 * A session counts as "was ended" once a tick saw one of its waiting reviews on channel C (a running headless run
 * stays on C), so a session that was already alive when the TUI started is never touched.
 *
 * @param {object} [deps]
 * @param {() => Array<{id: string, sessionId?: string, status?: string}>} [deps.listReviews]
 * @param {(id: string, d?: object) => {channel: string, sessionState?: string}} [deps.planDelivery]
 * @param {(id: string, opts: object) => Promise<object>} [deps.deliver]
 * @param {(id: string) => string|null} [deps.waitingSince] ISO time of the oldest unreceived outbox entry, null when none
 * @param {() => number} [deps.now]
 */
export function createResumeWatcher(deps = {}) {
  const listReviews = deps.listReviews ?? listMetas;
  const planOf = deps.planDelivery ?? planDelivery;
  const run = deps.deliver ?? deliver;
  const waitingSince = deps.waitingSince ?? oldestWaiting;
  const clock = deps.now ?? Date.now;
  /** sessionIds seen on channel C with feedback waiting */
  const wasEnded = new Set();
  let running = false;

  async function tick() {
    if (running) return [];
    running = true;
    try {
      const now = clock();
      /** sessionId -> {reviewId, since, plan} of the review waiting longest */
      const waiting = new Map();
      for (const m of listReviews()) {
        if (!m.sessionId || isFinalStatus(m.status)) continue;
        let since;
        let plan;
        try {
          since = waitingSince(m.id);
          if (!since) continue;
          plan = planOf(m.id, { now });
        } catch {
          continue; // vanished or half-written
        }
        const cur = waiting.get(m.sessionId);
        if (!cur || since < cur.since) waiting.set(m.sessionId, { reviewId: m.id, since, plan });
      }
      for (const sid of [...wasEnded]) if (!waiting.has(sid)) wasEnded.delete(sid); // delivered some other way

      const done = [];
      for (const [sid, w] of waiting) {
        if (w.plan.channel === 'C') {
          wasEnded.add(sid);
          continue;
        }
        if (!wasEnded.has(sid) || w.plan.channel === 'none') continue;
        if (w.plan.sessionState !== 'idle') continue; // busy: the Stop hook / next prompt hands it over; look again later
        wasEnded.delete(sid);
        let result;
        try {
          result = await run(w.reviewId, { whenIdle: true });
        } catch (err) {
          result = { action: 'failed', error: err?.message };
        }
        done.push({ sessionId: sid, reviewId: w.reviewId, result });
      }
      return done;
    } finally {
      running = false;
    }
  }

  return { tick };
}
