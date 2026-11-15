// README.md is documentation people act on: keep it honest. The key tables are generated from the `?` help, the config table must
// list every key of DEFAULT_CONFIG with its default, every command and option of the CLI must be mentioned, and the Claude Code
// version that `rd doctor` compares against is the one the README names.
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { renderKeyBlock } from './helpers/readmeKeys.mjs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { VERIFIED_CLAUDE_VERSION } from '../src/cli/doctor.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const README = read('../README.md');

const leaves = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? leaves(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));

describe('README.md', () => {
  it('the key tables are exactly what the ? help is made of (run `node test/helpers/readmeKeys.mjs --write` to refresh them)', () => {
    const a = README.indexOf('<!-- keys:start');
    const b = README.indexOf('<!-- keys:end -->') + '<!-- keys:end -->'.length;
    expect(a).toBeGreaterThan(-1);
    expect(README.slice(a, b)).toBe(renderKeyBlock());
  });

  it('names the verified Claude Code version that rd doctor compares with', () => {
    expect(README).toContain(`**Verified Claude Code version: \`${VERIFIED_CLAUDE_VERSION}\`**`);
  });

  it('has the sections that rd doctor hints refer to', () => {
    expect(README).toMatch(/^#+ Status line$/m);
    expect(README).toMatch(/^#+ Verified versions$/m);
  });

  it('lists every config key with its default value', () => {
    for (const [key, value] of leaves(DEFAULT_CONFIG)) {
      const row = README.split('\n').find((l) => l.startsWith(`| \`${key}\` |`));
      expect(row, `config key ${key}`).toBeTruthy();
      expect(row, `default of ${key}`).toContain(`\`${JSON.stringify(value)}\``);
    }
  });

  it('mentions every command and every documented option of the CLI', () => {
    const sources = [read('../bin/rd.js'), read('../src/cli/tuiCommands.js')].join('\n');
    const commands = [...sources.matchAll(/\.command\('([a-z]+)/g)].map((m) => m[1]);
    expect(commands.length).toBeGreaterThan(15);
    for (const c of commands) expect(README, `command rd ${c}`).toMatch(new RegExp(`\`rd ${c}\\b|\`rd( \\/ \`rd)? ${c}\\b|rd ${c}\\b`));
    const flags = new Set([...sources.matchAll(/\.option\('([^']+)'/g)].flatMap((m) => m[1].match(/--[a-z-]+/g) ?? []));
    for (const f of flags) expect(README, `option ${f}`).toContain(f);
  });

  it('links to files that exist', () => {
    for (const m of README.matchAll(/\]\((docs\/[^)]+)\)/g)) expect(fs.existsSync(new URL(`../${m[1]}`, import.meta.url)), m[1]).toBe(true);
  });

  it('documents the M4 behaviour it promises: --config-dir, --dry-run for uninstall, doctor --fix, gc defaults', () => {
    expect(README).toContain('rd install --config-dir ./.claude');
    expect(README).toContain('rd uninstall --dry-run');
    expect(README).toContain('rd doctor --fix');
    expect(README).toMatch(/rd gc --days 30/);
  });
});
