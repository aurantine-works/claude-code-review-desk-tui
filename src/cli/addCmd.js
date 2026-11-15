// `rd add <path> [--session <id>]` and the path form of `rd open <path>`: register any document for review, bound to the
// Claude Code session that wrote it (even when it lives outside the project or matches no glob).
//
//  - the path already has an active review -> that review (add prints its id, open opens it);
//  - the file must exist, be a regular text file (no NUL) of at most 2 MB;
//  - `--session <id>` binds that session (UUID form, or a session rd already knows) without any search;
//  - otherwise findWriters() looks for it (writes.jsonl, then a transcript scan): one candidate is bound; the last of several
//    writers recorded in writes.jsonl is bound (the others are kept for rebinding); several transcript matches need a
//    choice - in a terminal the interactive picker (src/tui/pickCandidate.js, when present), otherwise the candidates are
//    printed and the command ends with exit code 2 so the caller can repeat it with --session; none is an error.
import path from 'node:path';
import { canonicalPath, rdHome, paths } from '../store/paths.js';
import { getActiveReview } from '../store/docsIndex.js';
import { readJson } from '../store/io.js';
import { isFinalStatus } from '../store/outbox.js';
import { getSession, isSessionId } from '../store/sessions.js';
import { writersOf } from '../store/writes.js';
import { readDocText, registerManualDoc, isUuidSessionId } from '../store/docs.js';
import { findWriters, transcriptFileOf, readTranscriptHead, claudeConfigDirOf } from '../feedback/transcriptScan.js';

/** At most this many candidates are kept in `meta.writers` (the rebind list). */
const WRITERS_KEPT = 5;

export class NoWritersError extends Error {
  constructor(file, truncated = false) {
    super(`no Claude Code session found that wrote ${file}${truncated ? ' (the transcript scan stopped early)' : ''}; pass --session <id>`);
    this.code = 'no-writers';
  }
}

export class AmbiguousWritersError extends Error {
  constructor(file, candidates) {
    super(`${candidates.length} sessions wrote ${file}; choose one and repeat with --session <id>`);
    this.code = 'ambiguous-writers';
    this.file = file;
    this.candidates = candidates;
  }
}

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const toWriter = (c) => ({ sessionId: c.sessionId, cwd: c.cwd ?? null, project: c.project ?? '', lastAt: c.lastAt ?? null, firstPrompt: c.firstPrompt ?? '', source: c.source });

/** Active review of a path (docs-index entry whose review exists and is not finished), or null. */
function activeReviewOf(abs) {
  const id = getActiveReview(abs);
  if (!id) return null;
  const meta = readJson(paths.meta(id), null);
  return meta && !isFinalStatus(meta.status) ? meta : null;
}

/** The pick function for an interactive terminal, or null (not a TTY, or the picker component is not installed). */
export async function loadPicker({ stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) return null;
  try {
    return (await import('../tui/pickCandidate.js')).pickCandidate ?? null;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/** An explicitly named session: its record (or transcript) gives the directory; the other writers of the file are listed too. */
async function explicitSession(sessionId, abs, configDir) {
  if (!isSessionId(sessionId) || !(isUuidSessionId(sessionId) || getSession(sessionId))) {
    throw new Error(`invalid session id: ${JSON.stringify(sessionId)} (expected a Claude Code session UUID)`);
  }
  const rec = getSession(sessionId);
  const file = rec?.transcriptPath ?? (await transcriptFileOf(sessionId, configDir));
  const head = file ? await readTranscriptHead(file) : { firstPrompt: null, cwd: null };
  const cwd = rec?.cwd ?? head.cwd ?? path.dirname(abs);
  const chosen = { sessionId, cwd, project: path.basename(cwd), lastAt: rec?.updatedAt ?? null, firstPrompt: head.firstPrompt ?? '', source: 'explicit' };
  const others = [];
  for (const w of writersOf(abs)) {
    if (w.sessionId === sessionId || others.some((o) => o.sessionId === w.sessionId) || !isSessionId(w.sessionId)) continue;
    const cwd2 = getSession(w.sessionId)?.cwd ?? w.cwd ?? null;
    others.push({ sessionId: w.sessionId, cwd: cwd2, project: cwd2 ? path.basename(cwd2) : '', lastAt: w.at, firstPrompt: '', source: 'writes' });
  }
  return { chosen, writers: [chosen, ...others].slice(0, WRITERS_KEPT) };
}

/**
 * Register (or find) the review of a document.
 * @param {string} rawPath  absolute, or relative to `cwd`
 * @param {object} [opts]
 * @param {string} [opts.session]  bind this session without searching
 * @param {(candidates: object[], info: {path: string}) => Promise<object|null>} [opts.pick]  chooser for several candidates
 * @param {string} [opts.cwd]      base of a relative path (default: the process directory)
 * @param {string} [opts.configDir]  Claude config dir for the transcript scan (default CLAUDE_CONFIG_DIR or ~/.claude)
 * @param {object} [opts.scan]     findWriters options (limit, maxFiles, budgetMs, now) - tests
 * @returns {Promise<{id: string, created: boolean, path: string, sessionId: string|null, cwd: string|null}>}
 * @throws NoWritersError (code 'no-writers'), AmbiguousWritersError (code 'ambiguous-writers', `.candidates`), or a plain
 *         Error for a missing / too large / binary file, an invalid session id, a cancelled choice
 */
export async function resolveDocument(rawPath, opts = {}) {
  if (typeof rawPath !== 'string' || rawPath === '' || rawPath.includes('\0')) throw new Error('give the path of a document');
  const abs = canonicalPath(path.resolve(opts.cwd ?? process.cwd(), rawPath));
  if (inside(abs, canonicalPath(rdHome()))) throw new Error(`refusing to review rd's own state: ${abs}`);

  const existing = activeReviewOf(abs);
  if (existing) return { id: existing.id, created: false, path: abs, sessionId: existing.sessionId ?? null, cwd: existing.cwd ?? null };

  const content = readDocText(abs); // exists, regular, <= 2 MB, text
  const configDir = opts.configDir ?? claudeConfigDirOf();

  let chosen;
  let writers;
  if (opts.session !== undefined) {
    ({ chosen, writers } = await explicitSession(opts.session, abs, configDir));
  } else {
    const found = await findWriters(abs, { limit: 10, configDir, ...opts.scan });
    if (found.length === 0) throw new NoWritersError(abs, found.truncated === true);
    // writes.jsonl is exact: several writers mean the file was written by several sessions, and the default is the last
    // writer; the others stay available in meta.writers for rebinding. Only transcript matches are guesses.
    if (found.length === 1 || found[0].source === 'writes') chosen = found[0];
    else if (opts.pick) {
      chosen = await opts.pick(found, { path: abs });
      if (!chosen) throw new Error('cancelled');
      chosen = found.find((c) => c.sessionId === chosen.sessionId);
      if (!chosen) throw new Error('the chosen session is not one of the candidates');
    } else {
      throw new AmbiguousWritersError(abs, found);
    }
    writers = [chosen, ...found.filter((c) => c !== chosen)].slice(0, WRITERS_KEPT).map(toWriter);
  }

  const r = await registerManualDoc({ docPath: abs, content, sessionId: chosen.sessionId, cwd: chosen.cwd ?? path.dirname(abs), writers });
  return { id: r.id, created: r.action === 'created', path: abs, sessionId: chosen.sessionId, cwd: chosen.cwd ?? path.dirname(abs) };
}

/**
 * The non-interactive answer to "several sessions wrote this": the candidates on stdout, one per line, tab separated
 * `sessionId  lastAt  project  firstPrompt` (or a JSON array with `json`), the instruction on stderr; exit code 2.
 */
export function reportAmbiguous(err, { json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  stderr.write(`rd: ${err.message}\n`);
  if (json) stdout.write(JSON.stringify(err.candidates, null, 2) + '\n');
  else for (const c of err.candidates) stdout.write([c.sessionId, c.lastAt ?? '', c.project ?? '', (c.firstPrompt ?? '').replace(/[\t\n]+/g, ' ')].join('\t') + '\n');
  process.exitCode = 2;
}

/** `rd add <path> [--session <id>] [--json]` */
export async function addCommand(rawPath, opts = {}, deps = {}) {
  let r;
  try {
    r = await resolveDocument(rawPath, { session: opts.session, pick: deps.pick ?? (await loadPicker()), ...deps.resolve });
  } catch (err) {
    if (err?.code === 'ambiguous-writers') return reportAmbiguous(err, { json: opts.json });
    throw err;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  process.stdout.write(r.created ? `registered ${r.id} (session ${r.sessionId}) ${r.path}\n` : `already registered: ${r.id} ${r.path}\n`);
}
