import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { writeJsonAtomic, readJson, withLock } from '../src/store/io.js';

const home = useTempHome();

describe('atomic IO', () => {
  it('writes and reads back JSON', () => {
    const f = path.join(home(), 'a.json');
    writeJsonAtomic(f, { a: 1 });
    expect(readJson(f)).toEqual({ a: 1 });
  });
  it('leaves the old file intact and no temp files when rename fails', () => {
    const f = path.join(home(), 'a.json');
    writeJsonAtomic(f, { v: 1 });
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => writeJsonAtomic(f, { v: 2 })).toThrow('boom');
    spy.mockRestore();
    expect(readJson(f)).toEqual({ v: 1 });
    expect(fs.readdirSync(home()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('refuses to treat corrupt JSON as empty', () => {
    const f = path.join(home(), 'bad.json');
    fs.writeFileSync(f, '{oops');
    expect(() => readJson(f, {})).toThrow(/corrupt/);
  });
  it('serialises critical sections under withLock', async () => {
    const f = path.join(home(), 'counter.json');
    writeJsonAtomic(f, { n: 0 });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withLock(f, async () => {
          const { n } = readJson(f);
          await new Promise((r) => setTimeout(r, 5));
          writeJsonAtomic(f, { n: n + 1 });
        }),
      ),
    );
    expect(readJson(f).n).toBe(10);
  });
});
