// A hook result that is not "print one JSON object, exit 0": the wake-up watcher (`rd hook watch`, hooks/watch.js) wakes Claude by
// writing text to stderr and exiting with code 2 (Claude Code's `asyncRewake` hooks). The dispatcher
// (hooks/index.js) turns this into stderr + the process exit code; every other handler keeps returning a plain JSON object.
export class HookExit {
  /** @param {{code: number, stderr?: string}} p */
  constructor({ code, stderr = '' }) {
    this.code = code;
    this.stderr = stderr;
  }
}
