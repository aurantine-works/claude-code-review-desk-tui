import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { looksLikeClaude, readProc, findClaudeProcess, findClaudePid, isSameProcessAlive, claudeSessionIdFromEnv } from '../src/store/proc.js';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-proc-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Fake /proc/<pid>/{stat,cmdline}. comm may contain spaces and parentheses. */
function fake(pid, ppid, argv, comm = 'x', startTime = 5000 + pid) {
  fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
  // proc(5): state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime
  fs.writeFileSync(path.join(root, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 100 200\n`);
  fs.writeFileSync(path.join(root, String(pid), 'cmdline'), argv.join('\0') + '\0');
}

describe('looksLikeClaude', () => {
  it('recognises the native binary (argv0 = claude, with or without a path)', () => {
    expect(looksLikeClaude(['claude', '--session-id', 'x'])).toBe(true);
    expect(looksLikeClaude(['/root/.local/bin/claude'])).toBe(true);
  });
  it('recognises the npm build run by node/bun', () => {
    expect(looksLikeClaude(['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'])).toBe(true);
    expect(looksLikeClaude(['/usr/bin/node', '--no-warnings', '/home/u/bin/claude'])).toBe(true);
    expect(looksLikeClaude(['bun', '/opt/@anthropic-ai/claude-code/cli.js', '-p'])).toBe(true);
  });
  it('rejects look-alikes', () => {
    expect(looksLikeClaude(['node', '/x/bin/rd.js', 'hook', 'stop'])).toBe(false);
    expect(looksLikeClaude(['/usr/bin/node', '/root/projects/ccd/bin/ccd.js', '__daemon', 'claude'])).toBe(false);
    expect(looksLikeClaude(['bash', '-c', 'claude --help'])).toBe(false);
    expect(looksLikeClaude(['claude-helper'])).toBe(false);
    expect(looksLikeClaude([])).toBe(false);
  });
});

describe('readProc', () => {
  it('reads the real start time from /proc/self (field 22)', () => {
    const real = readProc(process.pid);
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    expect(real.startTime).toBe(Number(fields[19]));
    expect(real.startTime).toBeGreaterThan(0);
  });
  it('parses ppid even when comm contains spaces and parentheses', () => {
    fake(10, 5, ['a', 'b'], 'we ird) (name');
    expect(readProc(10, root)).toEqual({ pid: 10, ppid: 5, argv: ['a', 'b'], startTime: 5010 });
  });
  it('returns null for a missing pid', () => {
    expect(readProc(999, root)).toBeNull();
  });
});

describe('findClaudeProcess', () => {
  it('walks up through sh to the claude process', () => {
    fake(100, 1, ['bash']);
    fake(200, 100, ['claude', '--resume']);
    fake(300, 200, ['sh', '-c', 'rd hook stop']);
    fake(400, 300, ['node', '/x/bin/rd.js', 'hook', 'stop']);
    expect(findClaudeProcess({ start: 300, procRoot: root, env: {} })).toEqual({ pid: 200, via: 'walk', startTime: 5200 });
    expect(findClaudePid({ start: 400, procRoot: root, env: {} })).toBe(200);
  });
  it('picks the nearest claude when claude runs claude', () => {
    fake(1000, 1, ['claude']);
    fake(2000, 1000, ['claude']);
    fake(3000, 2000, ['sh']);
    expect(findClaudePid({ start: 3000, procRoot: root, env: {} })).toBe(2000);
  });
  it('prefers a valid CLAUDE_PID over the process walk', () => {
    fake(200, 1, ['claude']);
    fake(150, 1, ['claude']); // an unrelated claude further up the walk
    fake(300, 150, ['sh', '-c', 'rd hook stop']);
    const r = findClaudeProcess({ start: 300, procRoot: root, env: { CLAUDE_PID: '200' }, alive: () => true });
    expect(r).toEqual({ pid: 200, via: 'env', startTime: 5200 });
  });
  it('ignores a CLAUDE_PID that is dead, recycled (not claude any more) or malformed', () => {
    fake(150, 1, ['claude']);
    fake(300, 150, ['sh']);
    fake(777, 1, ['vim', 'notes.txt']); // pid reuse
    const walk = { pid: 150, via: 'walk', startTime: 5150 };
    expect(findClaudeProcess({ start: 300, procRoot: root, env: { CLAUDE_PID: '777' }, alive: () => true })).toEqual(walk);
    expect(findClaudeProcess({ start: 300, procRoot: root, env: { CLAUDE_PID: '888' }, alive: () => false })).toEqual(walk);
    for (const bad of ['', 'abc', '1', '-5', '1.5']) {
      expect(findClaudeProcess({ start: 300, procRoot: root, env: { CLAUDE_PID: bad } })).toEqual(walk);
    }
  });
  it('trusts a live CLAUDE_PID when /proc has no entry for it (non-Linux), then falls back to the start pid', () => {
    fake(50, 1, ['bash']);
    fake(60, 50, ['sh']);
    expect(findClaudeProcess({ start: 60, procRoot: root, env: { CLAUDE_PID: '777' }, alive: (p) => p === 777 })).toEqual({ pid: 777, via: 'env', startTime: null });
    expect(findClaudeProcess({ start: 60, procRoot: root, env: { CLAUDE_PID: '777' }, alive: () => false })).toEqual({ pid: 60, via: 'ppid', startTime: null });
    expect(findClaudeProcess({ start: 60, procRoot: root, env: {} })).toEqual({ pid: 60, via: 'ppid', startTime: null });
  });
  it('does not loop on a cyclic or unreadable tree', () => {
    fake(7, 8, ['a']);
    fake(8, 7, ['b']);
    expect(findClaudeProcess({ start: 7, procRoot: root, env: {} }).via).toBe('ppid');
  });
});

describe('isSameProcessAlive', () => {
  it('is false for a dead pid, true for the same process, false when the pid was recycled', () => {
    fake(200, 1, ['claude'], 'claude', 1234);
    const claude = { pid: 200, startTime: 1234 };
    expect(isSameProcessAlive(claude, { procRoot: root, alive: () => true })).toBe(true);
    expect(isSameProcessAlive(claude, { procRoot: root, alive: () => false })).toBe(false);
    fake(200, 1, ['claude'], 'claude', 9999); // same pid, new process
    expect(isSameProcessAlive(claude, { procRoot: root, alive: () => true })).toBe(false);
  });
  it('degrades to a plain liveness check without a start time or without /proc', () => {
    expect(isSameProcessAlive({ pid: 4242, startTime: null }, { procRoot: root, alive: () => true })).toBe(true);
    expect(isSameProcessAlive({ pid: 4242, startTime: 5 }, { procRoot: root, alive: () => true })).toBe(true);
  });
});

describe('claudeSessionIdFromEnv', () => {
  it('returns CLAUDE_CODE_SESSION_ID when it is a safe id', () => {
    expect(claudeSessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: '7b9a8bb5-d327-442b-860e-ba3294fecdd6' })).toBe('7b9a8bb5-d327-442b-860e-ba3294fecdd6');
    for (const bad of [undefined, '', '../x', '__proto__', 'a b']) expect(claudeSessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: bad })).toBeNull();
  });
});
