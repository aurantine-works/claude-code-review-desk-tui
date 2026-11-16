#!/usr/bin/env node
// Entry point of `rd`.
//
//  - `rd hook <event>` and `rd statusline` take fast paths: no commander, no ink/react, no moment/lodash.
//    They run on every tool call / every status bar refresh, so startup cost matters here.
//  - every other command goes through commander. Command modules are imported lazily inside the
//    actions, so `rd show` (used by Claude) never loads the TUI and `rd inbox` never loads this file's siblings.
//  - TUI commands (inbox, open, close, ...) live in src/cli/tuiCommands.js, owned by the TUI work. If the
//    file exists it must export `registerTuiCommands(program)`; it is imported eagerly for every
//    non-hook invocation, so it may only import commander-level code at the top. ink/react and the TUI
//    itself must be imported inside the `.action()` callbacks. To make plain `rd` open the watch inbox,
//    register that command with `program.command('inbox', { isDefault: true })`.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);

async function logError(scope, err) {
  try {
    (await import('../src/store/log.js')).logLine(scope, err);
  } catch {
    /* ignore */
  }
}

/** Hooks never fail Claude Code: any problem is logged and the exit code stays 0. */
async function fastHook(event) {
  const controller = new AbortController();
  const onSignal = () => {
    controller.abort(); // plan-review leaves its review in awaiting_review and returns
    setTimeout(() => process.exit(0), 1500).unref();
  };
  // process.on, not once: proper-lockfile's signal-exit re-raises the signal (killing us with it)
  // when it finds no other listener after ours has been consumed.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, onSignal);
  let code = 0;
  try {
    const { runHook } = await import('../src/hooks/index.js');
    // Exit code 0, except for the wake-up watcher's delivery (exit code 2 + stderr, see hooks/result.js).
    code = (await runHook(event, { signal: controller.signal })) ?? 0;
  } catch (err) {
    await logError(`hook ${event}`, err);
  }
  process.exit(code);
}

async function fastStatusline() {
  try {
    const { runStatusline } = await import('../src/cli/statusline.js');
    await runStatusline();
  } catch (err) {
    await logError('statusline', err);
  }
  process.exit(0);
}

async function cli() {
  const { Command, Option } = await import('commander');
  const program = new Command('rd').description('Review Desk: terminal review of Claude Code plans and documents');
  try {
    program.version(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version, '-V, --version');
  } catch {
    /* no package.json next to bin/: no --version */
  }
  program.exitOverride();
  const cmd = () => import('../src/cli/commands.js'); // lazy: keeps moment & co. out of other commands

  program
    .command('show [reviewId]')
    .description('print threads waiting for an answer')
    .option('--pending', 'all reviews waiting for this project')
    .option('--all', 'with --pending: ignore the current directory')
    .option('--format <fmt>', 'prompt | json', 'prompt')
    .action(async (id, o) => (await cmd()).show(id, o));
  program
    .command('reply <reviewId> <threadId> [text]')
    .description("write Claude's answer to a thread (stdin if no text)")
    .action(async (r, t, text) => (await cmd()).reply(r, t, text));
  program
    .command('done <reviewId>')
    .description('mark this round answered')
    .action(async (r) => (await cmd()).done(r));
  program
    .command('await')
    .description('wait for the next review comment (run by Claude as a BACKGROUND task, instant Q&A)')
    .option('--review <id>', 'wait for this review only (default: every review of this session)')
    .addOption(new Option('--session <id>', 'session id (default: $CLAUDE_CODE_SESSION_ID)').hideHelp())
    .addOption(new Option('--poll-ms <ms>', 'poll interval').argParser(Number).hideHelp())
    .action(async (o) => (await import('../src/delivery/await.js')).awaitCommand({ review: o.review, session: o.session, pollMs: o.pollMs }));
  program
    .command('deliver <reviewId>')
    .description('(internal) deliver the review\'s waiting feedback: auto-inject when possible')
    .option('--when-idle', 'wait for the session to become idle before injecting')
    .action(async (r, o) => (await cmd()).deliverCommand(r, { whenIdle: o.whenIdle }));
  program
    .command('add <path>')
    .description('register a document for review, bound to the Claude Code session that wrote it (exit code 2: several candidates, repeat with --session)')
    .option('--session <id>', 'bind this session (UUID) instead of searching for the writer')
    .option('--json', 'machine-readable output')
    .action(async (p, o) => (await import('../src/cli/addCmd.js')).addCommand(p, o));
  program
    .command('resume <reviewId>')
    .description("channel C: print the command that resumes the review's session, or with --headless resume it in the background to answer")
    .option('--headless', 'resume in the background (claude --resume <id> -p /review-reply <review>) and return')
    .option('--json', 'machine-readable output')
    .action(async (r, o) => (await cmd()).resumeCommand(r, o));
  program
    .command('list')
    .description('list reviews')
    .option('--status <s>')
    .option('--json')
    .action(async (o) => (await cmd()).list(o));
  program
    .command('install')
    .description('merge hooks/permissions/statusLine into Claude Code settings (asks before writing)')
    .option('--dry-run', 'show the result without writing')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--hook-prefix <cmd>', 'command that starts rd in hooks, e.g. "node /abs/bin/rd.js"', 'rd')
    .option('--config-dir <dir>', 'Claude Code config directory to change (default: $CLAUDE_CONFIG_DIR or ~/.claude); ./.claude installs for one project')
    .action(async (o) => (await cmd()).runInstall(o));
  program
    .command('uninstall')
    .description('remove what rd install added to Claude Code settings (asks before writing)')
    .option('--dry-run', 'show what would be removed without writing')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--config-dir <dir>', 'Claude Code config directory to change (default: $CLAUDE_CONFIG_DIR or ~/.claude)')
    .action(async (o) => (await cmd()).runUninstall(o));
  program
    .command('doctor')
    .description('check the installation: hooks, settings, rd data, sessions, injection adapters, recent errors (exit code 1 when something is broken)')
    .option('--json', 'machine-readable output')
    .option('--fix', 'mark zombie sessions as ended and clear stale `rd await` records (the only things doctor writes)')
    .option('--config-dir <dir>', 'Claude Code config directory to check (default: $CLAUDE_CONFIG_DIR or ~/.claude)')
    .action(async (o) => (await cmd()).runDoctor(o));
  program
    .command('gc')
    .description('delete old closed/approved reviews, ended sessions, old write records and logs')
    .option('--days <n>', 'age limit in days', '30')
    .option('--dry-run', 'only list what would be deleted')
    .option('-y, --yes', 'do not ask for confirmation (required without a terminal)')
    .action(async (o) => (await cmd()).runGc(o));

  // Handled by the fast paths in main(); registered here so they show up in --help.
  program.command('hook <event>').description('(internal) Claude Code hook entry: session-start, prompt-submit, stop, session-end, post-tool-use, plan-review, watch').action(() => {});
  program.command('statusline').description('one-line summary for the Claude Code status bar').action(() => {});

  const tui = fileURLToPath(new URL('../src/cli/tuiCommands.js', import.meta.url));
  if (fs.existsSync(tui)) {
    const { registerTuiCommands } = await import(tui);
    registerTuiCommands(program);
  }

  await program.parseAsync(process.argv);
}

async function main() {
  if (argv[0] === 'hook') return fastHook(argv[1]);
  if (argv[0] === 'statusline') return fastStatusline();
  return cli();
}

main().catch((err) => {
  if (err && err.code && String(err.code).startsWith('commander.')) {
    process.exit(err.exitCode ?? 1);
  }
  process.stderr.write(`rd: ${err.message}\n`);
  process.exit(1);
});
