import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach } from 'vitest';

/** Point RD_HOME at a fresh temp dir for each test. */
export function useTempHome() {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-test-'));
    process.env.RD_HOME = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.RD_HOME;
  });
  return () => dir;
}
