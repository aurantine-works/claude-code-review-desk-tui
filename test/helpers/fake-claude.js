// A stand-in for the `claude` executable (config.delivery.claudeBin), so tests never launch the real Claude Code.
// The script is named `claude` on purpose: rd's process discovery recognises `node …/claude` as a Claude Code process.
//
//   const fake = installFakeClaude(dir);   // fake.bin is the executable's path
//   env: FAKE_CLAUDE_OUT=<file>   JSON record of the run: argv, cwd, stdin, scrubbed env keys, hook output
//        FAKE_CLAUDE_EXIT=<n>     exit code (default 0)
//        FAKE_CLAUDE_SLEEP_MS=<n> stay alive this long before exiting
//        FAKE_CLAUDE_HOOKS=<rd bin path>   behave like a headless Claude Code run: fire rd's hooks (session-start, prompt-submit,
//                                          stop, session-end) with the headless environment, answer every thread of the review
//                                          named in the prompt with `rd reply`, run `rd done`
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const out = { argv, cwd: process.cwd(), env: {}, stdin: null };
for (const k of ['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'TMUX', 'TMUX_PANE', 'RD_HOME', 'PATH']) {
  if (process.env[k] !== undefined) out.env[k] = process.env[k];
}
try { out.stdin = fs.readFileSync(0, 'utf8'); } catch (err) { out.stdin = 'ERR ' + err.code; }
console.log('fake-claude started: ' + argv.join(' '));
console.error('fake-claude stderr line');

const rdBin = process.env.FAKE_CLAUDE_HOOKS;
if (rdBin) {
  const sid = argv[argv.indexOf('--resume') + 1];
  const prompt = argv[argv.indexOf('-p') + 1];
  const rid = /^\\/review-reply (\\S+)/.exec(prompt)?.[1];
  const env = { ...process.env, CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: String(process.pid) };
  const rd = (args, input) => spawnSync(process.execPath, [rdBin, ...args], { env, input, encoding: 'utf8' });
  const hook = (event, extra) => rd(['hook', event], JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: '/t.jsonl', ...extra }));
  out.hooks = {};
  out.hooks.sessionStart = hook('session-start', { source: 'resume' }).stdout;
  const ps = hook('prompt-submit', { prompt });
  out.hooks.promptSubmit = ps.stdout;
  const ctx = ps.stdout ? JSON.parse(ps.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
  out.context = ctx;
  if (rid) {
    for (const m of ctx.matchAll(/^## Thread (t\\d+)/gm)) out.reply = rd(['reply', rid, m[1], 'headless answer for ' + m[1]]).stdout;
    out.done = rd(['done', rid]).stdout;
  }
  hook('stop', { stop_hook_active: false });
  hook('session-end', { reason: 'other' });
}

if (process.env.FAKE_CLAUDE_OUT) fs.writeFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify(out, null, 2));
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
`;

/** Write the fake `claude` into `dir/bin/claude` (mode 755, ESM through a sibling package.json). */
export function installFakeClaude(dir) {
  const bindir = path.join(dir, 'fake-claude-bin');
  fs.mkdirSync(bindir, { recursive: true });
  fs.writeFileSync(path.join(bindir, 'package.json'), '{"type":"module"}');
  const bin = path.join(bindir, 'claude');
  fs.writeFileSync(bin, SOURCE, { mode: 0o755 });
  return { bin, dir: bindir };
}
