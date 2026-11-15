// `rd install` / `rd uninstall`: merge rd into (or remove it from) Claude Code's settings.json.
// Writes only after explicit confirmation, always leaves a backup, and replaces the file atomically.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createTwoFilesPatch } from 'diff';
import { readJson, writeFileAtomic } from '../store/io.js';
import { stamp } from '../store/time.js';
import { listMetas } from '../store/reviews.js';
import { readSessions, isPidAlive } from '../store/sessions.js';
import { awaitingAlive, watcherAlive } from '../store/proc.js';
import { mergeSettings, unmergeSettings, isRdHookCommand, isRdStatusLine, ALLOW_RULES, DEFAULT_PREFIX } from './install.js';
import { renderSlashCommand, COMMAND_MARKER } from '../feedback/instructions.js';

export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/**
 * The Claude Code config directory a command works on: `--config-dir <dir>` (a project's `.claude` for a project-level install),
 * else `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Always absolute.
 */
export const resolveConfigDir = (opts = {}) => path.resolve(opts.configDir || claudeConfigDir());

/** Ask a yes/no question on the terminal; refuses to guess when there is no TTY. */
export async function askYesNo(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) throw new Error('cannot ask for confirmation: stdin is not a terminal (pass --yes to proceed)');
  const rl = readline.createInterface({ input, output });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function detectIndent(raw) {
  const m = /\n([ \t]+)"/.exec(raw ?? '');
  return m ? m[1] : 2;
}

/** Read settings.json (following a symlink, e.g. a dotfiles repo) and remember how it was formatted. */
function loadSettings(file) {
  let target = file;
  let raw = null;
  try {
    target = fs.realpathSync(file);
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const settings = raw === null ? {} : readJson(target, {});
  const mode = raw === null ? 0o600 : fs.statSync(target).mode & 0o777;
  return { target, settings, existed: raw !== null, indent: detectIndent(raw), mode };
}

function backupFile(file, existed) {
  if (!existed) return null;
  for (let i = 0; i < 100; i++) {
    const dest = `${file}.rd-backup-${stamp()}${i ? `-${i}` : ''}`;
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('could not create a backup file');
}

const writeSettings = (loaded, settings) =>
  writeFileAtomic(loaded.target, JSON.stringify(settings, null, loaded.indent) + '\n', { mode: loaded.mode });

export const slashCommandPath = (dir) => path.join(dir, 'commands', 'review-reply.md');

/**
 * State of <config dir>/commands/review-reply.md:
 *  missing  nothing there; install writes it
 *  current  rd wrote it and it is up to date
 *  outdated rd wrote it (marker line present) with older text; install refreshes it
 *  foreign  somebody else's file of that name; rd never overwrites or deletes it
 */
export function inspectSlashCommand(dir) {
  const file = slashCommandPath(dir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { file, state: 'missing' };
    throw err;
  }
  if (!text.includes(COMMAND_MARKER)) return { file, state: 'foreign' };
  return { file, state: text === renderSlashCommand() ? 'current' : 'outdated' };
}

function describeInstall(w, { file, loaded, report, localStatusLine, dir, prefix, command }) {
  w(`target: ${file}${loaded.existed ? '' : ' (does not exist yet)'}`);
  w(`backup: ${file}.rd-backup-<timestamp> (created on real install)`);
  w('');
  w('hooks to add:' + (report.hooksAdded.length ? '' : ' none'));
  report.hooksAdded.forEach((h) => w(`  + ${h}`));
  if (report.hooksUpdated.length) {
    w('hooks to update:');
    report.hooksUpdated.forEach((h) => w(`  ~ ${h}`));
  }
  if (report.hooksPresent.length) {
    w('hooks already present:');
    report.hooksPresent.forEach((h) => w(`  = ${h}`));
  }
  w('permissions.allow to add:' + (report.allowAdded.length ? '' : ' none'));
  report.allowAdded.forEach((r) => w(`  + ${r}`));
  w('statusLine:');
  w(
    {
      added: `  + statusLine: ${prefix} statusline (refreshInterval 2)`,
      updated: `  ~ statusLine command -> ${prefix} statusline`,
      present: `  = statusLine already set to ${prefix} statusline`,
      'kept-existing': '  ! existing statusLine kept; append $(rd statusline) to your script manually',
    }[report.statusLine] ?? '  (unchanged)',
  );
  if (report.statusLine === 'added' && localStatusLine) w('  ! settings.local.json defines statusLine and will override this one');
  w(
    {
      missing: `slash command: + ${command.file}`,
      outdated: `slash command: ~ ${command.file} (rd's own file, will be refreshed)`,
      current: `slash command: = ${command.file} (up to date)`,
      foreign: `slash command: ! ${command.file} exists and was not written by rd; left untouched (delete it and run rd install again to get /review-reply)`,
    }[command.state],
  );
}

const nothingToDo = (r, command) =>
  !r.hooksAdded.length && !r.hooksUpdated.length && !r.allowAdded.length && !['added', 'updated'].includes(r.statusLine) && !['missing', 'outdated'].includes(command.state);

/**
 * rd install [--dry-run] [--yes] [--hook-prefix <cmd>]
 * @param {object} opts { dryRun, yes, hookPrefix }
 * @param {object} [deps] { dir, confirm(question)->bool, out(line) } for tests
 * @returns {Promise<{changed:boolean, backup:string|null, file:string}>}
 */
export async function runInstall(opts = {}, deps = {}) {
  const dir = deps.dir ?? resolveConfigDir(opts);
  const out = deps.out ?? ((s) => process.stdout.write(s + '\n'));
  const confirm = deps.confirm ?? askYesNo;
  const prefix = opts.hookPrefix || DEFAULT_PREFIX;
  const file = path.join(dir, 'settings.json');

  const loaded = loadSettings(file);
  const { settings, report } = mergeSettings(loaded.settings, { prefix });
  const local = readJson(path.join(dir, 'settings.local.json'), {});
  const command = inspectSlashCommand(dir);

  out(opts.dryRun ? '# rd install --dry-run (nothing is written)' : '# rd install');
  describeInstall(out, { file, loaded, report, localStatusLine: !!local.statusLine, dir, prefix, command });

  if (opts.dryRun) {
    out('');
    out('merged settings.json would be:');
    out(JSON.stringify(settings, null, 2));
    return { changed: false, backup: null, file };
  }
  if (nothingToDo(report, command)) {
    out('');
    out('Already installed, nothing to do.');
    return { changed: false, backup: null, file };
  }
  out('');
  if (!opts.yes && !(await confirm(`Write these changes to ${file}?`))) {
    out('Aborted, nothing was written.');
    return { changed: false, backup: null, file };
  }
  const settingsChanged = JSON.stringify(settings) !== JSON.stringify(loaded.settings);
  const backup = settingsChanged ? backupFile(file, loaded.existed) : null;
  if (settingsChanged) {
    writeSettings(loaded, settings);
    out(`Wrote ${file}${backup ? ` (backup: ${backup})` : ''}`);
  }
  if (['missing', 'outdated'].includes(command.state)) {
    fs.mkdirSync(path.dirname(command.file), { recursive: true }); // default mode: it is Claude Code's directory
    writeFileAtomic(command.file, renderSlashCommand(), { mode: 0o644 });
    out(`Wrote ${command.file}`);
  }
  return { changed: true, backup, file, command: command.state };
}

/**
 * Processes that outlive the hooks: a plan-review hook blocking in a running Claude Code, an `rd await` waiting for
 * feedback, the wake-up watcher of a running session (`rd hook watch`). Uninstalling removes the settings entries only;
 * running processes are never signalled (a watcher ends with its session, or after Claude Code stops it at its timeout).
 */
export function liveProcesses({ metas = listMetas(), sessions = readSessions() } = {}) {
  const out = [];
  for (const m of metas) {
    if (m.kind === 'plan' && m.hook?.pid && m.status !== 'approved' && m.status !== 'closed' && isPidAlive(m.hook.pid)) {
      out.push(`plan review ${m.id} is waiting for your decision in a running hook (pid ${m.hook.pid})`);
    }
  }
  for (const s of Object.values(sessions)) {
    if (s.awaiting && awaitingAlive(s)) out.push(`session ${String(s.sessionId).slice(0, 8)} has a running \`rd await\` (pid ${s.awaiting.pid})`);
    if (s.watcher && watcherAlive(s)) out.push(`session ${String(s.sessionId).slice(0, 8)} has a running wake-up watcher (\`rd hook watch\`, pid ${s.watcher.pid})`);
  }
  return out;
}

/**
 * rd uninstall [--yes] [--dry-run] [--config-dir <dir>]: remove what rd install added (hooks of any prefix, allow rules,
 * rd's statusLine, rd's own /review-reply). Everything else in the file stays as it is, key order and indentation included.
 */
export async function runUninstall(opts = {}, deps = {}) {
  const dir = deps.dir ?? resolveConfigDir(opts);
  const out = deps.out ?? ((s) => process.stdout.write(s + '\n'));
  const confirm = deps.confirm ?? askYesNo;
  const file = path.join(dir, 'settings.json');

  const loaded = loadSettings(file);
  const cleaned = unmergeSettings(loaded.settings);
  const command = inspectSlashCommand(dir);
  const removeCommand = ['current', 'outdated'].includes(command.state); // never delete a file rd did not write
  const settingsChanged = JSON.stringify(cleaned) !== JSON.stringify(loaded.settings);
  if (!settingsChanged && !removeCommand) {
    out(`Nothing to remove from ${file}.`);
    if (command.state === 'foreign') out(`  ! ${command.file} was not written by rd; left untouched`);
    return { changed: false, backup: null, file };
  }

  out(opts.dryRun ? '# rd uninstall --dry-run (nothing is written)' : '# rd uninstall');
  out(`target: ${file}`);
  for (const [event, groups] of Object.entries(loaded.settings.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks ?? []) if (isRdHookCommand(h.command)) out(`  - hook ${event}: ${h.command}`);
  }
  for (const r of loaded.settings.permissions?.allow ?? []) if (ALLOW_RULES.includes(r)) out(`  - permission ${r}`);
  if (isRdStatusLine(loaded.settings.statusLine)) out(`  - statusLine: ${loaded.settings.statusLine.command}`);
  if (removeCommand) out(`  - slash command ${command.file}`);
  if (command.state === 'foreign') out(`  ! ${command.file} was not written by rd; left untouched`);
  let live = [];
  try {
    live = (deps.liveProcesses ?? liveProcesses)();
  } catch {
    /* an unreadable store must not block uninstalling */
  }
  for (const l of live) out(`  ! ${l}; uninstalling does not stop it`);
  if (opts.dryRun) {
    if (settingsChanged) {
      out('');
      out(createTwoFilesPatch(file, file, JSON.stringify(loaded.settings, null, loaded.indent) + '\n', JSON.stringify(cleaned, null, loaded.indent) + '\n', 'current', 'after uninstall', { context: 2 }).split('\n').filter((l) => !l.startsWith('Index: ') && !/^=+$/.test(l)).join('\n').trimEnd());
    }
    return { changed: false, backup: null, file };
  }
  out('');
  if (!opts.yes && !(await confirm(`Remove rd from ${dir}?`))) {
    out('Aborted, nothing was written.');
    return { changed: false, backup: null, file };
  }
  const backup = settingsChanged ? backupFile(file, loaded.existed) : null;
  if (settingsChanged) {
    writeSettings(loaded, cleaned);
    out(`Wrote ${file}${backup ? ` (backup: ${backup})` : ''}`);
  }
  if (removeCommand) {
    fs.rmSync(command.file, { force: true });
    out(`Removed ${command.file}`);
  }
  return { changed: true, backup, file };
}
