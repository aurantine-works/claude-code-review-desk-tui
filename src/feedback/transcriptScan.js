// Which Claude Code session wrote a file? (`rd add <path>`, `rd open <path>`)
//
// 1. writes.jsonl: the post-tool-use hook records every Write / Edit / MultiEdit with its session, so a file written
//    that way has an exact answer, newest writer first.
// 2. Otherwise (the file came from a Bash command: `cat > reports/x.md`, a script, `cp`), the transcripts under
//    <CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/*.jsonl are scanned for assistant tool_use blocks whose input mentions the
//    path. Read-only: nothing under ~/.claude is ever written.
//
// Transcript format (Claude Code 2.1.322, see src/feedback/transcript.js): one JSON object per line; an assistant record has
// `message.content[]` blocks, `{type:'tool_use', name, input}` among them; every record carries `cwd`, `sessionId`,
// `timestamp`; `api-request-blob` records duplicate conversation content and must be ignored; sidechain (subagent) turns are
// `isSidechain: true`; a typed prompt is a `user` record with a string `message.content` (tool results are arrays).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath } from '../store/paths.js';
import { writersOf } from '../store/writes.js';
import { getSession, isSessionId } from '../store/sessions.js';

export const SCAN_MAX_FILES = 200;
export const SCAN_BUDGET_MS = 5000;
/** Only transcripts modified at most this long before the document's own mtime can have written it. */
export const SCAN_WINDOW_MS = 10 * 60 * 1000;
const HEAD_MAX_BYTES = 4 * 1024 * 1024;
const FIRST_PROMPT_CHARS = 80;
/** Tools that only read: a session that merely looked at a file did not write it. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch', 'TodoWrite']);

export const claudeConfigDirOf = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ---------------------------------------------------------------------------------------------
// Path mentions inside a tool_use input
// ---------------------------------------------------------------------------------------------

const PATH_CHAR = /[A-Za-z0-9_.~/-]/;
const WORD_CHAR = /[A-Za-z0-9_-]/;

/**
 * Does `text` mention `needle` as a path of its own (not as the tail of a longer path or the head of a longer file name)?
 * `./reports/x.md` counts as a mention of `reports/x.md`; `my-reports/x.md`, `/a/reports/x.md` and `x.md.bak` do not.
 */
export function containsPath(text, needle) {
  if (typeof text !== 'string' || !needle) return false;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const before = i === 0 ? '' : text[i - 1];
    const after = text[i + needle.length] ?? '';
    const dotSlash = before === '/' && text[i - 2] === '.' && (i < 3 || !PATH_CHAR.test(text[i - 3]));
    const startsOk = before === '' || !PATH_CHAR.test(before) || dotSlash;
    const endsOk = after === '' || (!WORD_CHAR.test(after) && !(after === '.' && /[A-Za-z0-9]/.test(text[i + needle.length + 1] ?? '')));
    if (startsOk && endsOk) return true;
  }
  return false;
}

/** All strings inside a JSON value (tool inputs are small objects; depth and count are bounded). */
function* stringsOf(value, depth = 0) {
  if (typeof value === 'string') yield value;
  else if (depth < 5 && value && typeof value === 'object') {
    let n = 0;
    for (const v of Array.isArray(value) ? value : Object.values(value)) {
      if (++n > 100) return;
      yield* stringsOf(v, depth + 1);
    }
  }
}

/** The spellings of `abs` a command may use: absolute, relative to the record's cwd, `~/…`, `$HOME/…`. */
export function pathForms(abs, cwd, home = os.homedir()) {
  const forms = new Set([abs]);
  if (cwd && path.isAbsolute(cwd)) {
    const rel = path.relative(cwd, abs);
    if (rel && !path.isAbsolute(rel)) forms.add(rel);
  }
  if (home && abs.startsWith(home + '/')) {
    const rest = abs.slice(home.length + 1);
    forms.add(`~/${rest}`);
    forms.add(`$HOME/${rest}`);
    forms.add(`\${HOME}/${rest}`);
  }
  return [...forms];
}

/**
 * Does a tool_use block mention the file? Any string of its input counts: the absolute path, a relative spelling (relative to
 * the record's cwd), a `~/` spelling, or the file's directory together with its name (`cd /dir && cat > x.md`).
 * Read-only tools never count.
 */
export function toolUseMentions(block, abs, cwd, home) {
  if (!block || block.type !== 'tool_use' || READ_ONLY_TOOLS.has(block.name)) return false;
  const forms = pathForms(abs, cwd, home);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  for (const s of stringsOf(block.input)) {
    if (!s.includes(base)) continue;
    if (forms.some((f) => containsPath(s, f))) return true;
    if (containsPath(s, dir) && containsPath(s, base)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Transcript records
// ---------------------------------------------------------------------------------------------

const tryParse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** The first prompt of a user record as a one-line label, or null when the record is not a typed prompt. */
export function promptLabel(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ') : '';
  if (typeof c !== 'string' && Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return null;
  text = text.trim();
  if (!text || text.startsWith('<local-command') || text.startsWith('<system-reminder') || text.startsWith('<task-notification')) return null;
  const cmd = /^<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text);
  if (cmd) text = `${cmd[1]} ${/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''}`;
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > FIRST_PROMPT_CHARS ? `${chars.slice(0, FIRST_PROMPT_CHARS - 1).join('')}…` : text;
}

/**
 * First typed prompt and launch directory of a transcript, read from its head (at most 4 MB; a transcript starts with a few
 * bookkeeping records and the first prompt). `{firstPrompt: null, cwd: null}` when the file cannot be read.
 */
export async function readTranscriptHead(file) {
  const out = { firstPrompt: null, cwd: null };
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    let carry = '';
    let pos = 0;
    while (pos < HEAD_MAX_BYTES && (out.firstPrompt === null || out.cwd === null)) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      carry += buf.toString('utf8', 0, bytesRead);
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const wantsPrompt = out.firstPrompt === null && line.includes('"user"');
        const wantsCwd = out.cwd === null && line.includes('"cwd"');
        if (!wantsPrompt && !wantsCwd) continue;
        const rec = tryParse(line);
        if (!rec) continue;
        if (out.cwd === null && typeof rec.cwd === 'string' && rec.cwd.startsWith('/')) out.cwd = rec.cwd;
        if (out.firstPrompt === null) out.firstPrompt = promptLabel(rec);
        if (out.firstPrompt !== null && out.cwd !== null) break;
      }
    }
  } catch {
    /* unreadable: leave what we have */
  } finally {
    await fh?.close().catch(() => {});
  }
  return out;
}

// The transcript file <config>/projects/<project dir>/<sessionId>.jsonl, or null. Read-only directory listing.
export async function transcriptFileOf(sessionId, configDir = claudeConfigDirOf()) {
  if (!isSessionId(sessionId)) return null;
  const root = path.join(configDir, 'projects');
  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, d.name, `${sessionId}.jsonl`);
    try {
      if ((await fs.promises.stat(file)).isFile()) return file;
    } catch {
      /* not in this project */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

/** Mentions of the file in one transcript's text: the newest matching assistant record, or null. */
export function scanText(text, abs, { home, fallbackSessionId } = {}) {
  const base = path.basename(abs);
  let hit = null;
  for (const line of text.split('\n')) {
    if (!line.includes(base) || !line.includes('tool_use')) continue; // cheap pre-filter before JSON.parse
    const rec = tryParse(line);
    if (!rec || rec.type !== 'assistant' || rec.isSidechain || !Array.isArray(rec.message?.content)) continue;
    if (!rec.message.content.some((b) => toolUseMentions(b, abs, rec.cwd, home))) continue;
    hit = { sessionId: rec.sessionId ?? fallbackSessionId, cwd: typeof rec.cwd === 'string' ? rec.cwd : null, lastAt: rec.timestamp ?? null };
  }
  return hit;
}

const projectOf = (cwd) => (cwd ? path.basename(cwd) || cwd : '');

async function listTranscripts(configDir) {
  const root = path.join(configDir, 'projects');
  const files = [];
  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names;
    try {
      names = await fs.promises.readdir(path.join(root, d.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, d.name, name);
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile()) files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Scan transcripts for sessions that mention the file in a tool_use.
 * Transcripts modified more than `windowMs` before the file's own mtime are skipped first (they cannot have written it); only
 * when that finds nothing are the older ones tried too (the file may have been edited by hand long after Claude wrote it).
 * The whole scan reads at most `maxFiles` transcripts within `budgetMs`; `truncated` says it stopped early.
 * @returns {Promise<{candidates: object[], truncated: boolean, scanned: number}>} candidates newest first, with `transcriptPath`
 */
export async function scanTranscripts(abs, opts = {}) {
  const { configDir = claudeConfigDirOf(), maxFiles = SCAN_MAX_FILES, budgetMs = SCAN_BUDGET_MS, windowMs = SCAN_WINDOW_MS, home } = opts;
  const clock = opts.now ?? Date.now;
  const started = clock();
  let docMtime = null;
  try {
    docMtime = fs.statSync(abs).mtimeMs;
  } catch {
    /* the file is gone: no time filter */
  }
  const all = await listTranscripts(configDir);
  const recent = docMtime === null ? all : all.filter((f) => f.mtimeMs >= docMtime - windowMs);
  const older = docMtime === null ? [] : all.filter((f) => f.mtimeMs < docMtime - windowMs);

  const needle = Buffer.from(path.basename(abs));
  const found = new Map(); // sessionId -> candidate
  let scanned = 0;
  let truncated = false;
  const pass = async (files) => {
    for (const f of files) {
      if (scanned >= maxFiles || clock() - started > budgetMs) {
        truncated = true;
        return;
      }
      scanned++;
      let buf;
      try {
        buf = await fs.promises.readFile(f.file);
      } catch {
        continue;
      }
      if (!buf.includes(needle)) continue; // nothing in this file can mention the path
      const sid = path.basename(f.file, '.jsonl');
      const hit = scanText(buf.toString('utf8'), abs, { home, fallbackSessionId: sid });
      if (!hit || !isSessionId(hit.sessionId)) continue;
      const prev = found.get(hit.sessionId);
      if (!prev || (hit.lastAt ?? '') > (prev.lastAt ?? '')) found.set(hit.sessionId, { ...hit, transcriptPath: f.file });
    }
  };
  await pass(recent);
  if (found.size === 0 && !truncated) await pass(older);

  const candidates = [...found.values()].sort((a, b) => ((a.lastAt ?? '') < (b.lastAt ?? '') ? 1 : -1));
  return { candidates, truncated, scanned };
}

// ---------------------------------------------------------------------------------------------
// findWriters
// ---------------------------------------------------------------------------------------------

/**
 * The sessions that wrote `absPath`, newest first.
 *
 * writes.jsonl first (every writer of that path, the last writer first); when it knows nothing, the transcripts are scanned
 * (see the header and scanTranscripts). A candidate:
 *   { sessionId, cwd, project, lastAt, firstPrompt, source: 'writes' | 'transcript', transcriptPath? }
 * `cwd` is the directory the session was started in (registry record or the transcript's first record), which is where
 * `claude --resume` must run; `project` its base name; `firstPrompt` the first typed prompt (80 characters at most).
 * The returned array has `truncated: true` set when the transcript scan ran out of budget (200 files / 5 s).
 *
 * @param {string} absPath
 * @param {{limit?: number, configDir?: string, maxFiles?: number, budgetMs?: number, now?: () => number, home?: string}} [opts]
 * @returns {Promise<Array<object> & {truncated?: boolean}>}
 */
export async function findWriters(absPath, opts = {}) {
  const { limit = 10, configDir = claudeConfigDirOf() } = opts;
  const abs = canonicalPath(absPath);
  let base;
  let truncated = false;

  const written = new Map();
  for (const w of writersOf(abs)) if (isSessionId(w.sessionId) && !written.has(w.sessionId)) written.set(w.sessionId, w);
  if (written.size > 0) {
    base = [...written.values()].map((w) => ({ sessionId: w.sessionId, cwd: w.cwd ?? null, lastAt: w.at, source: 'writes', transcriptPath: getSession(w.sessionId)?.transcriptPath ?? null }));
  } else {
    const r = await scanTranscripts(abs, { ...opts, configDir });
    truncated = r.truncated;
    base = r.candidates.map((c) => ({ ...c, source: 'transcript' }));
  }

  const out = [];
  for (const c of base.slice(0, limit)) {
    let file = c.transcriptPath;
    if (!file || !fs.existsSync(file)) file = await transcriptFileOf(c.sessionId, configDir);
    const head = file ? await readTranscriptHead(file) : { firstPrompt: null, cwd: null };
    // The directory the session was started in (the registry's SessionStart cwd, else the transcript's first record) is where
    // `claude --resume` finds it; the cwd of the matching write may have moved on with a `cd`.
    const cwd = getSession(c.sessionId)?.cwd ?? head.cwd ?? c.cwd ?? null;
    out.push({
      sessionId: c.sessionId,
      cwd,
      project: projectOf(cwd),
      lastAt: c.lastAt,
      firstPrompt: head.firstPrompt ?? '',
      source: c.source,
      ...(file ? { transcriptPath: file } : {}),
    });
  }
  if (truncated) out.truncated = true;
  return out;
}
