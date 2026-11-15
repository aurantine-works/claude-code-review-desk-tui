// Detection of the optional auto-injection target for a session (tmux pane or ccd session).
// rd works without any of these. The adapters themselves live in src/delivery/adapters/.
import { detectInjector as detectAdapter } from '../delivery/adapters/index.js';
export { whichSync } from '../delivery/adapters/util.js';

/**
 * Detect how text could be injected into this session's terminal.
 *  - $TMUX_PANE                      -> { kind: 'tmux', target: '%12', socket?: '<tmux socket from $TMUX>' }
 *  - $CCD_SESSION and `ccd send` ok  -> { kind: 'ccd', target: '<name>' }
 *  - otherwise                       -> { kind: 'none' }
 * @param {object} env   environment of the hook process
 * @param {object} [deps] { run } spawnSync replacement for tests
 */
export const detectInjector = (env = process.env, deps = {}) => detectAdapter(env, deps);
