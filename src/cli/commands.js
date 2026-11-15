// Non-TUI commands. Each function returns data/prints; errors propagate to bin/rd.js.
import fs from 'node:fs';
import path from 'node:path';
import moment from 'moment';
import { getMeta, listMetas, readRevision } from '../store/reviews.js';
import { listThreads, pendingThreads, replyToThread, completeRound } from '../store/threads.js';
import { renderPrompt, renderJson } from '../feedback/index.js';
import { assertReviewId } from '../store/ids.js';
import { resolveSession } from '../delivery/session.js';

const sameProject = (metaCwd, cwd) =>
  !!metaCwd && (cwd === metaCwd || cwd.startsWith(metaCwd + path.sep) || metaCwd.startsWith(cwd + path.sep));

export function show(reviewId, opts) {
  const format = opts.format ?? 'prompt';
  if (!['prompt', 'json'].includes(format)) throw new Error(`unknown format: ${format}`);
  let metas;
  if (reviewId) {
    metas = [getMeta(assertReviewId(reviewId))];
  } else if (opts.pending) {
    const cwd = process.cwd();
    const waiting = listMetas()
      .filter((m) => m.status !== 'closed' && m.status !== 'approved')
      .filter((m) => pendingThreads(listThreads(m.id)).length > 0)
      .reverse(); // oldest first
    metas = waiting;
    if (!opts.all) {
      // Claude's own session (CLAUDE_CODE_SESSION_ID) first; the project directory only as fallback.
      const found = resolveSession();
      const mine = found ? waiting.filter((m) => m.sessionId === found.sessionId) : [];
      metas = mine.length > 0 ? mine : waiting.filter((m) => sameProject(m.cwd, cwd));
    }
    if (metas.length === 0) {
      process.stdout.write(format === 'json' ? '[]\n' : '(no pending reviews)\n');
      return;
    }
  } else {
    throw new Error('give a reviewId or --pending');
  }
  if (format === 'json') {
    const out = metas.map((m) => renderJson(m, listThreads(m.id)));
    process.stdout.write(JSON.stringify(reviewId ? out[0] : out, null, 2) + '\n');
  } else {
    process.stdout.write(metas.map((m) => renderPrompt(m, listThreads(m.id))).join('\n'));
  }
}

export async function reply(reviewId, threadId, text) {
  assertReviewId(reviewId);
  const body = text ?? fs.readFileSync(0, 'utf8');
  // A plan whose feedback the hook delivered with a deny: the answer belongs to that round, even when the user
  // has queued a follow-up since (that one is only seen with the next deny).
  const d = getMeta(reviewId).delivered;
  const opts = d && (d.threadIds ?? []).includes(threadId) ? { round: d.round } : {};
  const msg = await replyToThread(reviewId, threadId, body, opts);
  process.stdout.write(`replied ${threadId} (${msg.id})\n`);
}

export async function done(reviewId) {
  assertReviewId(reviewId);
  const r = await completeRound(reviewId);
  if (r.unanswered.length) {
    process.stderr.write(`warning: ${r.unanswered.length} thread(s) were sent but not answered: ${r.unanswered.join(', ')}\n`);
  }
  const queued = getMeta(reviewId).status === 'feedback_pending';
  process.stdout.write(`done ${reviewId}: ${r.answered} answered${queued ? ' (newer comments are waiting: they arrive with the next `rd await`)' : ''}\n`);
}

/** `rd deliver <reviewId> [--when-idle]`: carry out the delivery of the review's waiting feedback (internal). */
export async function deliverCommand(reviewId, opts = {}) {
  assertReviewId(reviewId);
  const { deliver } = await import('../delivery/index.js');
  const r = await deliver(reviewId, { whenIdle: !!opts.whenIdle });
  process.stdout.write(`deliver ${reviewId}: channel ${r.channel} (${r.reason}) · ${r.action}${r.error ? ` · ${r.error}` : ''}\n`);
}

/**
 * `rd resume <reviewId> [--headless] [--json]`: channel C from the command line. Without --headless it prints the command that
 * resumes the review's session in the user's own terminal; with it, rd resumes the session in the background to answer the
 * waiting feedback (log: RD_HOME/logs/headless-<id>.log).
 */
export async function resumeCommand(reviewId, opts = {}) {
  assertReviewId(reviewId);
  const { resumeInfo, startHeadless } = await import('../delivery/resume.js');
  if (!opts.headless) {
    const info = resumeInfo(reviewId);
    process.stdout.write(opts.json ? JSON.stringify(info, null, 2) + '\n' : info.interactive + '\n');
    return;
  }
  const r = await startHeadless(reviewId);
  if (!r.ok) throw new Error(`cannot resume headless: ${r.message}${r.error ? ` (${r.error})` : ''}`);
  const { exited, ...plain } = r;
  process.stdout.write(opts.json ? JSON.stringify(plain, null, 2) + '\n' : `started headless resume of session ${r.sessionId} (pid ${r.pid}); log: ${r.log}\n`);
}

export function list(opts) {
  let metas = listMetas();
  if (opts.status) metas = metas.filter((m) => m.status === opts.status);
  if (opts.json) {
    process.stdout.write(JSON.stringify(metas, null, 2) + '\n');
    return;
  }
  if (!metas.length) {
    process.stdout.write('(no reviews)\n');
    return;
  }
  for (const m of metas) {
    const pend = pendingThreads(listThreads(m.id)).length;
    process.stdout.write(
      [m.id, m.status.padEnd(16), `rev ${m.currentRevision}`, `pending ${pend}`, moment(m.updatedAt).fromNow(), m.title].join('  ') + '\n',
    );
  }
}

export { claudeConfigDir, runInstall, runUninstall } from './installCmd.js';

/** `rd doctor`: print the checklist; the exit code is 1 when something is broken. */
export async function runDoctor(opts) {
  const { doctorCommand } = await import('./doctor.js');
  const { exitCode } = await doctorCommand(opts);
  process.exitCode = exitCode;
}

/** `rd gc`: see gc.js. */
export async function runGc(opts) {
  const { gcCommand } = await import('./gc.js');
  await gcCommand(opts);
}
