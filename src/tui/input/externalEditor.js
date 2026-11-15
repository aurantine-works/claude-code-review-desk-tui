/**
 * Edit text in an external editor through a temp file.
 *
 * Editor: `config.editor`, else `$VISUAL`, else `$EDITOR`, else `vi`. The command is split on whitespace (quotes group words) and
 * started with `spawn` and an argument array: no shell, so a file name can never be interpreted. Editors that understand
 * `+<line>` (vi, vim, nvim, nano, emacs) open on the last line of the file, where the text goes.
 *
 * The file is created 0600 in `dir` (the TUI passes `RD_HOME/tmp`, `rd gc` clears leftovers there; without `dir` a fresh 0700
 * directory under the OS temp dir is used) and is always removed again. A file starts with an optional header of `# ` comment
 * lines explaining what is being edited; exactly those lines are dropped from the result (a user's own `# Heading` is text).
 *
 * Pair it with `suspendForEditor` (terminal.js): mouse, bracketed paste and Ink's input are paused while the editor owns the tty.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/** Split a command line into words. Single / double quotes group, a backslash escapes the next character (not inside single quotes). */
export function splitCommand(text) {
  const words = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < text.length && /["\\$`]/.test(text[i + 1])) cur += text[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      cur += text[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (cur !== '' || started) words.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (cur !== '' || started) words.push(cur);
  return words;
}

/** The editor command to use: `config.editor`, `$VISUAL`, `$EDITOR`, `vi`. */
export function resolveEditor({ env = process.env, config = null } = {}) {
  for (const candidate of [config?.editor, env.VISUAL, env.EDITOR]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return 'vi';
}

const LINE_ARG_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs']);

/**
 * Remove the header lines from edited text: only lines that are exactly one of `header` go; then leading blank lines and
 * trailing whitespace. CRLF becomes LF.
 */
export function stripHeader(text, header = []) {
  const drop = new Set(header);
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => !drop.has(l));
  while (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\n').replace(/\s+$/, '');
}

/**
 * @typedef {'saved'|'unchanged'|'empty'|'failed'} EditStatus
 *   saved      the editor exited 0 and the text differs from what was offered
 *   unchanged  exited 0, file identical to what was offered
 *   empty      exited 0, nothing left after removing the header
 *   failed     could not be started, was killed, or exited non-zero (`code` / `signal` / `error`)
 * @typedef {{status: EditStatus, text: string, editor: string, code?: number|null, signal?: string|null, error?: string}} EditResult
 */

/**
 * @param {string} initialText
 * @param {object} [opts]
 * @param {(fn: () => Promise<any>) => Promise<any>} [opts.suspend]  Hands the terminal over, e.g. `(fn) => suspendForEditor(fn, { suspendTerminal, stdin })`.
 * @param {string} [opts.editor]     Overrides config / `$VISUAL` / `$EDITOR`. May contain arguments (`code -w`).
 * @param {object} [opts.config]     rd config (`config.editor`).
 * @param {string} [opts.extension='.md']  Extension of the temp file (syntax highlighting).
 * @param {string} [opts.dir]        Directory for the temp file (must exist).
 * @param {string[]} [opts.header]   Comment lines (each starting with `# `) put above the text and removed from the result.
 * @returns {Promise<EditResult>}  Never rejects.
 */
export async function editInEditor(initialText, { suspend, editor, config, extension = '.md', dir, header = [] } = {}) {
  const cmd = editor ?? resolveEditor({ config });
  const argv = splitCommand(cmd);
  if (argv.length === 0) return { status: 'failed', text: '', editor: cmd, error: 'empty editor command' };

  let ownDir = null;
  let file;
  try {
    if (dir) {
      file = path.join(dir, `rd-edit-${process.pid}-${crypto.randomBytes(4).toString('hex')}${extension}`);
    } else {
      ownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-edit-'));
      fs.chmodSync(ownDir, 0o700);
      file = path.join(ownDir, `comment${extension}`);
    }
    const body = initialText === '' || initialText.endsWith('\n') ? initialText : `${initialText}\n`;
    const offered = header.length ? `${header.join('\n')}\n\n${body}` : body;
    fs.writeFileSync(file, offered, { mode: 0o600, flag: 'wx' });
    const parts = offered.split('\n');
    const lastLine = Math.max(1, offered.endsWith('\n') ? parts.length - 1 : parts.length); // where the text goes

    const args = [...argv.slice(1)];
    if (LINE_ARG_EDITORS.has(path.basename(argv[0]))) args.push(`+${lastLine}`);
    args.push(file);

    const run = () =>
      new Promise((resolve) => {
        let child;
        try {
          child = spawn(argv[0], args, { stdio: 'inherit' });
        } catch (err) {
          resolve({ code: null, signal: null, error: err.message });
          return;
        }
        child.on('error', (err) => resolve({ code: null, signal: null, error: err.code === 'ENOENT' ? `${argv[0]}: command not found` : err.message }));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
    const ended = suspend ? await suspend(run) : await run();
    if (ended.error) return { status: 'failed', text: '', editor: cmd, error: ended.error };
    if (ended.code !== 0) return { status: 'failed', text: '', editor: cmd, code: ended.code, signal: ended.signal ?? null };

    const after = fs.readFileSync(file, 'utf8');
    const text = stripHeader(after, header);
    if (after === offered) return { status: 'unchanged', text, editor: cmd };
    return { status: text.trim() === '' ? 'empty' : 'saved', text, editor: cmd };
  } catch (err) {
    return { status: 'failed', text: '', editor: cmd, error: err.message };
  } finally {
    if (file) fs.rmSync(file, { force: true });
    if (ownDir) fs.rmSync(ownDir, { recursive: true, force: true });
  }
}

/**
 * Legacy shape of editInEditor(): the edited text without trailing whitespace, or `null` if the editor could not be started
 * or exited non-zero (keep the old text).
 * @returns {Promise<string | null>}
 */
export async function editExternally(initialText, opts = {}) {
  const r = await editInEditor(initialText, opts);
  return r.status === 'failed' ? null : r.text;
}
