import { describe, it, expect } from 'vitest';
import { mergeSettings, unmergeSettings, isRdHookCommand, ALLOW_RULES, HOOK_SPECS, WATCH_SPECS, WATCH_TIMEOUT, WATCH_MESSAGE, WATCH_SUMMARY } from '../src/cli/install.js';

const userHook = { hooks: [{ type: 'command', command: 'my-own-stop' }] };

describe('mergeSettings', () => {
  it('populates an empty config', () => {
    const { settings, report } = mergeSettings({});
    expect(Object.keys(settings.hooks).sort()).toEqual(['PermissionRequest', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(settings.hooks.PermissionRequest[0]).toEqual({ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'rd hook plan-review', timeout: 86400 }] });
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Write|Edit|MultiEdit');
    expect(settings.permissions.allow).toEqual(ALLOW_RULES);
    expect(settings.statusLine).toMatchObject({ command: 'rd statusline', refreshInterval: 2 });
    expect(report.hooksAdded).toHaveLength(8); // 6 hooks + the two entries of the wake-up watcher
  });

  it('registers the wake-up watcher on SessionStart and Stop as a background hook that wakes Claude (asyncRewake, 7 days)', () => {
    const { settings } = mergeSettings({});
    const watch = { type: 'command', command: 'rd hook watch', asyncRewake: true, timeout: 604800, rewakeMessage: WATCH_MESSAGE, rewakeSummary: WATCH_SUMMARY };
    expect(WATCH_SUMMARY).toBe('Review Desk: new review feedback');
    expect(WATCH_MESSAGE).toContain('not an error');
    expect(WATCH_TIMEOUT).toBe(604800);
    expect(WATCH_TIMEOUT * 1000).toBeLessThan(2 ** 31); // Claude Code keeps timeouts in milliseconds
    for (const event of ['SessionStart', 'Stop']) {
      expect(settings.hooks[event].flatMap((g) => g.hooks)).toContainEqual(watch);
      expect(settings.hooks[event]).toHaveLength(2); // the event's own hook plus the watcher
    }
    for (const event of ['UserPromptSubmit', 'SessionEnd', 'PostToolUse', 'PermissionRequest']) {
      expect(JSON.stringify(settings.hooks[event])).not.toContain('hook watch');
    }
    expect(HOOK_SPECS).toHaveLength(6);
    expect(WATCH_SPECS.map((s) => [s.event, s.sub, s.timeout, s.extra.asyncRewake])).toEqual([
      ['SessionStart', 'watch', 604800, true],
      ['Stop', 'watch', 604800, true],
    ]);
    expect(isRdHookCommand('rd hook watch')).toBe(true);
    expect(isRdHookCommand('node /x/bin/rd.js hook watch')).toBe(true);
    expect(isRdHookCommand('my-rd hook watch')).toBe(false);
  });

  it('adds the watcher to an older installation and leaves everything else in place', () => {
    const older = mergeSettings({}).settings;
    for (const event of ['SessionStart', 'Stop']) older.hooks[event] = older.hooks[event].filter((g) => !JSON.stringify(g).includes('hook watch'));
    const { settings, report } = mergeSettings(older);
    expect(report.hooksAdded).toEqual(['SessionStart: rd hook watch', 'Stop: rd hook watch']);
    expect(report.hooksUpdated).toEqual([]);
    expect(report.hooksPresent).toHaveLength(6);
    expect(settings.hooks.Stop[0]).toEqual(older.hooks.Stop[0]);
  });

  it('repairs a watcher entry whose asyncRewake / timeout is missing or different, once, and keeps the user\'s other fields', () => {
    const base = mergeSettings({}).settings;
    const find = (s, event) => s.hooks[event].flatMap((g) => g.hooks).find((h) => h.command === 'rd hook watch');
    const broken = structuredClone(base);
    delete find(broken, 'Stop').asyncRewake;
    find(broken, 'SessionStart').timeout = 600;
    find(broken, 'SessionStart').statusMessage = 'mine';
    const { settings, report } = mergeSettings(broken);
    expect(report.hooksUpdated).toEqual(['SessionStart: rd hook watch (set timeout=604800)', 'Stop: rd hook watch (set asyncRewake=true)']);
    // an entry written by the first version of the watcher (no rewake texts) gets them
    const first = structuredClone(base);
    for (const event of ['SessionStart', 'Stop']) {
      delete find(first, event).rewakeMessage;
      delete find(first, event).rewakeSummary;
    }
    expect(mergeSettings(first).report.hooksUpdated).toEqual([
      `SessionStart: rd hook watch (set rewakeMessage=${WATCH_MESSAGE}, rewakeSummary=${WATCH_SUMMARY})`,
      `Stop: rd hook watch (set rewakeMessage=${WATCH_MESSAGE}, rewakeSummary=${WATCH_SUMMARY})`,
    ]);
    expect(find(settings, 'Stop')).toEqual({ type: 'command', command: 'rd hook watch', timeout: 604800, asyncRewake: true, rewakeMessage: WATCH_MESSAGE, rewakeSummary: WATCH_SUMMARY });
    expect(find(settings, 'SessionStart')).toMatchObject({ asyncRewake: true, timeout: 604800, statusMessage: 'mine' });
    expect(mergeSettings(settings).report.hooksUpdated).toEqual([]); // idempotent
    // asyncRewake: false is "different" too
    const off = structuredClone(base);
    find(off, 'Stop').asyncRewake = false;
    expect(mergeSettings(off).report.hooksUpdated).toHaveLength(1);
  });

  it('repairs a plan-review hook without a (sufficient) timeout, but keeps a longer one the user chose', () => {
    const base = mergeSettings({}).settings;
    const plan = (s) => s.hooks.PermissionRequest[0].hooks[0];
    const noTimeout = structuredClone(base);
    delete plan(noTimeout).timeout;
    expect(plan(mergeSettings(noTimeout).settings).timeout).toBe(86400);
    const short = structuredClone(base);
    plan(short).timeout = 600;
    expect(plan(mergeSettings(short).settings).timeout).toBe(86400);
    const longer = structuredClone(base);
    plan(longer).timeout = 7200;
    const r = mergeSettings(longer);
    expect(plan(r.settings).timeout).toBe(7200);
    expect(r.report.hooksUpdated).toEqual([]);
  });

  it('preserves user hooks, other keys and existing permissions', () => {
    const existing = { model: 'opus', hooks: { Stop: [userHook] }, permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] } };
    const { settings } = mergeSettings(existing);
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toHaveLength(3); // the user's, rd hook stop, rd hook watch
    expect(settings.hooks.Stop[0]).toEqual(userHook);
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)', ...ALLOW_RULES]);
    expect(settings.permissions.deny).toEqual(['Bash(rm:*)']);
  });

  it('is idempotent and does not mutate its input', () => {
    const existing = { hooks: { Stop: [userHook] } };
    const snapshot = JSON.stringify(existing);
    const once = mergeSettings(existing).settings;
    const twice = mergeSettings(once);
    expect(twice.settings).toEqual(once);
    expect(twice.report.hooksAdded).toEqual([]);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('never overwrites an existing statusLine', () => {
    const sl = { type: 'command', command: '~/bin/mine.sh' };
    const { settings, report } = mergeSettings({ statusLine: sl });
    expect(settings.statusLine).toEqual(sl);
    expect(report.statusLine).toBe('kept-existing');
  });

  it('unmerge restores the original', () => {
    const existing = { model: 'opus', hooks: { Stop: [userHook] }, permissions: { allow: ['Bash(ls:*)'] } };
    expect(unmergeSettings(mergeSettings(existing).settings)).toEqual(existing);
    expect(unmergeSettings(mergeSettings({}).settings)).toEqual({});
  });
});

describe('hook prefix', () => {
  const dev = 'node /abs/bin/rd.js';
  it('writes prefixed hook and statusLine commands', () => {
    const { settings } = mergeSettings({}, { prefix: dev });
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toBe(`${dev} hook plan-review`);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(`${dev} hook session-start`);
    expect(settings.statusLine.command).toBe(`${dev} statusline`);
    expect(settings.permissions.allow).toEqual(ALLOW_RULES); // Claude calls plain `rd show` etc.
  });
  it('rewrites an rd hook installed under another prefix instead of duplicating it', () => {
    const first = mergeSettings({ hooks: { Stop: [userHook] } }, { prefix: dev }).settings;
    const { settings, report } = mergeSettings(first, { prefix: 'rd' });
    expect(settings.hooks.Stop).toHaveLength(3);
    expect(settings.hooks.Stop[1].hooks[0].command).toBe('rd hook stop');
    expect(settings.hooks.Stop[2].hooks[0]).toMatchObject({ type: 'command', command: 'rd hook watch', asyncRewake: true, timeout: 604800 });
    expect(report.hooksUpdated).toHaveLength(8);
    expect(report.hooksAdded).toEqual([]);
    expect(settings.statusLine.command).toBe('rd statusline');
    expect(report.statusLine).toBe('updated');
  });
  it('unmerge removes hooks of any prefix and keeps look-alikes', () => {
    const lookalike = { hooks: [{ type: 'command', command: 'my-rd hook stop-it' }] };
    const base = { hooks: { Stop: [userHook, lookalike] } };
    const merged = mergeSettings(base, { prefix: dev }).settings;
    expect(unmergeSettings(merged)).toEqual(base);
  });
  it('a user statusLine that merely mentions rd is left alone', () => {
    const sl = { type: 'command', command: '~/bin/mine.sh | rd statusline-x' };
    expect(unmergeSettings({ statusLine: sl }).statusLine).toEqual(sl);
  });
});
