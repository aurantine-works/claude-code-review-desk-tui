// Optional auto-injection adapters. rd works without any of them; one is used only when the host happens to
// run Claude Code inside tmux or ccd.
//
// Uniform interface (every method accepts the injector record stored in sessions.json, `{kind, target, ...}`,
// or a bare target string):
//   detect(env, deps)          -> injector record | null     (sync; called by the session-start hook)
//   isAlive(injector, deps)    -> Promise<boolean>           does the pane / session still exist
//   inject(injector, text, deps) -> Promise<void>            type `text` and press Enter; only whitelisted text is accepted
//   verify?(injector, session, deps) -> Promise<{ok, reason}> adapter specific "is this really that session's terminal"
import tmux from './tmux.js';
import ccd from './ccd.js';

export const ADAPTERS = { tmux, ccd };

export const getAdapter = (kind) => (Object.hasOwn(ADAPTERS, kind) ? ADAPTERS[kind] : null);

export { isInjectable, assertInjectable, asInjector } from './util.js';

/** Probe the environment: first adapter that recognises it wins (tmux before ccd). */
export function detectInjector(env = process.env, deps = {}) {
  for (const a of Object.values(ADAPTERS)) {
    const found = a.detect(env, deps);
    if (found) return found;
  }
  return { kind: 'none' };
}
