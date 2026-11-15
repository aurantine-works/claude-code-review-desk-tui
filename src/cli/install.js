// Settings merge logic for `rd install` / `rd uninstall` (pure, so it is easy to test).
import _ from 'lodash';

/**
 * The wake-up watcher (`rd hook watch`, delivery/watch.js) runs in the background and wakes Claude with exit code 2:
 * `asyncRewake: true` makes Claude Code do that (verified on 2.1.325). Its `timeout` IS enforced for such a hook,
 * so it is a week (604800 s; the limit is 2^31 ms, about 24 days); the next Stop arms a new one anyway.
 */
export const WATCH_TIMEOUT = 604800;
const PLAN_REVIEW_TIMEOUT = 86400;
const PLAN_REVIEW_MIN_TIMEOUT = 3600;
/**
 * `rewakeMessage` replaces Claude Code's framing "Stop hook blocking error from command "Stop":" in front of our text, and
 * `rewakeSummary` the line "Stop hook feedback" the terminal shows when the session wakes up. Both are marked @internal in the
 * Claude Code binary; they were verified on 2.1.325 (they load without a settings warning and take effect).
 * Neither is needed for the watcher to work: the text itself says that it is not an error (instructions.js LEAD_WATCH).
 */
export const WATCH_MESSAGE = "Review Desk (the user's own review tool; not an error):";
export const WATCH_SUMMARY = 'Review Desk: new review feedback';
const WATCH_EXTRA = { asyncRewake: true, timeout: WATCH_TIMEOUT, rewakeMessage: WATCH_MESSAGE, rewakeSummary: WATCH_SUMMARY };

// [event, subcommand, matcher?, extra hook fields?] -> command is `<prefix> <subcommand>`. `extra` is what the entry must carry besides
// type and command; re-running `rd install` repairs an rd entry whose extra fields are missing or different.
const HOOKS = [
  ['SessionStart', 'hook session-start'],
  ['UserPromptSubmit', 'hook prompt-submit'],
  ['Stop', 'hook stop'],
  ['SessionEnd', 'hook session-end'],
  ['PostToolUse', 'hook post-tool-use', 'Write|Edit|MultiEdit'],
  ['PermissionRequest', 'hook plan-review', 'ExitPlanMode', { timeout: PLAN_REVIEW_TIMEOUT }],
];
const WATCH_HOOKS = [
  ['SessionStart', 'hook watch', undefined, WATCH_EXTRA],
  ['Stop', 'hook watch', undefined, WATCH_EXTRA],
];
const ALL_HOOKS = [...HOOKS, ...WATCH_HOOKS];

const specOf = ([event, sub, matcher, extra]) => ({ event, sub: sub.replace(/^hook /, ''), matcher: matcher ?? null, timeout: extra?.timeout ?? null, extra: extra ?? {} });

/** What `rd install` registers, as objects (for `rd doctor`): hook event, `<prefix> hook <sub>`, matcher, timeout. */
export const HOOK_SPECS = HOOKS.map(specOf);
/** The two entries of the wake-up watcher (SessionStart and Stop); `rd doctor` reports them apart because they are optional for the rest to work. */
export const WATCH_SPECS = WATCH_HOOKS.map(specOf);

export const DEFAULT_PREFIX = 'rd';
export const ALLOW_RULES = ['Bash(rd show:*)', 'Bash(rd reply:*)', 'Bash(rd done:*)', 'Bash(rd await:*)'];
export const statusLineFor = (prefix = DEFAULT_PREFIX) => ({ type: 'command', command: `${prefix} statusline`, refreshInterval: 2 });
export const STATUSLINE = statusLineFor();

const HOOK_SUBS = [...new Set(ALL_HOOKS.map((h) => h[1].replace('hook ', '')))];
// Anything that looks like "<something>rd[.js] hook <event>" is one of ours, whatever the prefix.
const RD_HOOK_RE = new RegExp(`(^|[\\s/])rd(\\.js)? hook (${HOOK_SUBS.join('|')})$`);
const RD_STATUSLINE_RE = /(^|[\s/])rd(\.js)? statusline$/;

export const isRdHookCommand = (command) => typeof command === 'string' && RD_HOOK_RE.test(command);
export const isRdStatusLine = (sl) => typeof sl?.command === 'string' && RD_STATUSLINE_RE.test(sl.command);

const hasCommand = (groups, command) =>
  (groups ?? []).some((g) => (g.hooks ?? []).some((h) => h.command === command));

/**
 * The extra fields (asyncRewake / timeout) of an existing rd entry that differ from what rd installs. The plan-review timeout is
 * only repaired when it is missing or below an hour (a longer one the user chose is kept; `rd doctor` accepts it too).
 */
function fieldDrift(extra, hook) {
  const drift = {};
  for (const [key, want] of Object.entries(extra)) {
    const ok = key === 'timeout' && want === PLAN_REVIEW_TIMEOUT ? hook.timeout >= PLAN_REVIEW_MIN_TIMEOUT : hook[key] === want;
    if (!ok) drift[key] = want;
  }
  return drift;
}

/**
 * Merge rd's hooks/permissions/statusLine into existing settings without
 * touching anything else. Idempotent. Returns the new settings and a report.
 * An rd hook installed with a different prefix is updated in place, not duplicated.
 * @param {object} existing
 * @param {{prefix?: string}} [opts] prefix: command used to start rd (default `rd`)
 */
export function mergeSettings(existing, { prefix = DEFAULT_PREFIX } = {}) {
  const settings = _.cloneDeep(existing ?? {});
  const report = { hooksAdded: [], hooksPresent: [], hooksUpdated: [], allowAdded: [], statusLine: 'unchanged' };

  settings.hooks ??= {};
  for (const [event, sub, matcher, extra = {}] of ALL_HOOKS) {
    const command = `${prefix} ${sub}`;
    const groups = (settings.hooks[event] ??= []);
    // The existing rd entry of this hook: under this prefix, else (e.g. dev `node /x/bin/rd.js` -> `rd`) under another one.
    const all = groups.flatMap((g) => g.hooks ?? []);
    const old = all.find((h) => h.command === command) ?? all.find((h) => isRdHookCommand(h.command) && h.command.endsWith(` ${sub}`));
    if (old) {
      const renamed = old.command !== command;
      const from = old.command;
      old.command = command;
      const drift = fieldDrift(extra, old);
      Object.assign(old, drift);
      const set = Object.entries(drift).map(([k, v]) => `${k}=${v}`).join(', ');
      if (!renamed && !set) report.hooksPresent.push(`${event}: ${command}`);
      else report.hooksUpdated.push(`${event}: ${renamed ? `${from} -> ${command}` : command}${set ? ` (set ${set})` : ''}`);
      continue;
    }
    const hook = { type: 'command', command, ...extra };
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [hook] });
    report.hooksAdded.push(`${event}: ${command}`);
  }

  settings.permissions ??= {};
  const allow = (settings.permissions.allow ??= []);
  for (const rule of ALLOW_RULES) {
    if (!allow.includes(rule)) {
      allow.push(rule);
      report.allowAdded.push(rule);
    }
  }

  const wanted = statusLineFor(prefix);
  if (!settings.statusLine) {
    settings.statusLine = wanted;
    report.statusLine = 'added';
  } else if (settings.statusLine.command === wanted.command) {
    report.statusLine = 'present';
  } else if (isRdStatusLine(settings.statusLine)) {
    settings.statusLine.command = wanted.command;
    report.statusLine = 'updated';
  } else {
    report.statusLine = 'kept-existing';
  }
  return { settings, report };
}

/** Remove everything mergeSettings added (rd hooks of any prefix, allow rules, rd's statusLine). */
export function unmergeSettings(existing) {
  const settings = _.cloneDeep(existing ?? {});
  for (const event of Object.keys(settings.hooks ?? {})) {
    settings.hooks[event] = settings.hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isRdHookCommand(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (settings.permissions?.allow) {
    settings.permissions.allow = settings.permissions.allow.filter((r) => !ALLOW_RULES.includes(r));
    if (settings.permissions.allow.length === 0) delete settings.permissions.allow;
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
  }
  if (isRdStatusLine(settings.statusLine)) delete settings.statusLine;
  return settings;
}
