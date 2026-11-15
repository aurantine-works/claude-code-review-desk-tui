// Small helpers shared by the injector adapters. Light on purpose: the session-start hook loads them.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { REVIEW_ID_RE } from '../../store/ids.js';

/** Locate an executable on PATH without spawning anything. */
export function whichSync(name, envPath = process.env.PATH ?? '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * execFile with an argument array (never a shell string), a timeout and no stdin.
 * Resolves { status, stdout, stderr, error }; never rejects.
 */
export function run(file, args, { timeout = 3000, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env, encoding: 'utf8', maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: stdout ?? '', stderr: stderr ?? '', error: error ?? null });
    });
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COMMAND = '/review-reply';

/**
 * The only texts an adapter ever types: `/review-reply <reviewId>` (id validated) or the bare `/review-reply`
 * wake-up. Comment text never goes through the terminal.
 */
export function isInjectable(text) {
  if (typeof text !== 'string') return false;
  if (text === COMMAND) return true;
  return text.startsWith(`${COMMAND} `) && REVIEW_ID_RE.test(text.slice(COMMAND.length + 1));
}

export function assertInjectable(text) {
  if (!isInjectable(text)) throw new Error(`refusing to inject ${JSON.stringify(text)}`);
  return text;
}

export const asInjector = (target, kind) => (typeof target === 'string' ? { kind, target } : target);

