// PostToolUse(Write|Edit|MultiEdit): record every write unconditionally, then register documents.
//
//  - every write goes to writes.jsonl (the answer to "which session wrote this file");
//  - a file that already has an active review gets a new revision (writes of one turn merge), whatever its path;
//  - otherwise a file matching docs.include and not docs.exclude (minimatch, dot files included, matched
//    against the absolute path) becomes a new doc review bound to the session. Files over 2 MB are never registered.
// Writes made inside a subagent carry the main session_id, so they register to the main session.
//
// Exception: Claude Code's own plan files (<config dir>/plans/*.md). Plan mode writes them on every
// plan, and they are reviewed through the ExitPlanMode hook, not as documents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordWrite } from '../store/writes.js';
import { isSessionId, getSession } from '../store/sessions.js';
import { canonicalPath, rdHome } from '../store/paths.js';
import { getActiveReview } from '../store/docsIndex.js';
import { logLine } from '../store/log.js';

export const MAX_DOC_BYTES = 2 * 1024 * 1024;

/** Is `file` inside <CLAUDE_CONFIG_DIR or ~/.claude>/plans/ ? */
export function isClaudePlanFile(file, env = process.env, home = os.homedir()) {
  const plansDir = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plans');
  const inside = (p, dir) => p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  // Compare both the literal and the symlink-resolved spelling (plans/ is often a symlinked dotfile dir).
  return inside(path.resolve(file), path.resolve(plansDir)) || inside(canonicalPath(file), canonicalPath(plansDir));
}

/** `*.md` -> '.md'; null when the glob's last segment does not end in a plain literal extension. */
const literalExt = (glob) => /\.([A-Za-z0-9]+)$/.exec(glob.slice(glob.lastIndexOf('/') + 1))?.[0].toLowerCase() ?? null;

/**
 * Does `file` (absolute) count as a document to review automatically?
 * minimatch costs ~12 ms to load, so a file whose extension no include glob can match is rejected first.
 */
export async function matchesDocGlobs(file, docs = {}) {
  const include = Array.isArray(docs.include) ? docs.include : [];
  const exclude = Array.isArray(docs.exclude) ? docs.exclude : [];
  if (include.length === 0) return false;
  const exts = include.map(literalExt);
  if (!exts.includes(null) && !exts.includes(path.extname(file).toLowerCase())) return false;
  const { minimatch } = await import('minimatch');
  const opts = { dot: true };
  return include.some((g) => minimatch(file, g, opts)) && !exclude.some((g) => minimatch(file, g, opts));
}

export default async function postToolUse(input, deps = {}) {
  const sid = input?.session_id;
  const file = input?.tool_input?.file_path;
  if (!isSessionId(sid) || typeof file !== 'string' || !file) return;
  const cwd = input.cwd || process.cwd();
  const abs = path.resolve(cwd, file); // relative paths are relative to the session's cwd, not ours
  if (isClaudePlanFile(abs, deps.env ?? process.env, deps.home)) return;
  recordWrite({
    path: abs,
    sessionId: sid,
    cwd,
    tool: input.tool_name,
    // Subagents report the main session_id; agent_id tells them apart (absent for the main agent).
    ...(typeof input.agent_id === 'string' ? { agentId: input.agent_id } : {}),
  });

  try {
    await registerDocument({ abs, sid, cwd, tool: input.tool_name }, deps);
  } catch (err) {
    logLine('hook post-tool-use', err); // the write is recorded; registration is best effort
  }
}

async function registerDocument({ abs, sid, cwd, tool }, deps) {
  const canonical = canonicalPath(abs);
  const home = canonicalPath(rdHome());
  if (canonical === home || canonical.startsWith(home + path.sep)) return; // never review our own state

  const active = getActiveReview(canonical);
  let autoRegister = false;
  if (!active) {
    const config = deps.config ?? (await import('../config.js')).loadConfig();
    autoRegister = await matchesDocGlobs(canonical, config.docs);
    if (!autoRegister) return;
  }

  let content;
  try {
    if (fs.statSync(canonical).size > MAX_DOC_BYTES) return;
    content = fs.readFileSync(canonical, 'utf8');
  } catch (err) {
    logLine('hook post-tool-use', `cannot read ${canonical}: ${err.message}`, 'error');
    return;
  }
  const { registerDocWrite } = await import('../store/docs.js');
  await registerDocWrite({ docPath: canonical, content, sessionId: sid, cwd, tool, turn: getSession(sid)?.turn ?? 0, autoRegister });
}
