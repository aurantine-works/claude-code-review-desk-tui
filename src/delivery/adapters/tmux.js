// tmux adapter: type into the pane Claude Code runs in.
//
//   tmux [-S <socket>] send-keys -t %12 -l "/review-reply <id>"   then, separately,   send-keys -t %12 Enter
//
// Pane ids (%12) are only unique per tmux server, so the server's socket (first field of $TMUX) is stored next
// to the pane and passed with -S. Everything runs through execFile with an argument array.
import { readProc } from '../../store/proc.js';
import { run, sleep, assertInjectable, asInjector } from './util.js';

const PANE_RE = /^%\d+$/;
const SOCKET_RE = /^\/[\w./@:+-]{1,200}$/;

/** `$TMUX` is "<socket path>,<server pid>,<session>". */
export function socketFromEnv(env) {
  const first = typeof env.TMUX === 'string' ? env.TMUX.split(',')[0] : '';
  return SOCKET_RE.test(first) ? first : null;
}

const base = (inj) => (inj.socket && SOCKET_RE.test(inj.socket) ? ['-S', inj.socket] : []);
const bin = (deps) => deps.tmux ?? 'tmux';

function checkPane(inj) {
  if (!inj || typeof inj.target !== 'string' || !PANE_RE.test(inj.target)) throw new Error(`invalid tmux pane: ${JSON.stringify(inj?.target)}`);
}

export default {
  kind: 'tmux',

  detect(env) {
    if (!env.TMUX_PANE || !PANE_RE.test(env.TMUX_PANE)) return null;
    const socket = socketFromEnv(env);
    return { kind: 'tmux', target: env.TMUX_PANE, ...(socket ? { socket } : {}) };
  },

  /** pane_id, pane_dead and pane_pid of the target, or null when the pane is gone. */
  async describe(target, deps = {}) {
    const inj = asInjector(target, 'tmux');
    checkPane(inj);
    const r = await (deps.run ?? run)(bin(deps), [...base(inj), 'display-message', '-p', '-t', inj.target, '#{pane_id} #{pane_dead} #{pane_pid}'], { env: deps.env });
    if (r.status !== 0) return null;
    const [paneId, dead, pid] = r.stdout.trim().split(' ');
    if (paneId !== inj.target) return null;
    return { paneId, dead: dead === '1', panePid: Number(pid) };
  },

  async isAlive(target, deps = {}) {
    try {
      const d = await this.describe(target, deps);
      return !!d && !d.dead;
    } catch {
      return false;
    }
  },

  /**
   * Is the claude process of `session` running inside that pane? True when the session's pid is the
   * pane's process or one of its descendants (walks /proc).
   */
  async verify(target, session, deps = {}) {
    const d = await this.describe(target, deps).catch(() => null);
    if (!d || d.dead) return { ok: false, reason: 'pane-gone' };
    if (!Number.isInteger(session?.pid)) return { ok: false, reason: 'no-session-pid' };
    let pid = session.pid;
    for (let depth = 0; depth < 40 && pid > 1; depth++) {
      if (pid === d.panePid) return { ok: true };
      const p = (deps.readProc ?? readProc)(pid);
      if (!p) break;
      pid = p.ppid;
    }
    return { ok: pid === d.panePid, reason: pid === d.panePid ? undefined : 'pane-process-mismatch' };
  },

  /** Type `text` literally, wait a moment (Claude Code's slash-command popup), then press Enter. */
  async inject(target, text, deps = {}) {
    const inj = asInjector(target, 'tmux');
    checkPane(inj);
    assertInjectable(text);
    const exec = deps.run ?? run;
    const typed = await exec(bin(deps), [...base(inj), 'send-keys', '-t', inj.target, '-l', '--', text], { env: deps.env });
    if (typed.status !== 0) throw new Error(`tmux send-keys failed: ${typed.stderr.trim() || typed.error?.message}`);
    await (deps.sleep ?? sleep)(deps.enterDelayMs ?? 800);
    const entered = await exec(bin(deps), [...base(inj), 'send-keys', '-t', inj.target, 'Enter'], { env: deps.env });
    if (entered.status !== 0) throw new Error(`tmux send-keys Enter failed: ${entered.stderr.trim() || entered.error?.message}`);
  },
};

