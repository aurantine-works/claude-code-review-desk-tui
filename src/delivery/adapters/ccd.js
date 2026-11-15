// ccd adapter: `ccd send <name> --text "<text>" --enter`.
//
// Kept for hosts that have it. The ccd on the development host has no `send` subcommand,
// so detection requires `ccd send --help` to really document `send`; the verdict is cached per binary in
// <RD_HOME>/probe-cache.json because spawning ccd (a node script) costs 100 ms+. Tests use mocks.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths } from '../../store/paths.js';
import { readJson, writeJsonAtomic } from '../../store/io.js';
import { whichSync, run, assertInjectable, asInjector } from './util.js';

const PROBE_TIMEOUT_MS = 800;
const NAME_RE = /^[\w.-]{1,128}$/;

function ccdCanSend(env, runSync) {
  const bin = whichSync('ccd', env.PATH);
  if (!bin) return false;
  let key;
  try {
    key = `v2:${fs.realpathSync(bin)}:${fs.statSync(bin).mtimeMs}`;
  } catch {
    return false;
  }
  const cacheFile = path.join(paths.home(), 'probe-cache.json');
  const cache = (() => {
    try {
      return readJson(cacheFile, {});
    } catch {
      return {};
    }
  })();
  if (cache.ccdSend && cache.ccdSend.key === key) return cache.ccdSend.ok;
  const r = runSync(bin, ['send', '--help'], { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Exit status alone is not enough: some ccd builds treat the unknown word `send` as a session name
  // and print their generic usage with status 0. A real subcommand must at least mention itself.
  const ok = !r.error && r.status === 0 && /\bsend\b/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  // A timeout is not a verdict about the binary; do not cache it.
  if (!r.error || r.error.code !== 'ETIMEDOUT') {
    try {
      writeJsonAtomic(cacheFile, { ...cache, ccdSend: { key, ok } });
    } catch {
      /* cache is optional */
    }
  }
  return ok;
}

export default {
  kind: 'ccd',

  detect(env, deps = {}) {
    if (!env.CCD_SESSION || !NAME_RE.test(env.CCD_SESSION)) return null;
    return ccdCanSend(env, deps.run ?? spawnSync) ? { kind: 'ccd', target: env.CCD_SESSION } : null;
  },

  /** `ccd ls` lists the live sessions; the name must appear as a whole word. */
  async isAlive(target, deps = {}) {
    const inj = asInjector(target, 'ccd');
    if (!NAME_RE.test(inj?.target ?? '')) return false;
    const r = await (deps.run ?? run)(deps.ccd ?? 'ccd', ['ls'], { env: deps.env });
    if (r.status !== 0) return false;
    return new RegExp(`(^|[^\\w.-])${inj.target.replace(/[.]/g, '\\.')}($|[^\\w.-])`).test(r.stdout);
  },

  async inject(target, text, deps = {}) {
    const inj = asInjector(target, 'ccd');
    if (!NAME_RE.test(inj?.target ?? '')) throw new Error(`invalid ccd session: ${JSON.stringify(inj?.target)}`);
    assertInjectable(text);
    const r = await (deps.run ?? run)(deps.ccd ?? 'ccd', ['send', inj.target, '--text', text, '--enter'], { env: deps.env });
    if (r.status !== 0) throw new Error(`ccd send failed: ${r.stderr.trim() || r.error?.message}`);
  },
};
