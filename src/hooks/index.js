// Hook dispatcher: `rd hook <event>`.
//
// Contract with Claude Code:
//  - stdin carries the event JSON; stdout carries nothing or ONE JSON object;
//  - non-blocking hooks never fail: every error is logged to logs/rd.log and the exit code stays 0;
//  - plan-review is the only blocking hook. On an internal error it also stays silent, which makes
//    Claude Code show its own plan approval dialog instead of silently approving or rejecting;
//  - `watch` is the only handler that does not print JSON: it is registered with `asyncRewake: true` and, when it has real
//    feedback for the session, returns a HookExit (text on stderr, exit code 2) that wakes Claude. An error never does that:
//    it is logged and the exit code stays 0.
//
// Only the handler for the requested event is loaded (dynamic import), keeping startup small.
import { readStdin, parseJsonLoose } from './stdin.js';
import { logLine } from '../store/log.js';
import { HookExit } from './result.js';

const HANDLERS = {
  'session-start': () => import('./session-start.js'),
  'prompt-submit': () => import('./prompt-submit.js'),
  stop: () => import('./stop.js'),
  'session-end': () => import('./session-end.js'),
  'post-tool-use': () => import('./post-tool-use.js'),
  'plan-review': () => import('./plan-review.js'),
  watch: () => import('./watch.js'),
};

export const HOOK_EVENTS = Object.keys(HANDLERS);

/**
 * Run the handler for `event` on an already parsed input. Never throws.
 * @returns the JSON-serialisable object to print, a HookExit (stderr + exit code, the watcher only), or undefined
 */
export async function dispatchHook(event, input, deps = {}) {
  try {
    const load = Object.hasOwn(HANDLERS, event) ? HANDLERS[event] : null;
    if (!load) throw new Error(`unknown hook event: ${event}`);
    const mod = await load();
    return await mod.default(input ?? {}, deps);
  } catch (err) {
    logLine(`hook ${event}`, err);
    return undefined;
  }
}

/**
 * Process-level entry used by bin/rd.js: read stdin, dispatch, print the result.
 * Resolves with the exit code the process should end with (undefined: 0) once stdout / stderr have been flushed.
 */
export async function runHook(event, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, signal, deps = {} } = {}) {
  const raw = await readStdin({ stream: stdin });
  const input = parseJsonLoose(raw);
  if (input === null) {
    logLine(`hook ${event}`, `unparsable stdin (${raw.length} bytes)`, 'error');
    return;
  }
  const output = await dispatchHook(event, input, { signal, ...deps });
  if (output === undefined || output === null) return;
  if (output instanceof HookExit) {
    stderr.on?.('error', () => {});
    if (output.stderr) await new Promise((resolve) => stderr.write(output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`, resolve));
    return output.code;
  }
  stdout.on?.('error', () => {}); // a closed pipe must not crash the hook
  await new Promise((resolve) => stdout.write(JSON.stringify(output) + '\n', resolve));
}
