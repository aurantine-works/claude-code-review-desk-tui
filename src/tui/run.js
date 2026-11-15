// Starts the TUI: owns the terminal lifecycle (alternate screen, mouse, bracketed paste, raw mode) and makes
// sure every one of them is restored on quit, crash and signals.
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { createBus, createFilteredStdin } from './mouse/index.js';
import { disableWrap, enableMouse, enablePaste, installCleanup, restoreTerminal } from './terminal.js';
import { loadConfig } from '../config.js';
import { logLine } from '../store/index.js';

const h = React.createElement;

/**
 * @param {object} o
 * @param {string} [o.reviewId]  open this review (and quit on `q`)
 * @param {boolean} [o.watch]    auto-open new plan reviews, ring the bell
 * @returns {Promise<void>}
 */
export async function runTui({ reviewId, watch = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('rd needs an interactive terminal (stdin and stdout must be a TTY)');
  }
  const config = loadConfig();
  const bus = createBus();
  const stdin = createFilteredStdin(process.stdin, bus);
  let app = null;
  // Crash / signal path: let Ink tear down first (it leaves the alternate screen and drops its last frame);
  // the leftover sequences in the handler only cover a failed teardown.
  const uninstall = installCleanup({
    alternateScreen: true,
    beforeRestore: () => app?.unmount(),
  });
  let failure = null;
  try {
    if (config.ui?.mouse !== false) enableMouse();
    enablePaste();
    disableWrap(); // overflowing rows are clipped instead of wrapped, so rows on screen stay where rd drew them
    app = render(h(App, { bus, config, reviewId, watch }), {
      stdin,
      alternateScreen: true,
      // Ctrl+C is handled by the screens (cancel the comment box, otherwise quit like `q`); letting Ink exit on
      // it would drop an unsent comment without asking.
      exitOnCtrlC: false,
      patchConsole: true,
      incrementalRendering: true,
    });
    await app.waitUntilExit();
  } catch (err) {
    failure = err;
    logLine('tui', err);
  } finally {
    stdin.dispose();
    restoreTerminal();
    uninstall();
  }
  if (failure) throw failure;
}
