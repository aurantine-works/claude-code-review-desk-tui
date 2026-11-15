// Loaded with NODE_OPTIONS=--import to simulate a crash inside the running TUI: an uncaught exception after
// RD_SMOKE_CRASH_MS milliseconds. The terminal must still be restored.
setTimeout(() => {
  throw new Error('smoke: simulated crash');
}, Number(process.env.RD_SMOKE_CRASH_MS ?? 1500));
