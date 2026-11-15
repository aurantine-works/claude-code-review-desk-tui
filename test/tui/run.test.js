import { vi, describe, it, expect, afterEach } from 'vitest';
import { useTempHome } from '../helpers/env.js';

// runTui owns the terminal lifecycle; here only the options it hands to Ink matter.
const render = vi.fn(() => ({ waitUntilExit: async () => {}, unmount() {} }));
vi.mock('ink', async (orig) => ({ ...(await orig()), render: (...a) => render(...a) }));
vi.mock('../../src/tui/App.js', () => ({ App: () => null }));
vi.mock('../../src/tui/mouse/index.js', () => ({ createBus: () => ({}), createFilteredStdin: () => ({ dispose() {} }) }));
vi.mock('../../src/tui/terminal.js', () => ({
  enableMouse: vi.fn(),
  enablePaste: vi.fn(),
  disableWrap: vi.fn(),
  restoreTerminal: vi.fn(),
  installCleanup: vi.fn(() => () => {}),
}));

const { runTui } = await import('../../src/tui/run.js');

useTempHome();
const ttys = {};
const setTty = (stream, value) => {
  ttys[stream] ??= Object.getOwnPropertyDescriptor(process[stream], 'isTTY');
  Object.defineProperty(process[stream], 'isTTY', { value, configurable: true, writable: true });
};
afterEach(() => {
  for (const [stream, d] of Object.entries(ttys)) {
    if (d) Object.defineProperty(process[stream], 'isTTY', d);
    else delete process[stream].isTTY;
  }
  render.mockClear();
});

describe('runTui', () => {
  it('does not let Ink quit on Ctrl+C (the screens handle it so an unsent comment is not lost)', async () => {
    setTty('stdin', true);
    setTty('stdout', true);
    await runTui({ watch: true });
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][1]).toMatchObject({ exitOnCtrlC: false, alternateScreen: true });
  });

  it('refuses to run without a terminal', async () => {
    setTty('stdin', false);
    await expect(runTui({})).rejects.toThrow(/interactive terminal/);
    expect(render).not.toHaveBeenCalled();
  });
});
