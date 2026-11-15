import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { splitCommand, resolveEditor, stripHeader, editInEditor, editExternally } from '../../src/tui/input/externalEditor.js';
import { buildEditorHeader } from '../../src/tui/lib/editorHeader.js';

const FAKE = fileURLToPath(new URL('../helpers/fake-editor.js', import.meta.url));
let dir;
let log;
const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-editor-unit-'));
  log = path.join(dir, 'log');
  process.env.FAKE_EDITOR_LOG = log;
});
afterEach(() => {
  for (const k of ['FAKE_EDITOR_LOG', 'FAKE_EDITOR_MODE', 'FAKE_EDITOR_TEXT']) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});
const fakeCmd = `"${process.execPath}" "${FAKE}"`;

describe('splitCommand', () => {
  it('splits on whitespace, groups quotes, honours backslashes', () => {
    expect(splitCommand('vim')).toEqual(['vim']);
    expect(splitCommand('code -w --new-window')).toEqual(['code', '-w', '--new-window']);
    expect(splitCommand('  emacsclient   -t  ')).toEqual(['emacsclient', '-t']);
    expect(splitCommand('"/Program Files/ed/ed" --flag')).toEqual(['/Program Files/ed/ed', '--flag']);
    expect(splitCommand("'/a b/c' -x 'it''s'")).toEqual(['/a b/c', '-x', 'its']);
    expect(splitCommand('/a\\ b/c d')).toEqual(['/a b/c', 'd']);
    expect(splitCommand('a "" b')).toEqual(['a', '', 'b']);
    expect(splitCommand('')).toEqual([]);
  });
  it('never interprets shell syntax', () => {
    expect(splitCommand('vim; rm -rf / $(x) `y` | z')).toEqual(['vim;', 'rm', '-rf', '/', '$(x)', '`y`', '|', 'z']);
  });
});

describe('resolveEditor', () => {
  it('config.editor, then $VISUAL, then $EDITOR, then vi', () => {
    expect(resolveEditor({ env: {}, config: null })).toBe('vi');
    expect(resolveEditor({ env: { EDITOR: 'nano' } })).toBe('nano');
    expect(resolveEditor({ env: { EDITOR: 'nano', VISUAL: 'vim' } })).toBe('vim');
    expect(resolveEditor({ env: { EDITOR: 'nano', VISUAL: 'vim' }, config: { editor: 'code -w' } })).toBe('code -w');
    expect(resolveEditor({ env: { EDITOR: 'nano', VISUAL: '  ' }, config: { editor: null } })).toBe('nano');
  });
});

describe('stripHeader', () => {
  const header = ['# Review Desk · Comment L1', '# Save and quit = send.'];
  it('drops exactly the header lines; a user\'s own # heading stays', () => {
    expect(stripHeader('# Review Desk · Comment L1\n# Save and quit = send.\n\n# My heading\nbody\n', header)).toBe('# My heading\nbody');
  });
  it('an edited header line is text, not a comment', () => {
    expect(stripHeader('# Review Desk · Comment L1 (edited)\nbody', header)).toBe('# Review Desk · Comment L1 (edited)\nbody');
  });
  it('trims leading blank lines and trailing whitespace, keeps indentation, normalises CRLF', () => {
    expect(stripHeader('\n\n  indented\r\n  second line\r\n\r\n', [])).toBe('  indented\n  second line');
  });
});

describe('buildEditorHeader', () => {
  it('names the target, quotes the first three lines and explains the save', () => {
    const lines = buildEditorHeader({ kind: 'comment', label: 'L14-18', quote: ['one', 'two', 'three', 'four', 'five'].join('\n'), sendMode: 'instant' });
    expect(lines.every((l) => l.startsWith('# '))).toBe(true);
    expect(lines[0]).toBe('# Review Desk · Comment L14-18');
    expect(lines.filter((l) => l.startsWith('#   > '))).toEqual(['#   > one', '#   > two', '#   > three', '#   > … (2 more lines)']);
    expect(lines.join('\n')).toContain('# Save and quit = send; empty or unchanged = cancel.');
  });
  it('batch mode says draft, box mode says it goes back to the box, long lines are clipped', () => {
    expect(buildEditorHeader({ kind: 'reply', label: 't3', sendMode: 'batch' }).join('\n')).toContain('save as draft (s submits)');
    expect(buildEditorHeader({ kind: 'comment', label: 'L1', sendMode: 'batch', purpose: 'box' }).join('\n')).toContain('back to the input box to keep editing');
    // CJK text counts two columns per character: the clip must cut by width, not by characters
    const long = buildEditorHeader({ kind: 'comment', label: 'L1', quote: '很长'.repeat(100), sendMode: 'instant' }).find((l) => l.startsWith('#   > '));
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(100);
  });
  it('no quote, no quote block', () => {
    expect(buildEditorHeader({ kind: 'comment', label: 'L1', sendMode: 'instant' }).join('\n')).not.toContain('Quote');
  });
});

describe('editInEditor', () => {
  it('saved / unchanged / empty / failed', async () => {
    process.env.FAKE_EDITOR_TEXT = 'new content';
    expect(await editInEditor('old', { editor: fakeCmd, dir })).toMatchObject({ status: 'saved', text: 'old\nnew content' });
    process.env.FAKE_EDITOR_MODE = 'same';
    expect(await editInEditor('old', { editor: fakeCmd, dir })).toMatchObject({ status: 'unchanged', text: 'old' });
    process.env.FAKE_EDITOR_MODE = 'clear';
    expect(await editInEditor('old', { editor: fakeCmd, dir })).toMatchObject({ status: 'empty', text: '' });
    process.env.FAKE_EDITOR_MODE = 'fail';
    expect(await editInEditor('old', { editor: fakeCmd, dir })).toMatchObject({ status: 'failed', code: 3 });
    process.env.FAKE_EDITOR_MODE = 'signal';
    expect(await editInEditor('old', { editor: fakeCmd, dir })).toMatchObject({ status: 'failed', signal: 'SIGKILL' });
    expect(await editInEditor('old', { editor: '/no/such/editor', dir })).toMatchObject({ status: 'failed', error: '/no/such/editor: command not found' });
    expect(await editInEditor('old', { editor: '   ', dir })).toMatchObject({ status: 'failed' });
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('rd-edit-'))).toEqual([]); // every temp file is gone, failures included
  });

  it('the file is private (0600), lives in `dir`, and the header precedes the text and is not returned', async () => {
    process.env.FAKE_EDITOR_TEXT = 'x';
    const header = ['# header one', '# header two'];
    const r = await editInEditor('body', { editor: fakeCmd, dir, header });
    expect(r).toMatchObject({ status: 'saved', text: 'body\nx' });
    const [run] = runs();
    expect(run.mode).toBe(0o600);
    expect(path.dirname(run.file)).toBe(dir);
    expect(path.basename(run.file)).toMatch(/^rd-edit-\d+-[0-9a-f]{8}\.md$/);
    expect(run.content).toBe('# header one\n# header two\n\nbody\n');
  });

  it('runs without a shell: a command with shell syntax is just words, a file name is just a file name', async () => {
    const marker = path.join(dir, 'pwned');
    const r = await editInEditor('a', { editor: `${fakeCmd} ; touch ${marker}`, dir });
    // fake-editor.js receives ";", "touch", "<marker>", <file>: it edits the last one
    expect(r.status).toBe('saved');
    expect(runs()[0].argv.slice(0, 3)).toEqual([';', 'touch', marker]);
    expect(fs.existsSync(marker)).toBe(false);
    const spaced = path.join(dir, 'dir with spaces & $(x)');
    fs.mkdirSync(spaced);
    expect((await editInEditor('a', { editor: fakeCmd, dir: spaced })).status).toBe('saved');
    expect(runs().at(-1).file.startsWith(spaced)).toBe(true);
  });

  it('an editor path with spaces works when quoted; extra arguments come before the file', async () => {
    const bin = path.join(dir, 'my editors');
    fs.mkdirSync(bin);
    const script = path.join(bin, 'ed.js');
    fs.copyFileSync(FAKE, script);
    const r = await editInEditor('a', { editor: `"${process.execPath}" "${script}" --wait -x`, dir });
    expect(r.status).toBe('saved');
    expect(runs()[0].argv.slice(0, 2)).toEqual(['--wait', '-x']);
  });

  it('vi-like editors get +<last line> so they open where the text goes', async () => {
    for (const name of ['vim', 'nano', 'notvim']) {
      const wrapper = path.join(dir, name);
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
      await editInEditor('one\ntwo', { editor: wrapper, dir, header: ['# h1', '# h2'] });
    }
    const [vim, nano, other] = runs();
    // file: "# h1\n# h2\n\none\ntwo\n" -> 5 lines
    expect(vim.argv[0]).toBe('+5');
    expect(nano.argv[0]).toBe('+5');
    expect(other.argv[0]).not.toMatch(/^\+/);
    process.env.FAKE_EDITOR_MODE = 'same';
    await editInEditor('', { editor: path.join(dir, 'vim'), dir, header: ['# h1'] });
    expect(runs().at(-1).argv[0]).toBe('+2'); // header, blank line: the cursor lands on the blank line
  });

  it('uses the suspend wrapper around the editor, and a throwing wrapper is a failed result, not a rejection', async () => {
    const calls = [];
    const suspend = vi.fn(async (fn) => {
      calls.push('suspend');
      const r = await fn();
      calls.push('resume');
      return r;
    });
    expect((await editInEditor('a', { editor: fakeCmd, dir, suspend })).status).toBe('saved');
    expect(calls).toEqual(['suspend', 'resume']);
    const r = await editInEditor('a', { editor: fakeCmd, dir, suspend: async () => { throw new Error('terminal gone'); } });
    expect(r).toMatchObject({ status: 'failed', error: 'terminal gone' });
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('rd-edit-'))).toEqual([]);
  });

  it('without `dir` a private directory under the OS temp dir is used and removed', async () => {
    expect((await editInEditor('a', { editor: fakeCmd })).status).toBe('saved');
    const f = runs()[0].file;
    expect(f.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(path.dirname(f))).toBe(false);
  });

  it('editExternally keeps its old contract (text, or null on failure / when nothing was written)', async () => {
    expect(await editExternally('a', { editor: fakeCmd })).toBe('a\nedited');
    process.env.FAKE_EDITOR_MODE = 'fail';
    expect(await editExternally('a', { editor: fakeCmd })).toBeNull();
  });
});
