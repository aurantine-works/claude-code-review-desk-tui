import fs from 'node:fs';
import { paths } from './paths.js';
import { nowIso } from './time.js';

/**
 * Append an entry to logs/rd.log: `<ISO time> [scope] [ERROR ]<text>`. Never throws (hooks must not fail).
 * Failures carry the `ERROR ` marker (`rd doctor` counts them); an Error object is always one, a plain message is
 * informational unless `level` says 'error'.
 */
export function logLine(scope, message, level = message instanceof Error ? 'error' : 'info') {
  try {
    fs.mkdirSync(paths.logs(), { recursive: true, mode: 0o700 });
    const text = message instanceof Error ? message.stack || message.message : String(message);
    fs.appendFileSync(paths.log(), `${nowIso()} [${scope}] ${level === 'error' ? 'ERROR ' : ''}${text}\n`);
  } catch {
    /* ignore */
  }
}
