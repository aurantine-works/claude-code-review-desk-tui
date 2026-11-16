// `rd doctor`: a read-only checklist of everything Review Desk depends on.
//
//   ✓ fine   ! works but degraded / worth a look   ✗ broken   · information only
//
// Exit code 1 when something is ✗. `--json` prints the same checks as data. The only writes are `--fix`'s two repairs:
// a session that is registered as live but whose claude process is gone is marked `ended`, and an `awaiting` / `watcher` record
// whose process (`rd await`, the wake-up watcher) is gone is cleared. Everything else (permissions, stale locks, ...) is reported with the command that
// repairs it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { paths, rdHome } from '../store/paths.js';
import { readJson } from '../store/io.js';
import { readSessions, updateSession, isPidAlive } from '../store/sessions.js';
import { awaitingAlive, watcherAlive } from '../store/proc.js';
import { nowIso } from '../store/time.js';
import { loadConfigChecked } from '../config.js';
import { HOOK_SPECS, WATCH_SPECS, ALLOW_RULES, isRdHookCommand, isRdStatusLine } from './install.js';
import { inspectSlashCommand, claudeConfigDir } from './installCmd.js';
import { whichSync, run } from '../delivery/adapters/util.js';
import { t, hasPack } from '../i18n/index.js';

/** The Claude Code version this release of rd was verified against (see the README section "Verified versions"). */
export const VERIFIED_CLAUDE_VERSION = '2.1.325';
export const MIN_NODE_MAJOR = 22;

const STALE_LOCK_MS = 10_000; // withLock() uses proper-lockfile with stale: 10000
const ERROR_WINDOW_MS = 24 * 3600 * 1000;
const LOG_TAIL_BYTES = 512 * 1024;
const PLAN_REVIEW_MIN_TIMEOUT = 3600;
const WATCH_MIN_TIMEOUT = 3600;

const PKG_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PKG_BIN = path.join(PKG_ROOT, 'bin', 'rd.js');

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const tilde = (p) => (process.env.HOME && p.startsWith(process.env.HOME + path.sep) ? `~${p.slice(process.env.HOME.length)}` : p);
const list = (items, max = 6) => (items.length > max ? [...items.slice(0, max), `... and ${items.length - max} more`] : items);

/** @typedef {{id: string, group: string, status: 'ok'|'warn'|'fail'|'info', title: string, detail?: string[], fix?: string|null, fixed?: boolean}} Check */

const check = (group, id, status, title, { detail = [], fix = null, fixed = false } = {}) => ({
  id,
  group,
  status,
  title,
  ...(detail.length ? { detail } : {}),
  ...(fix ? { fix } : {}),
  ...(fixed ? { fixed: true } : {}),
});

// ---------------------------------------------------------------------------------------------------------------------
// Claude Code settings

/** Read a settings file: {state: 'missing'|'ok'|'invalid', settings, error}. Follows symlinks. */
export function readSettingsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing', settings: {} };
    return { state: 'invalid', settings: {}, error: err.message };
  }
  try {
    const settings = JSON.parse(raw);
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return { state: 'invalid', settings: {}, error: 'not a JSON object' };
    return { state: 'ok', settings };
  } catch (err) {
    return { state: 'invalid', settings: {}, error: err.message };
  }
}

/** The rd hook entries registered for one event: [{command, matcher, timeout, type, asyncRewake}]. */
function rdEntries(settings, spec) {
  const groups = Array.isArray(settings.hooks?.[spec.event]) ? settings.hooks[spec.event] : [];
  const out = [];
  for (const g of groups) {
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (isRdHookCommand(h?.command) && h.command.endsWith(` hook ${spec.sub}`)) {
        out.push({ command: h.command, matcher: g.matcher ?? null, timeout: h.timeout ?? null, type: h.type ?? null, asyncRewake: h.asyncRewake ?? null });
      }
    }
  }
  return out;
}

/** How much of rd is in a settings object. */
export function inspectSettings(settings) {
  const events = HOOK_SPECS.map((spec) => ({ spec, entries: rdEntries(settings, spec) }));
  const watch = WATCH_SPECS.map((spec) => ({ spec, entries: rdEntries(settings, spec) }));
  const installed = events.filter((e) => e.entries.length > 0);
  const prefixes = [...new Set([...installed, ...watch].flatMap((e) => e.entries.map((x) => x.command.slice(0, x.command.length - ` hook ${e.spec.sub}`.length))))];
  return { events, watch, installedCount: installed.length, prefixes };
}

/** A prefix such as `node /abs/bin/rd.js` names files; are they there? */
function missingPrefixFiles(prefix) {
  return prefix
    .split(/\s+/)
    .filter((tok) => path.isAbsolute(tok) && /\.[cm]?js$/.test(tok))
    .filter((tok) => !fs.existsSync(tok));
}

/**
 * The two `rd hook watch` entries (SessionStart and Stop). Missing: ! (the old behaviour, comments need /review-reply while the
 * session is idle). Present without `asyncRewake: true`: ✗, Claude Code would run the watcher in the foreground and wait for it
 * (up to its timeout) at the end of every turn. A timeout below an hour: ! (the watcher is stopped, and only the next Stop re-arms it).
 * @param {Array<{spec: object, entries: object[]}>} watch inspectSettings().watch
 */
function watchCheck(group, watch, installCmd) {
  const events = watch.map((e) => e.spec.event);
  const missing = watch.filter((e) => e.entries.length === 0).map((e) => e.spec.event);
  const consequence = 'Comments sent while the Claude session is idle then need /review-reply typed in Claude (or arrive with your next message).';
  if (missing.length === watch.length) {
    return check(group, 'watch-hooks', 'warn', 'automatic wake-up is not installed (no `rd hook watch` entries)', {
      detail: [consequence, 'Older installations lack it; Claude Code 2.1.325 or newer supports `asyncRewake` hooks.'],
      fix: installCmd,
    });
  }
  const bad = [];
  const slow = [];
  const extra = [];
  for (const e of watch) {
    if (e.entries.length > 1) extra.push(`${e.spec.event}: registered ${e.entries.length} times (each Stop would start ${e.entries.length} watchers; one wins, the others exit at once)`);
    for (const x of e.entries) {
      if (x.asyncRewake !== true) bad.push(`${e.spec.event}: \`${x.command}\` has no "asyncRewake": true, so Claude Code runs it in the foreground and waits for it`);
      if (x.timeout === null || x.timeout < WATCH_MIN_TIMEOUT) slow.push(`${e.spec.event}: timeout is ${x.timeout === null ? 'not set (Claude Code default: 600 s)' : `${x.timeout} s`}; the watcher is stopped then and only the next Stop starts a new one`);
    }
  }
  if (bad.length) return check(group, 'watch-hooks', 'fail', 'the `rd hook watch` entries are not background hooks', { detail: bad, fix: `${installCmd} (repairs them)` });
  if (missing.length) return check(group, 'watch-hooks', 'warn', `automatic wake-up: ${events.length - missing.length} of ${events.length} events registered`, { detail: [`missing: ${missing.join(', ')}`, consequence], fix: installCmd });
  if (slow.length || extra.length) return check(group, 'watch-hooks', 'warn', 'automatic wake-up is installed, with problems', { detail: [...slow, ...extra], fix: `${installCmd} (repairs the timeout)` });
  return check(group, 'watch-hooks', 'ok', `automatic wake-up: ${events.join(' + ')} (asyncRewake, timeout ${watch[0].entries[0].timeout} s)`);
}

/**
 * Checks for one settings location (the caller reports "rd is not installed here" when `info.installedCount` is 0).
 * @param {{label: string, dir: string, installArgs: string}} scope
 */
function settingsChecks(group, scope, read) {
  const out = [];
  const file = path.join(scope.dir, 'settings.json');
  if (read.state === 'invalid') {
    out.push(check(group, 'settings-json', 'fail', `${tilde(file)} is not valid JSON`, { detail: [read.error], fix: 'Fix or remove the file: Claude Code ignores a settings file it cannot parse, so no hook runs.' }));
    return { checks: out, info: null };
  }
  const info = inspectSettings(read.settings);
  if (info.installedCount === 0) return { checks: out, info };

  // hooks
  const missing = info.events.filter((e) => e.entries.length === 0).map((e) => e.spec.event);
  const problems = [];
  for (const e of info.events) {
    if (e.entries.length > 1) problems.push(`${e.spec.event}: registered ${e.entries.length} times (the hook would run ${e.entries.length} times)`);
    for (const x of e.entries) {
      if (x.type && x.type !== 'command') problems.push(`${e.spec.event}: hook type is "${x.type}", rd needs "command"`);
      if (e.spec.matcher && x.matcher !== e.spec.matcher) problems.push(`${e.spec.event}: matcher is ${JSON.stringify(x.matcher)}, expected ${JSON.stringify(e.spec.matcher)}`);
    }
  }
  if (missing.length) {
    out.push(check(group, 'hooks', 'fail', `hooks: ${info.events.length - missing.length} of ${info.events.length} events registered`, { detail: [`missing: ${missing.join(', ')}`, ...problems], fix: `rd install${scope.installArgs ? ` ${scope.installArgs}` : ''}` }));
  } else if (problems.length) {
    out.push(check(group, 'hooks', 'warn', `hooks: all ${info.events.length} events registered, with problems`, { detail: problems, fix: `rd install${scope.installArgs ? ` ${scope.installArgs}` : ''} (or edit ${tilde(file)})` }));
  } else {
    out.push(check(group, 'hooks', 'ok', `hooks: all ${info.events.length} events registered`));
  }

  // command prefix
  if (info.prefixes.length > 1) {
    out.push(check(group, 'hook-prefix', 'warn', 'hook commands start rd in different ways', { detail: info.prefixes.map((p) => `"${p}"`), fix: 'Run `rd install` once with the prefix you want; it rewrites the others.' }));
  } else if (info.prefixes.length === 1) {
    const prefix = info.prefixes[0];
    const gone = missingPrefixFiles(prefix);
    if (gone.length) {
      out.push(check(group, 'hook-prefix', 'fail', `hook command "${prefix}" refers to files that do not exist`, { detail: gone, fix: 'Reinstall with the right path: rd install --hook-prefix "<command>" (or plain `rd install` once rd is on PATH).' }));
    } else if (prefix !== 'rd') {
      out.push(check(group, 'hook-prefix', 'info', `hooks start rd as "${prefix}" (development install)`, { detail: ['The permission rules and the instructions Claude gets still say `rd ...`, so `rd` must be on PATH as well.'] }));
    }
  }

  // plan-review timeout: a plan review blocks until the user decides
  const plan = info.events.find((e) => e.spec.event === 'PermissionRequest');
  for (const x of plan?.entries ?? []) {
    const t = x.timeout;
    if (t === null || t < PLAN_REVIEW_MIN_TIMEOUT) {
      out.push(check(group, 'plan-timeout', 'fail', `plan-review hook timeout is ${t === null ? 'not set (Claude Code default: 600 s)' : `${t} s`}`, { detail: ['The hook blocks until you decide; when Claude Code stops it after the timeout the plan falls back to its own dialog.'], fix: `rd install${scope.installArgs ? ` ${scope.installArgs}` : ''} (sets ${plan.spec.timeout})` }));
    } else if (t !== plan.spec.timeout) {
      out.push(check(group, 'plan-timeout', 'warn', `plan-review hook timeout is ${t} s (rd installs ${plan.spec.timeout})`, { detail: [] }));
    } else {
      out.push(check(group, 'plan-timeout', 'ok', `plan-review hook timeout ${t} s`));
    }
  }

  // the wake-up watcher (optional: everything else works without it, comments just cannot wake an idle session)
  const install = `rd install${scope.installArgs ? ` ${scope.installArgs}` : ''}`;
  out.push(watchCheck(group, info.watch, install));

  // permissions
  const allow = Array.isArray(read.settings.permissions?.allow) ? read.settings.permissions.allow : [];
  const lacking = ALLOW_RULES.filter((r) => !allow.includes(r));
  const denied = (Array.isArray(read.settings.permissions?.deny) ? read.settings.permissions.deny : []).filter((r) => typeof r === 'string' && /^Bash\(rd[ :)*]/.test(r));
  if (denied.length) {
    out.push(check(group, 'permissions', 'warn', 'permissions.deny blocks rd commands', { detail: denied, fix: `Remove ${denied.join(', ')} from permissions.deny in ${tilde(file)}` }));
  } else if (lacking.length) {
    out.push(check(group, 'permissions', 'warn', `permissions.allow lacks ${lacking.length} of ${ALLOW_RULES.length} rules`, { detail: lacking, fix: `rd install${scope.installArgs ? ` ${scope.installArgs}` : ''}  (without them Claude Code asks before each of those rd commands; in plan mode the answer cannot be recorded)` }));
  } else {
    out.push(check(group, 'permissions', 'ok', `permissions.allow has the ${ALLOW_RULES.length} rd rules`));
  }

  // statusLine
  const sl = read.settings.statusLine;
  const local = readSettingsFile(path.join(scope.dir, 'settings.local.json'));
  if (isRdStatusLine(sl)) {
    out.push(
      local.settings.statusLine && !isRdStatusLine(local.settings.statusLine)
        ? check(group, 'statusline', 'warn', 'statusLine: settings.local.json defines another one and overrides rd\'s', { fix: `Append $(rd statusline) to the statusLine command in ${tilde(path.join(scope.dir, 'settings.local.json'))}` })
        : check(group, 'statusline', 'ok', `statusLine: ${sl.command}`),
    );
  } else if (sl && /\brd(\.js)? statusline\b/.test(String(sl.command ?? ''))) {
    out.push(check(group, 'statusline', 'ok', 'statusLine: your own command calls rd statusline'));
  } else if (sl) {
    out.push(check(group, 'statusline', 'warn', 'statusLine: already used by another command; the pending-review count is not shown', { detail: [`current: ${String(sl.command ?? JSON.stringify(sl)).slice(0, 120)}`], fix: 'Append $(rd statusline) to your statusLine script (see README "Status line").' }));
  } else {
    out.push(check(group, 'statusline', 'warn', 'statusLine is not set; the pending-review count is not shown', { fix: `rd install${scope.installArgs ? ` ${scope.installArgs}` : ''}` }));
  }

  // /review-reply
  const cmd = inspectSlashCommand(scope.dir);
  const cmdFile = tilde(cmd.file);
  out.push(
    {
      current: check(group, 'slash-command', 'ok', `/review-reply: ${cmdFile} is current`),
      missing: check(group, 'slash-command', 'fail', `/review-reply: ${cmdFile} is missing`, { fix: `rd install${scope.installArgs ? ` ${scope.installArgs}` : ''}` }),
      outdated: check(group, 'slash-command', 'warn', `/review-reply: ${cmdFile} is from an older rd`, { fix: `rd install${scope.installArgs ? ` ${scope.installArgs}` : ''} (refreshes it)` }),
      foreign: check(group, 'slash-command', 'warn', `/review-reply: ${cmdFile} was not written by rd`, { detail: ['rd never overwrites it; the command rd documents is not available.'], fix: `Move that file away and run rd install${scope.installArgs ? ` ${scope.installArgs}` : ''}` }),
    }[cmd.state],
  );
  return { checks: out, info };
}

// ---------------------------------------------------------------------------------------------------------------------
// RD_HOME

function homeChecks(group, now) {
  const out = [];
  const home = rdHome();
  let st;
  try {
    st = fs.statSync(home);
  } catch (err) {
    if (err.code === 'ENOENT') {
      out.push(check(group, 'home', 'info', `${tilde(home)} does not exist yet`, { detail: ['It is created the first time a hook or `rd` runs.'] }));
      return out;
    }
    out.push(check(group, 'home', 'fail', `cannot read ${tilde(home)}: ${err.message}`));
    return out;
  }
  if (!st.isDirectory()) {
    out.push(check(group, 'home', 'fail', `${tilde(home)} is not a directory`));
    return out;
  }
  out.push(check(group, 'home', 'ok', `${tilde(home)} exists`));
  const mode = st.mode & 0o777;
  out.push(
    mode === 0o700
      ? check(group, 'home-mode', 'ok', 'permissions 700')
      : check(group, 'home-mode', 'warn', `permissions ${mode.toString(8)} (expected 700): other users can read your comments`, { fix: `chmod 700 ${home}` }),
  );
  try {
    fs.accessSync(home, fs.constants.W_OK | fs.constants.X_OK);
    out.push(check(group, 'home-writable', 'ok', 'writable'));
  } catch {
    out.push(check(group, 'home-writable', 'fail', `${tilde(home)} is not writable`, { fix: `chmod u+rwx ${home} (or check who owns it)` }));
  }

  // JSON files
  const bad = [];
  for (const [name, file] of [['config.json', paths.config()], ['sessions.json', paths.sessions()], ['docs-index.json', paths.docsIndex()]]) {
    try {
      readJson(file, null);
    } catch (err) {
      bad.push(`${name}: ${err.message.replace(/^corrupt JSON in \S+: /, '')}`);
    }
  }
  if (bad.length) out.push(check(group, 'home-json', 'fail', 'corrupt JSON file(s)', { detail: bad, fix: 'Fix the file by hand, or move it away (config.json: defaults apply; sessions.json: sessions re-register on their next prompt).' }));
  else out.push(check(group, 'home-json', 'ok', 'config.json, sessions.json and docs-index.json parse'));

  // review directories that cannot be read are invisible in the inbox
  let names = [];
  try {
    names = fs.readdirSync(paths.reviewsDir());
  } catch {
    /* no reviews yet */
  }
  const broken = [];
  for (const name of names) {
    try {
      if (!readJson(paths.meta(name), null)) broken.push(`${name}: no meta.json`);
    } catch (err) {
      broken.push(`${name}: ${err.message.replace(/^corrupt JSON in \S+: /, '')}`);
    }
  }
  if (broken.length) out.push(check(group, 'reviews', 'warn', `${broken.length} review director${broken.length === 1 ? 'y' : 'ies'} cannot be read (not shown in the inbox)`, { detail: list(broken), fix: `Inspect ${tilde(paths.reviewsDir())}; \`rd gc\` does not touch them.` }));
  else out.push(check(group, 'reviews', 'ok', `${names.length} review${names.length === 1 ? '' : 's'}, all readable`));

  // stale lock directories (proper-lockfile): the next writer reclaims them, but a leftover after a crash is worth knowing
  const stale = [];
  const scan = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.name.endsWith('.lock')) continue;
      try {
        const age = now - fs.statSync(path.join(dir, e.name)).mtimeMs;
        if (age > STALE_LOCK_MS) stale.push(`${tilde(path.join(dir, e.name))} (${Math.round(age / 1000)} s old)`);
      } catch {
        /* gone meanwhile */
      }
    }
  };
  scan(home);
  for (const name of names) scan(path.join(paths.reviewsDir(), name));
  if (stale.length) out.push(check(group, 'locks', 'warn', `${stale.length} stale lock${stale.length === 1 ? '' : 's'} left behind by a crashed process`, { detail: list(stale), fix: 'rm -r <path>   (the next write reclaims a stale lock by itself, this only tidies up)' }));
  else out.push(check(group, 'locks', 'ok', 'no stale locks'));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sessions

const SESSION_LIST_MAX = 8;
const shortSession = (s) => `${String(s.sessionId).slice(0, 8)}${s.cwd ? ` ${tilde(s.cwd)}` : ''}`;

async function sessionChecks(group, { fix }) {
  const out = [];
  let sessions;
  try {
    sessions = readSessions();
  } catch {
    return out; // the corrupt file is reported by the RD_HOME checks
  }
  const all = Object.values(sessions);
  const zombies = all.filter((s) => s.state !== 'ended' && Number.isInteger(s.pid) && !isPidAlive(s.pid));
  const live = all.filter((s) => s.state !== 'ended' && !zombies.includes(s)).length;

  if (zombies.length === 0) {
    out.push(check(group, 'zombie-sessions', 'ok', `${all.length} session${all.length === 1 ? '' : 's'} registered, ${live} live; none is a zombie`));
  } else if (fix) {
    const at = nowIso();
    for (const s of zombies) await updateSession(s.sessionId, { state: 'ended', stateSince: at, endedAt: at, endReason: 'rd doctor --fix', awaiting: undefined, watcher: undefined });
    out.push(check(group, 'zombie-sessions', 'ok', `marked ${zombies.length} zombie session${zombies.length === 1 ? '' : 's'} as ended`, { detail: list(zombies.map(shortSession), SESSION_LIST_MAX), fixed: true }));
  } else {
    out.push(
      check(group, 'zombie-sessions', 'warn', `${zombies.length} session${zombies.length === 1 ? ' is' : 's are'} registered as live but its claude process is gone`, {
        detail: list(zombies.map((s) => `${shortSession(s)} (${s.state}, pid ${s.pid})`), SESSION_LIST_MAX),
        fix: 'rd doctor --fix   (marks them ended; feedback for them then uses channel C)',
      }),
    );
  }

  // Marking a zombie ended also dropped its `awaiting`; look at what is left.
  const awaitingStale = Object.values(readSessions()).filter((s) => s.awaiting && !awaitingAlive(s));
  if (awaitingStale.length === 0) {
    out.push(check(group, 'awaiting', 'ok', 'no stale `rd await` records'));
  } else if (fix) {
    for (const s of awaitingStale) await updateSession(s.sessionId, (cur) => (cur.awaiting && !awaitingAlive(cur) ? { awaiting: undefined } : {}));
    out.push(check(group, 'awaiting', 'ok', `cleared ${awaitingStale.length} stale \`rd await\` record${awaitingStale.length === 1 ? '' : 's'}`, { detail: list(awaitingStale.map(shortSession), SESSION_LIST_MAX), fixed: true }));
  } else {
    out.push(
      check(group, 'awaiting', 'warn', `${awaitingStale.length} \`rd await\` record${awaitingStale.length === 1 ? '' : 's'} point to a process that is gone`, {
        detail: list(awaitingStale.map((s) => `${shortSession(s)} (await pid ${s.awaiting.pid})`), SESSION_LIST_MAX),
        fix: `rd doctor --fix   (the TUI shows "${t('delivery.qnaInterrupted')}" for them until Claude starts a new rd await)`,
      }),
    );
  }

  // Same for the wake-up watcher of a session: its process is gone (killed, or Claude Code stopped it at its timeout) and no new Stop armed another.
  const watcherStale = Object.values(readSessions()).filter((s) => s.watcher && !watcherAlive(s));
  if (watcherStale.length === 0) {
    out.push(check(group, 'watcher', 'ok', 'no stale wake-up watcher records'));
  } else if (fix) {
    for (const s of watcherStale) await updateSession(s.sessionId, (cur) => (cur.watcher && !watcherAlive(cur) ? { watcher: undefined } : {}));
    out.push(check(group, 'watcher', 'ok', `cleared ${watcherStale.length} stale wake-up watcher record${watcherStale.length === 1 ? '' : 's'}`, { detail: list(watcherStale.map(shortSession), SESSION_LIST_MAX), fixed: true }));
  } else {
    out.push(
      check(group, 'watcher', 'warn', `${watcherStale.length} wake-up watcher record${watcherStale.length === 1 ? '' : 's'} point to a process that is gone`, {
        detail: list(watcherStale.map((s) => `${shortSession(s)} (watcher pid ${s.watcher.pid})`), SESSION_LIST_MAX),
        fix: 'rd doctor --fix   (comments reach such a session again after its next turn: every Stop starts a new watcher)',
      }),
    );
  }

  // headless resumes (channel C [h]) that ended without taking the feedback
  const failedRuns = [];
  try {
    const { listMetas } = await import('../store/reviews.js');
    const { headlessStatus } = await import('../delivery/resume.js');
    for (const m of listMetas()) {
      if (!m.headless || m.status === 'closed' || m.status === 'approved') continue;
      try {
        const st = headlessStatus(m.id, { meta: m });
        if (st && st.state === 'failed' && !st.superseded) failedRuns.push(`${m.id}: ${st.exitCode !== null ? `exit code ${st.exitCode}` : st.signal ? `signal ${st.signal}` : 'ended without taking the feedback'} (log: ${tilde(st.log)})`);
      } catch {
        /* half-written review */
      }
    }
  } catch {
    /* ignore */
  }
  if (failedRuns.length) out.push(check(group, 'headless', 'warn', `${failedRuns.length} background resume${failedRuns.length === 1 ? '' : 's'} (channel C [h]) failed`, { detail: list(failedRuns), fix: 'Read the log, then press O in the review to resume again, or run `claude --resume <session>` yourself.' }));
  else out.push(check(group, 'headless', 'ok', 'no failed background resumes'));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Auto-injection

async function injectionChecks(group, { env, which, config }) {
  const out = [];
  out.push(check(group, 'autoinject', 'info', `config delivery.autoInject is ${config.delivery?.autoInject === false ? 'off: feedback is never typed into a terminal' : 'on'}`));

  const tmuxBin = which('tmux');
  if (!tmuxBin) {
    out.push(check(group, 'tmux', 'info', 'tmux is not installed: no auto-injection through tmux', { detail: ['Not needed. Without an adapter feedback arrives with your next message in Claude (channel A) or at the end of its turn (B).'] }));
  } else {
    const v = await run(tmuxBin, ['-V'], { timeout: 2000 });
    const version = v.status === 0 ? v.stdout.trim() : 'tmux';
    out.push(
      env.TMUX_PANE
        ? check(group, 'tmux', 'ok', `${version}; this shell runs in pane ${env.TMUX_PANE}: Claude Code sessions started here are auto-injectable`)
        : check(group, 'tmux', 'info', `${version} is installed; this shell is not inside tmux (a Claude Code started inside a tmux pane is auto-injectable)`),
    );
  }

  const ccdBin = which('ccd');
  if (env.CCD_SESSION || ccdBin) {
    let verdict = 'not probed yet (the first session-start hook probes it)';
    try {
      const cached = readJson(path.join(rdHome(), 'probe-cache.json'), {}).ccdSend;
      if (cached) verdict = cached.ok ? '`ccd send` is available' : 'this ccd has no `send` subcommand: ccd injection is disabled';
    } catch {
      /* unreadable cache */
    }
    out.push(check(group, 'ccd', 'info', `ccd ${ccdBin ? 'is installed' : 'not on PATH'}${env.CCD_SESSION ? `, $CCD_SESSION=${env.CCD_SESSION}` : ''}: ${verdict}`));
  } else {
    out.push(check(group, 'ccd', 'info', 'ccd is not installed'));
  }

  // panes recorded for live sessions that have disappeared
  try {
    const tmux = (await import('../delivery/adapters/tmux.js')).default;
    const gone = [];
    for (const s of Object.values(readSessions())) {
      if (s.state === 'ended' || !s.injector || s.injector.kind !== 'tmux' || !isPidAlive(s.pid)) continue;
      if (!tmuxBin || !(await tmux.isAlive(s.injector))) gone.push(`${shortSession(s)}: pane ${s.injector.target} no longer exists`);
    }
    if (gone.length) out.push(check(group, 'injector-panes', 'warn', `${gone.length} live session${gone.length === 1 ? '' : 's'} recorded a tmux pane that is gone`, { detail: list(gone), fix: 'Nothing to repair: those sessions fall back to channel A/B until they restart.' }));
  } catch {
    /* sessions.json unreadable: reported elsewhere */
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// logs/rd.log

const LOG_ENTRY_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[([^\]]*)\] (.*)$/;

/** Failure entries of rd.log newer than `since` (epoch ms): [{at, scope, text}]. Reads only the tail of the file. */
export function recentLogErrors(file, since) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const errors = [];
    for (const line of lines) {
      const m = LOG_ENTRY_RE.exec(line);
      if (!m) continue; // continuation of a stack trace
      const at = Date.parse(m[1]);
      // `ERROR ` marks failures since M4; older entries are recognised by the Error name that opens a stack trace
      if (at >= since && (m[3].startsWith('ERROR ') || /^\w*Error:/.test(m[3]))) errors.push({ at: m[1], scope: m[2], text: m[3].replace(/^ERROR /, '') });
    }
    return errors;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function logChecks(group, now) {
  const errors = recentLogErrors(paths.log(), now - ERROR_WINDOW_MS);
  if (errors.length === 0) return [check(group, 'log-errors', 'ok', 'no errors in logs/rd.log in the last 24 h')];
  const last = errors[errors.length - 1];
  return [
    check(group, 'log-errors', 'warn', `${errors.length} error${errors.length === 1 ? '' : 's'} in logs/rd.log in the last 24 h`, {
      detail: [`last: ${last.at} [${last.scope}] ${last.text.split('\n')[0].slice(0, 160)}`],
      fix: `Read ${tilde(paths.log())} (hooks never fail Claude Code, they log and carry on)`,
    }),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Environment

async function environmentChecks(group, { which, config, deps, usesBareRd }) {
  const out = [];
  const major = Number(process.versions.node.split('.')[0]);
  out.push(
    major >= MIN_NODE_MAJOR
      ? check(group, 'node', 'ok', `Node v${process.versions.node} (>= ${MIN_NODE_MAJOR})`)
      : check(group, 'node', 'fail', `Node v${process.versions.node}: rd needs >= ${MIN_NODE_MAJOR}`, { fix: `Install Node ${MIN_NODE_MAJOR} or newer. Hooks run with the node on Claude Code's PATH.` }),
  );

  const found = which('rd');
  const ours = real(PKG_BIN);
  if (!found) {
    out.push(
      check(group, 'rd-path', usesBareRd ? 'fail' : 'warn', '`rd` is not on PATH', {
        detail: [usesBareRd ? 'The installed hooks and the /review-reply command call `rd`; they cannot run.' : 'Claude calls `rd reply` / `rd await`; the hooks use another command, but those instructions still say `rd`.'],
        fix: `npm install -g @aurantine-works/claude-code-review-desk-tui   (from a source checkout: cd ${PKG_ROOT} && npm link)`,
      }),
    );
  } else if (real(found) === ours) {
    out.push(check(group, 'rd-path', 'ok', `rd on PATH: ${found} -> this package`));
  } else {
    out.push(check(group, 'rd-path', 'warn', `rd on PATH (${found}) is not this package`, { detail: [`resolves to ${real(found) ?? found}; this package is ${ours ?? PKG_BIN}`], fix: `npm install -g @aurantine-works/claude-code-review-desk-tui   (from a source checkout: cd ${PKG_ROOT} && npm link)` }));
  }

  const claudeBin = config.delivery?.claudeBin || 'claude';
  const probe = deps.claudeVersion ? await deps.claudeVersion(claudeBin) : await run(claudeBin, ['--version'], { timeout: 2000 }).then((r) => (r.status === 0 ? { version: r.stdout } : { error: r.error?.code === 'ETIMEDOUT' || r.error?.killed ? 'timed out after 2 s' : r.error?.code === 'ENOENT' ? 'not found' : (r.stderr.trim() || r.error?.message || 'failed') }));
  if (probe.error) {
    out.push(check(group, 'claude', 'warn', `could not run \`${claudeBin} --version\` (${probe.error}); version check skipped`, { fix: 'Make sure claude is on PATH, or set delivery.claudeBin in config.json.' }));
  } else {
    const version = /(\d+\.\d+\.\d+)/.exec(probe.version ?? '')?.[1] ?? String(probe.version ?? '').trim();
    out.push(
      version === VERIFIED_CLAUDE_VERSION
        ? check(group, 'claude', 'ok', `Claude Code ${version} (the version rd was verified with)`)
        : check(group, 'claude', 'warn', `Claude Code ${version}; rd was verified with ${VERIFIED_CLAUDE_VERSION}`, { detail: ['Hook input/output formats and the plan dialog may differ; see the README section "Verified versions" for what was checked.'] }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Run all checks.
 * @param {object} [opts] { fix, configDir }
 * @param {object} [deps] { env, cwd, which, claudeVersion(bin)->{version}|{error}, now (epoch ms) }
 * @returns {Promise<{checks: Check[], summary: {ok: number, warn: number, fail: number, info: number}, ok: boolean}>}
 */
export async function runChecks(opts = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const which = deps.which ?? ((name) => whichSync(name, env.PATH ?? ''));
  const now = deps.now ?? Date.now();
  let config;
  let configProblems = [];
  try {
    ({ config, problems: configProblems } = loadConfigChecked());
  } catch {
    config = {};
  }
  const userDir = opts.configDir ?? (env.CLAUDE_CONFIG_DIR || claudeConfigDir());
  const projectDir = path.join(cwd, '.claude');
  const sameDir = real(projectDir) && real(projectDir) === real(userDir);

  // settings: user-level (config dir) and project-level (./.claude, when it has a settings.json)
  const userRead = readSettingsFile(path.join(userDir, 'settings.json'));
  const projRead = sameDir ? { state: 'missing', settings: {} } : readSettingsFile(path.join(projectDir, 'settings.json'));
  const userScope = { label: 'user', dir: userDir, installArgs: opts.configDir ? `--config-dir ${userDir}` : '' };
  const projScope = { label: 'project', dir: projectDir, installArgs: '--config-dir ./.claude' };

  const settingsOut = [];
  const userGroup = `Claude Code settings (${tilde(userDir)})`;
  const uc = settingsChecks(userGroup, userScope, userRead);
  const pc = projRead.state === 'missing' ? { checks: [], info: null } : settingsChecks(`Claude Code project settings (${tilde(projectDir)})`, projScope, projRead);
  const userInstalled = (uc.info?.installedCount ?? 0) > 0;
  const projInstalled = (pc.info?.installedCount ?? 0) > 0;

  if (userRead.state === 'invalid') settingsOut.push(...uc.checks);
  else if (!userInstalled) {
    if (projInstalled) settingsOut.push(check(userGroup, 'installed', 'info', `rd is not installed in ${tilde(userDir)} (it is installed at project level, see below)`));
    else {
      const missingDir = !fs.existsSync(userDir);
      settingsOut.push(
        check(userGroup, 'installed', 'fail', 'rd is not installed in Claude Code', {
          detail: [missingDir ? `${tilde(userDir)} does not exist` : `no rd hooks in ${tilde(path.join(userDir, 'settings.json'))}${userRead.state === 'missing' ? ' (file missing)' : ''}`, 'Plan reviews, document registration and feedback delivery need the hooks.'],
          fix: 'rd install --dry-run, then rd install',
        }),
      );
    }
  } else settingsOut.push(...uc.checks);
  if (projRead.state === 'invalid') settingsOut.push(...pc.checks);
  else if (projRead.state === 'ok' && !projInstalled) settingsOut.push(check(`Claude Code project settings (${tilde(projectDir)})`, 'installed', 'info', 'no rd entries in the project settings'));
  else settingsOut.push(...pc.checks);
  if (userInstalled && projInstalled) {
    settingsOut.push(
      check(`Claude Code project settings (${tilde(projectDir)})`, 'duplicate-scopes', 'warn', 'rd is installed at user level AND project level: every hook runs twice in this project', {
        fix: 'rd uninstall --config-dir ./.claude   (or remove the user-level install)',
      }),
    );
  }

  const prefixes = [...(uc.info?.prefixes ?? []), ...(pc.info?.prefixes ?? [])];
  const usesBareRd = prefixes.length === 0 ? true : prefixes.includes('rd');

  const checks = [];
  checks.push(...(await environmentChecks('Environment', { which, config, deps, usesBareRd })));
  checks.push(...settingsOut);
  checks.push(...homeChecks('Review Desk data', now));
  if (configProblems.length) {
    checks.push(check('Review Desk data', 'config-values', 'warn', 'config.json has values rd cannot use', { detail: configProblems, fix: `Edit ${tilde(paths.config())}` }));
  }
  const wantLang = env.RD_LANG || config.ui?.lang || 'en';
  if (!hasPack(wantLang)) {
    const where = env.RD_LANG ? 'RD_LANG' : 'ui.lang in config.json';
    checks.push(check('Review Desk data', 'language', 'warn', `language "${wantLang}" (${where}) is not installed; the UI is shown in English`, { fix: `Install the "${wantLang}" language pack (src/i18n/${wantLang}.js), or set ui.lang to "en"` }));
  }
  checks.push(...(await sessionChecks('Sessions', { fix: !!opts.fix })));
  checks.push(...(await injectionChecks('Auto-injection', { env, which, config })));
  checks.push(...logChecks('Hook log', now));

  const summary = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) summary[c.status]++;
  return { checks, summary, ok: summary.fail === 0, userDir, projectDir: projRead.state === 'missing' ? null : projectDir };
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

const SYMBOL = { ok: '✓', warn: '!', fail: '✗', info: '·' };
const paint = { ok: chalk.green, warn: chalk.yellow, fail: chalk.red, info: chalk.dim };

/** The human-readable report. */
export function formatReport(result, { version = '' } = {}) {
  const lines = [];
  lines.push(chalk.bold(`rd doctor${version ? ` · @aurantine-works/claude-code-review-desk-tui ${version}` : ''}`) + chalk.dim(` · RD_HOME ${tilde(rdHome())}`));
  let group = null;
  for (const c of result.checks) {
    if (c.group !== group) {
      group = c.group;
      lines.push('', chalk.bold(group));
    }
    lines.push(`  ${paint[c.status](SYMBOL[c.status])} ${c.title}`);
    for (const d of c.detail ?? []) lines.push(chalk.dim(`      ${d}`));
    if (c.fix) lines.push(`      ${chalk.cyan('fix:')} ${c.fix}`);
  }
  const s = result.summary;
  lines.push('', `${s.ok} ok · ${s.warn} warning${s.warn === 1 ? '' : 's'} · ${s.fail} failed` + (s.fail ? chalk.red('  (exit code 1)') : ''));
  return lines.join('\n') + '\n';
}

/**
 * `rd doctor [--json] [--fix] [--config-dir <dir>]`
 * @returns {Promise<{result: object, exitCode: number}>}
 */
export async function doctorCommand(opts = {}, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const result = await runChecks({ fix: !!opts.fix, configDir: opts.configDir }, deps);
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    /* ignore */
  }
  if (opts.json) {
    out(JSON.stringify({ version, node: process.versions.node, verifiedClaudeVersion: VERIFIED_CLAUDE_VERSION, rdHome: rdHome(), claudeConfigDir: result.userDir, ok: result.ok, summary: result.summary, checks: result.checks }, null, 2) + '\n');
  } else {
    out(formatReport(result, { version }));
  }
  return { result, exitCode: result.ok ? 0 : 1 };
}
