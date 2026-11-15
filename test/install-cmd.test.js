import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runInstall, runUninstall, askYesNo, inspectSlashCommand, resolveConfigDir, liveProcesses } from '../src/cli/installCmd.js';
import { renderSlashCommand, COMMAND_MARKER } from '../src/feedback/instructions.js';
import { WATCH_MESSAGE, WATCH_SUMMARY } from '../src/cli/install.js';
import { useTempHome } from './helpers/env.js';
import { createReview } from '../src/store/reviews.js';
import { updateSession } from '../src/store/sessions.js';
import { writeJsonAtomic } from '../src/store/io.js';
import { paths } from '../src/store/paths.js';

// uninstall looks at RD_HOME for running plan hooks / `rd await`; keep that away from the real ~/.review-desk
const rdHome = useTempHome();

let dir;
let out;
const say = (s) => out.push(s);
const settingsFile = () => path.join(dir, 'settings.json');
const read = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
const backups = () => fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.rd-backup-'));
const deps = (confirm) => ({ dir, out: say, confirm });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-claude-'));
  out = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('rd install', () => {
  it('--dry-run writes nothing', async () => {
    fs.writeFileSync(settingsFile(), '{"model":"opus"}');
    const r = await runInstall({ dryRun: true }, deps(() => { throw new Error('must not ask'); }));
    expect(r.changed).toBe(false);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{"model":"opus"}');
    expect(backups()).toEqual([]);
    expect(out.join('\n')).toContain('merged settings.json would be');
  });

  it('asks first; declining writes nothing', async () => {
    fs.writeFileSync(settingsFile(), '{"model":"opus"}');
    const asked = [];
    const r = await runInstall({}, deps(async (q) => (asked.push(q), false)));
    expect(asked).toHaveLength(1);
    expect(r.changed).toBe(false);
    expect(read()).toEqual({ model: 'opus' });
    expect(backups()).toEqual([]);
  });

  it('merges after confirmation, backs the original up byte-for-byte and keeps the file mode', async () => {
    const original = '{\n\t"model": "opus",\n\t"hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "mine" }] }] }\n}\n';
    fs.writeFileSync(settingsFile(), original, { mode: 0o640 });
    const r = await runInstall({}, deps(async () => true));
    expect(r.changed).toBe(true);
    expect(backups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups()[0]), 'utf8')).toBe(original);
    const now = read();
    expect(now.model).toBe('opus');
    expect(now.hooks.Stop).toHaveLength(3); // mine, rd hook stop, rd hook watch
    expect(now.hooks.PermissionRequest[0].hooks[0]).toEqual({ type: 'command', command: 'rd hook plan-review', timeout: 86400 });
    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toMatch(/^\{\n\t"model"/); // indentation preserved
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('--yes skips the question; no backup when there was no settings.json', async () => {
    const r = await runInstall({ yes: true }, deps(() => { throw new Error('must not ask'); }));
    expect(r.changed).toBe(true);
    expect(r.backup).toBeNull();
    expect(read().hooks.Stop[0].hooks[0].command).toBe('rd hook stop');
  });

  it('is a no-op the second time (no prompt, no new backup)', async () => {
    await runInstall({ yes: true }, deps());
    const r = await runInstall({}, deps(() => { throw new Error('must not ask'); }));
    expect(r.changed).toBe(false);
    expect(backups()).toEqual([]);
    expect(out.join('\n')).toContain('Already installed');
  });

  it('--hook-prefix writes a development command line', async () => {
    await runInstall({ yes: true, hookPrefix: 'node /abs/bin/rd.js' }, deps());
    expect(read().hooks.PermissionRequest[0].hooks[0].command).toBe('node /abs/bin/rd.js hook plan-review');
    expect(read().statusLine.command).toBe('node /abs/bin/rd.js statusline');
  });

  it('writes through a symlinked settings.json (dotfiles) instead of replacing the link', async () => {
    const real = path.join(dir, 'dotfiles-settings.json');
    fs.writeFileSync(real, '{"model":"opus"}\n');
    fs.symlinkSync(real, settingsFile());
    await runInstall({ yes: true }, deps());
    expect(fs.lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).hooks.Stop).toBeTruthy();
  });

  it('refuses to touch a corrupt settings.json', async () => {
    fs.writeFileSync(settingsFile(), '{oops');
    await expect(runInstall({ yes: true }, deps())).rejects.toThrow(/corrupt/);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{oops');
  });

  it('keeps an existing statusLine', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: 'command', command: '~/s.sh' } }));
    await runInstall({ yes: true }, deps());
    expect(read().statusLine.command).toBe('~/s.sh');
    expect(out.join('\n')).toContain('existing statusLine kept');
  });

  it('without a TTY and without --yes it refuses instead of guessing', async () => {
    await expect(askYesNo('ok?', { input: { isTTY: false } })).rejects.toThrow(/--yes/);
    fs.writeFileSync(settingsFile(), '{}');
    await expect(runInstall({}, { dir, out: say })).rejects.toThrow(/--yes/);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{}');
  });
});

describe('rd uninstall', () => {
  it('restores the pre-install settings and leaves a backup', async () => {
    const before = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } };
    fs.writeFileSync(settingsFile(), JSON.stringify(before, null, 2));
    await runInstall({ yes: true }, deps());
    const r = await runUninstall({}, deps(async () => true));
    expect(r.changed).toBe(true);
    expect(read()).toEqual(before);
    expect(backups().length).toBe(2); // one from install, one from uninstall
  });

  it('declining writes nothing; nothing installed -> nothing to remove', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'opus' }));
    expect((await runUninstall({}, deps(() => { throw new Error('must not ask'); }))).changed).toBe(false);
    await runInstall({ yes: true }, deps());
    const installed = fs.readFileSync(settingsFile(), 'utf8');
    expect((await runUninstall({}, deps(async () => false))).changed).toBe(false);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(installed);
  });

  it('removes dev-prefix installs too', async () => {
    await runInstall({ yes: true, hookPrefix: 'node /abs/bin/rd.js' }, deps());
    await runUninstall({ yes: true }, deps());
    expect(read()).toEqual({});
  });
});

describe('the /review-reply slash command', () => {
  const cmdFile = () => path.join(dir, 'commands', 'review-reply.md');

  it('is written by install (with the documented frontmatter, the rd marker and the output-file hint) and removed by uninstall', async () => {
    const r = await runInstall({ yes: true }, deps());
    expect(r.command).toBe('missing');
    const text = fs.readFileSync(cmdFile(), 'utf8');
    expect(text).toBe(renderSlashCommand());
    expect(text.startsWith('---\ndescription: Answer inline review comments from Review Desk\nargument-hint: [reviewId]\nallowed-tools: Bash(rd show:*), Bash(rd reply:*), Bash(rd done:*), Bash(rd await:*), Read, Edit, MultiEdit, Write\n---\n')).toBe(true);
    expect(text).toContain(COMMAND_MARKER);
    expect(text).toContain('rd show --pending --format prompt');
    expect(text).toContain('run_in_background: true');
    expect(text).toContain('Read the "output file"');
    expect(text).toContain('`already-waiting`');
    expect(text).toContain('`end`');
    expect(fs.statSync(cmdFile()).mode & 0o777).toBe(0o644);
    expect(out.join('\n')).toContain(`slash command: + ${cmdFile()}`);

    const again = await runInstall({}, deps(() => { throw new Error('must not ask'); }));
    expect(again.changed).toBe(false);

    const un = await runUninstall({ yes: true }, deps());
    expect(un.changed).toBe(true);
    expect(fs.existsSync(cmdFile())).toBe(false);
  });

  it('--dry-run reports it without writing', async () => {
    await runInstall({ dryRun: true }, deps());
    expect(fs.existsSync(path.join(dir, 'commands'))).toBe(false);
    expect(out.join('\n')).toContain(`slash command: + ${cmdFile()}`);
  });

  it('refreshes an older rd-written file; never overwrites or deletes somebody else\'s', async () => {
    await runInstall({ yes: true }, deps());
    fs.writeFileSync(cmdFile(), `old text\n${COMMAND_MARKER}\n`);
    expect(inspectSlashCommand(dir).state).toBe('outdated');
    const r = await runInstall({ yes: true }, deps());
    expect(r.changed).toBe(true);
    expect(r.backup).toBeNull(); // settings.json itself did not change
    expect(fs.readFileSync(cmdFile(), 'utf8')).toBe(renderSlashCommand());

    fs.writeFileSync(cmdFile(), 'my own /review-reply command\n');
    expect(inspectSlashCommand(dir).state).toBe('foreign');
    out.length = 0;
    const r2 = await runInstall({ yes: true }, deps());
    expect(r2.changed).toBe(false); // settings already fine, command left alone
    expect(fs.readFileSync(cmdFile(), 'utf8')).toBe('my own /review-reply command\n');
    expect(out.join('\n')).toContain('not written by rd');

    out.length = 0;
    const un = await runUninstall({ yes: true }, deps());
    expect(un.changed).toBe(true); // the settings part
    expect(fs.readFileSync(cmdFile(), 'utf8')).toBe('my own /review-reply command\n');
    expect(out.join('\n')).toContain('left untouched');
  });

  it('install and uninstall work when only the command is missing / left', async () => {
    await runInstall({ yes: true }, deps());
    fs.rmSync(cmdFile());
    const r = await runInstall({ yes: true }, deps());
    expect(r).toMatchObject({ changed: true, command: 'missing' });
    expect(backups()).toHaveLength(0); // settings.json was not touched again (and had no original to back up)
    // a hand-edited settings.json without rd, but a leftover rd command file: uninstall still cleans it up
    fs.writeFileSync(settingsFile(), '{"model":"opus"}');
    const un = await runUninstall({ yes: true }, deps());
    expect(un.changed).toBe(true);
    expect(fs.existsSync(cmdFile())).toBe(false);
    expect(read()).toEqual({ model: 'opus' });
  });
});

describe('rd uninstall: round trip', () => {
  const INDENT = 2;
  const write = (obj) => fs.writeFileSync(settingsFile(), JSON.stringify(obj, null, INDENT) + '\n');

  // What a real settings.json looks like after months of use, in the order Claude Code itself writes it.
  const original = () => ({
    model: 'opus',
    effortLevel: 'high',
    permissions: { allow: ['Bash(ls:*)', 'Bash(git status:*)'], deny: ['Read(./.env)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '/home/me/bin/notify-done.sh' }] }],
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }],
    },
    env: { FOO: 'bar' },
  });

  it('install, then the user edits other things, then uninstall = the original with the user\'s edits (deep and byte-for-byte)', async () => {
    write(original());
    await runInstall({ yes: true }, deps());

    // the user, meanwhile: changes a value, adds a key, removes a key, adds their own hook next to rd's, one more rule
    const mid = read();
    mid.model = 'sonnet';
    mid.theme = 'dark';
    delete mid.effortLevel;
    mid.hooks.Stop.push({ hooks: [{ type: 'command', command: '/home/me/bin/second-hook.sh' }] });
    mid.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'echo started' }] }];
    mid.hooks.PostToolUse[0].hooks.push({ type: 'command', command: 'eslint --fix' });
    mid.permissions.allow.splice(1, 0, 'Bash(npm test:*)');
    mid.env.BAZ = 'qux';
    write(mid);

    const expected = original();
    expected.model = 'sonnet';
    expected.theme = 'dark';
    delete expected.effortLevel;
    expected.hooks.Stop.push({ hooks: [{ type: 'command', command: '/home/me/bin/second-hook.sh' }] });
    expected.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'echo started' }] }];
    expected.hooks.PostToolUse[0].hooks.push({ type: 'command', command: 'eslint --fix' });
    expected.permissions.allow.splice(1, 0, 'Bash(npm test:*)');
    expected.env.BAZ = 'qux';

    const r = await runUninstall({ yes: true }, deps());
    expect(r.changed).toBe(true);
    expect(read()).toEqual(expected);
    // not only equal: same key order and formatting
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(JSON.stringify(expected, null, INDENT) + '\n');
    expect(fs.existsSync(path.join(dir, 'commands', 'review-reply.md'))).toBe(false);
  });

  it('with no changes in between the file is byte-for-byte the original', async () => {
    write(original());
    const text = fs.readFileSync(settingsFile(), 'utf8');
    await runInstall({ yes: true }, deps());
    await runUninstall({ yes: true }, deps());
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(text);
  });

  it('a user hook that lives in the same group as an rd hook survives', async () => {
    write({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'rd hook stop' }, { type: 'command', command: 'mine.sh' }] }] } });
    await runUninstall({ yes: true }, deps());
    expect(read()).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } });
  });

  it('uninstalling twice is a no-op: no prompt, no second backup, file untouched', async () => {
    write(original());
    await runInstall({ yes: true }, deps());
    const first = await runUninstall({ yes: true }, deps());
    expect(first.changed).toBe(true);
    const after = fs.readFileSync(settingsFile(), 'utf8');
    const nBackups = backups().length;
    out.length = 0;
    const second = await runUninstall({}, deps(() => { throw new Error('must not ask'); }));
    expect(second.changed).toBe(false);
    expect(out.join('\n')).toContain('Nothing to remove');
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(after);
    expect(backups()).toHaveLength(nBackups);
  });

  it('install and uninstall on a missing settings.json: uninstall leaves an empty object behind, never throws', async () => {
    await runInstall({ yes: true }, deps());
    await runUninstall({ yes: true }, deps());
    expect(read()).toEqual({});
    expect((await runUninstall({ yes: true }, deps())).changed).toBe(false);
  });

  it('writes through a symlinked settings.json and keeps the link (the backup sits next to the link)', async () => {
    const target = path.join(dir, 'dotfiles', 'claude-settings.json');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, JSON.stringify(original(), null, INDENT) + '\n');
    fs.symlinkSync(target, settingsFile());
    const text = fs.readFileSync(target, 'utf8');
    await runInstall({ yes: true }, deps());
    expect(fs.readFileSync(target, 'utf8')).not.toBe(text);
    await runUninstall({ yes: true }, deps());
    expect(fs.lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(text);
    expect(backups()).toHaveLength(2);
    for (const b of backups()) expect(fs.lstatSync(path.join(dir, b)).isSymbolicLink()).toBe(false);
  });

  it('--dry-run lists the removals and shows a diff, and writes nothing', async () => {
    write(original());
    await runInstall({ yes: true }, deps());
    const installed = fs.readFileSync(settingsFile(), 'utf8');
    out.length = 0;
    const r = await runUninstall({ dryRun: true }, deps(() => { throw new Error('must not ask'); }));
    expect(r.changed).toBe(false);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(installed);
    expect(backups()).toHaveLength(1); // install's only
    expect(fs.existsSync(path.join(dir, 'commands', 'review-reply.md'))).toBe(true);
    const text = out.join('\n');
    expect(text).toContain('# rd uninstall --dry-run (nothing is written)');
    expect(text).toContain('- hook PermissionRequest: rd hook plan-review');
    expect(text).toContain('- permission Bash(rd show:*)');
    expect(text).toMatch(/^-\s+"command": "rd hook stop"/m);
    expect(text).toMatch(/^\+\+\+ .*after uninstall/m);
    expect(text).not.toMatch(/^Index:/m);
  });

  it('a running plan-review hook or `rd await` is reported, never stopped', async () => {
    const m = await createReview({ kind: 'plan', sessionId: 's1', cwd: '/w', content: '# plan', source: 'ExitPlanMode' });
    const meta = JSON.parse(fs.readFileSync(paths.meta(m.id), 'utf8'));
    meta.hook = { pid: process.pid, since: new Date().toISOString() };
    writeJsonAtomic(paths.meta(m.id), meta);
    await updateSession('s1', {
      cwd: '/w',
      pid: process.pid,
      state: 'idle',
      awaiting: { reviewId: m.id, since: new Date().toISOString(), pid: process.pid },
      watcher: { since: new Date().toISOString(), pid: process.pid },
    });
    expect(liveProcesses()).toHaveLength(3);
    await runInstall({ yes: true }, deps());
    out.length = 0;
    await runUninstall({ yes: true }, deps());
    const text = out.join('\n');
    expect(text).toContain(`plan review ${m.id} is waiting for your decision in a running hook (pid ${process.pid})`);
    expect(text).toContain('has a running `rd await`');
    expect(text).toContain('has a running wake-up watcher');
    expect(text).toContain('uninstalling does not stop it');
    expect(() => process.kill(process.pid, 0)).not.toThrow(); // and we are still here
    expect(read()).toEqual({});
  });

  it('rd install on an older installation adds the watcher entries (and says so); rd uninstall removes them again', async () => {
    await runInstall({ yes: true }, deps());
    const older = read();
    for (const event of ['SessionStart', 'Stop']) older.hooks[event] = older.hooks[event].filter((g) => !JSON.stringify(g).includes('hook watch'));
    fs.writeFileSync(settingsFile(), JSON.stringify(older, null, 2) + '\n');
    out.length = 0;
    const r = await runInstall({ yes: true }, deps());
    expect(r.changed).toBe(true);
    expect(out.join('\n')).toContain('+ SessionStart: rd hook watch');
    expect(out.join('\n')).toContain('+ Stop: rd hook watch');
    expect(read().hooks.Stop.at(-1).hooks).toEqual([{ type: 'command', command: 'rd hook watch', asyncRewake: true, timeout: 604800, rewakeMessage: WATCH_MESSAGE, rewakeSummary: WATCH_SUMMARY }]);
    // an entry that lost its flags is repaired and reported as an update
    const broken = read();
    delete broken.hooks.Stop.at(-1).hooks[0].asyncRewake;
    fs.writeFileSync(settingsFile(), JSON.stringify(broken, null, 2) + '\n');
    out.length = 0;
    await runInstall({ yes: true }, deps());
    expect(out.join('\n')).toContain('~ Stop: rd hook watch (set asyncRewake=true)');
    expect(read().hooks.Stop.at(-1).hooks[0].asyncRewake).toBe(true);
    // dry-run shows it too and writes nothing
    const again = read();
    delete again.hooks.SessionStart.at(-1).hooks[0].timeout;
    fs.writeFileSync(settingsFile(), JSON.stringify(again, null, 2) + '\n');
    const before = fs.readFileSync(settingsFile(), 'utf8');
    out.length = 0;
    await runInstall({ dryRun: true }, deps());
    expect(out.join('\n')).toContain('~ SessionStart: rd hook watch (set timeout=604800)');
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(before);
    // uninstall takes both away
    await runInstall({ yes: true }, deps());
    await runUninstall({ yes: true }, deps());
    expect(read()).toEqual({});
  });

  it('--hook-prefix applies to the watcher entries', async () => {
    await runInstall({ yes: true, hookPrefix: 'node /abs/bin/rd.js' }, deps());
    expect(read().hooks.Stop.at(-1).hooks[0]).toMatchObject({ command: 'node /abs/bin/rd.js hook watch', asyncRewake: true });
  });

  it('no live process: no warning', async () => {
    await runInstall({ yes: true }, deps());
    out.length = 0;
    await runUninstall({ yes: true }, deps());
    expect(out.join('\n')).not.toContain('uninstalling does not stop');
    expect(rdHome()).toBeTruthy();
  });
});

describe('project-level install (--config-dir / CLAUDE_CONFIG_DIR)', () => {
  const projectClaude = () => path.join(dir, 'project', '.claude');
  const projectSettings = () => path.join(projectClaude(), 'settings.json');

  it('--config-dir installs and uninstalls in a project\'s .claude, leaving the user-level directory alone', async () => {
    fs.mkdirSync(projectClaude(), { recursive: true });
    fs.writeFileSync(projectSettings(), JSON.stringify({ permissions: { allow: ['Bash(make:*)'] } }, null, 2) + '\n');
    fs.writeFileSync(settingsFile(), '{"model":"opus"}');
    const o = (s) => out.push(s);
    // no deps.dir: the directory comes from the option
    const r = await runInstall({ yes: true, configDir: projectClaude() }, { out: o });
    expect(r.file).toBe(projectSettings());
    expect(JSON.parse(fs.readFileSync(projectSettings(), 'utf8')).hooks.PermissionRequest[0].hooks[0].command).toBe('rd hook plan-review');
    expect(fs.existsSync(path.join(projectClaude(), 'commands', 'review-reply.md'))).toBe(true);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{"model":"opus"}'); // the "user level" was not touched
    expect(fs.existsSync(path.join(dir, 'commands'))).toBe(false);

    await runUninstall({ yes: true, configDir: projectClaude() }, { out: o });
    expect(JSON.parse(fs.readFileSync(projectSettings(), 'utf8'))).toEqual({ permissions: { allow: ['Bash(make:*)'] } });
    expect(fs.existsSync(path.join(projectClaude(), 'commands', 'review-reply.md'))).toBe(false);
  });

  it('a relative --config-dir is resolved against the current directory', () => {
    expect(resolveConfigDir({ configDir: './.claude' })).toBe(path.resolve('.claude'));
    expect(resolveConfigDir({ configDir: '/abs/x' })).toBe('/abs/x');
  });

  it('CLAUDE_CONFIG_DIR is used when there is no option, and --config-dir wins over it', async () => {
    const other = path.join(dir, 'other-config');
    fs.mkdirSync(other);
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = other;
    try {
      expect(resolveConfigDir({})).toBe(other);
      await runInstall({ yes: true }, { out: () => {} });
      expect(fs.existsSync(path.join(other, 'settings.json'))).toBe(true);
      expect(resolveConfigDir({ configDir: dir })).toBe(dir);
      await runUninstall({ yes: true }, { out: () => {} });
      expect(JSON.parse(fs.readFileSync(path.join(other, 'settings.json'), 'utf8'))).toEqual({});
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});
