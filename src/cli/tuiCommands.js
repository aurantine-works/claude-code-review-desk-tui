// CLI commands backed by the TUI: `rd` / `rd inbox [--watch]`, `rd open <id>`, `rd close <id>`.
//
// bin/rd.js imports this file eagerly for every non-hook command, so the top level may only import
// light modules. ink / react / the TUI are imported inside the actions.
import { REVIEW_ID_RE } from '../store/ids.js';

/** `rd` with no arguments behaves like `rd inbox --watch`. */
export function isBareInvocation(argv = process.argv.slice(2)) {
  return argv.length === 0;
}

export async function actionInbox(opts, argv = process.argv.slice(2)) {
  const watch = opts.watch === true || !argv.includes('inbox');
  const { runTui } = await import('../tui/run.js');
  await runTui({ watch });
}

/**
 * Resolve the `rd open` argument to a review id: a review id, or the path of a document. A path with an active review
 * opens that review; otherwise the session that wrote it is looked up and the document registered (cli/addCmd.js: several
 * candidates are chosen interactively in a terminal, otherwise AmbiguousWritersError with the candidates is thrown).
 * @param {string} arg
 * @param {{session?: string, pick?: Function}} [opts]
 */
export async function resolveOpenTarget(arg, opts = {}) {
  if (REVIEW_ID_RE.test(arg)) {
    const { getMeta } = await import('../store/reviews.js');
    getMeta(arg); // throws "review not found: ..."
    return arg;
  }
  const fs = await import('node:fs');
  if (arg.includes('/') || arg.includes('.') || arg.includes('\\') || fs.existsSync(arg)) {
    const { resolveDocument, loadPicker } = await import('./addCmd.js');
    return (await resolveDocument(arg, { session: opts.session, pick: opts.pick ?? (await loadPicker()) })).id;
  }
  throw new Error(`invalid review id: ${JSON.stringify(arg)} (expected e.g. plan-20261109-142301-a3f9, or the path of a document)`);
}

export async function actionOpen(arg, opts = {}) {
  let reviewId;
  try {
    reviewId = await resolveOpenTarget(arg, opts);
  } catch (err) {
    if (err?.code === 'ambiguous-writers') {
      (await import('./addCmd.js')).reportAmbiguous(err, { json: opts.json });
      return; // exit code 2, no TUI
    }
    throw err;
  }
  const { runTui } = await import('../tui/run.js');
  await runTui({ reviewId });
}

export async function actionClose(id) {
  const { assertReviewId } = await import('../store/ids.js');
  const { closeReview, getMeta } = await import('../store/index.js');
  assertReviewId(id);
  getMeta(id);
  const meta = await closeReview(id);
  process.stdout.write(`${meta.status} ${id}\n`);
}

export function registerTuiCommands(program) {
  program
    .command('inbox', { isDefault: true })
    .description('open the inbox (plain `rd` = `rd inbox --watch`: new plans open automatically)')
    .option('--watch', 'auto-open new plan reviews and ring the bell')
    .action((opts) => actionInbox(opts));
  program
    .command('open <reviewIdOrPath>')
    .description('open a review; a document path is registered first (the session that wrote it is looked up)')
    .option('--session <id>', 'with a path: bind this Claude Code session instead of searching for the writer')
    .option('--json', 'with a path and several candidate sessions: print them as JSON (exit code 2)')
    .action((arg, opts) => actionOpen(arg, opts));
  program
    .command('close <reviewId>')
    .description('close a review without approving it')
    .action((id) => actionClose(id));
}
