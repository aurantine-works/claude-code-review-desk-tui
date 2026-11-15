// Stand-in for Claude Code's PermissionRequest(ExitPlanMode) hook: runs the real planReview() with a short poll
// interval and writes the outcome as JSON to the file given as argv[2].
// Usage: RD_HOME=<dir> node fake-hook.mjs <out-file> [session-id] [plan-title]
import fs from 'node:fs';
import { planReview } from '../../src/hooks/plan-review.js';
import { updateSession } from '../../src/store/sessions.js';

const [out, sessionId = 'smoke-hook-session', title = 'Smoke test plan'] = process.argv.slice(2);
// A registered, idle Claude session (pid: SEED_SESSION_PID or our parent) so the TUI has delivery information to show.
await updateSession(sessionId, { cwd: '/home/dev/proj-x', pid: Number(process.env.SEED_SESSION_PID) || process.ppid, state: 'idle', injector: { kind: 'none' } });
const plan = `# ${title}\n\n1. Step one: split the slices\n2. Step two: migrate the store\n3. Step three: add tests\n`;
const result = await planReview(
  { session_id: sessionId, cwd: '/home/dev/proj-x', tool_input: { plan } },
  { pollMs: 100, isClaudeAlive: () => true },
);
fs.writeFileSync(out, JSON.stringify({ outcome: result.outcome, reviewId: result.reviewId, decision: result.output?.hookSpecificOutput?.decision ?? null }));
