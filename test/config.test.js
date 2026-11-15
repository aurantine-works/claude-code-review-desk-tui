import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { DEFAULT_CONFIG, loadConfig, loadConfigChecked, validateConfig, AUTO_RESUME_VALUES } from '../src/config.js';
import { paths } from '../src/store/paths.js';

const home = useTempHome();
const write = (obj) => fs.writeFileSync(paths.config(), JSON.stringify(obj));

describe('delivery.autoResume', () => {
  it('defaults to "ask" (the "session ended" dialog)', () => {
    expect(DEFAULT_CONFIG.delivery.autoResume).toBe('ask');
    expect(loadConfig().delivery.autoResume).toBe('ask');
    expect(AUTO_RESUME_VALUES).toEqual(['ask', 'headless']);
  });

  it('accepts "headless" and keeps the other delivery defaults', () => {
    write({ delivery: { autoResume: 'headless' } });
    const { config, problems } = loadConfigChecked();
    expect(problems).toEqual([]);
    expect(config.delivery).toMatchObject({ autoResume: 'headless', autoInject: true, claudeBin: 'claude' });
  });

  it('anything else falls back to "ask" and is reported', () => {
    for (const bad of ['sometimes', true, 1, null, ['headless']]) {
      write({ delivery: { autoResume: bad } });
      const { config, problems } = loadConfigChecked();
      expect(config.delivery.autoResume).toBe('ask');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('delivery.autoResume');
    }
    expect(loadConfig().delivery.autoResume).toBe('ask');
  });

  it('validateConfig does not mutate its input', () => {
    const input = { ...structuredClone(DEFAULT_CONFIG), delivery: { ...DEFAULT_CONFIG.delivery, autoResume: 'x' } };
    const out = validateConfig(input);
    expect(input.delivery.autoResume).toBe('x');
    expect(out.config.delivery.autoResume).toBe('ask');
  });

  it('a corrupt or missing config.json gives the defaults', () => {
    expect(home()).toBeTruthy();
    expect(loadConfigChecked().problems).toEqual([]);
    fs.writeFileSync(paths.config(), '{nope');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });
});
