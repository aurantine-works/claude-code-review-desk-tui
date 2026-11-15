// The chooser `rd add` / `rd open <path>` show in a terminal when several Claude Code sessions wrote the document
// (cli/addCmd.js loads it through loadPicker()). A minimal Ink list on the alternate screen: project, age, session, first prompt.
// Enter chooses, q / Esc / Ctrl-c cancel (null). It owns its Ink instance: when it returns the instance is unmounted and the
// terminal is as it was, because `rd open` starts the real TUI (another Ink instance) right after.
import React, { useReducer, useRef } from 'react';
import { Box, Text, render as inkRender, useInput, useWindowSize } from 'ink';
import { Row } from './Row.js';
import { candidateLine, movePick, pickWindow } from './lib/pickList.js';
import { fitSegs, ellipsizeStart } from './lib/ansi.js';
import { mapPickerKey, splitKeys } from './lib/keymap.js';
import { COLOR } from './lib/theme.js';
import { t } from '../i18n/index.js';

const h = React.createElement;

/**
 * The list screen. `onDone(candidate | null)` is called once.
 * @param {object} p
 * @param {import('./lib/pickList.js').Candidate[]} p.candidates
 * @param {string} p.path
 * @param {(c: object | null) => void} p.onDone
 * @param {{columns: number, rows: number}} [p.size]  overrides the terminal size (tests)
 */
export function CandidatePicker({ candidates, path, onDone, size }) {
  const win = useWindowSize();
  const dims = size ?? { columns: win.columns || 80, rows: win.rows || 24 };
  const [, bump] = useReducer((n) => n + 1, 0);
  const st = useRef({ index: 0, first: 0, done: false });
  const finish = (c) => {
    if (st.current.done) return;
    st.current.done = true;
    onDone(c);
  };

  useInput((input, key) => {
    // Keys typed in quick succession (SSH batching, a held key, `j` + Enter sent together) arrive as one string: each is a command.
    for (const [ch, k] of splitKeys(input, key)) {
      if (st.current.done) return;
      const r = mapPickerKey(ch, k);
      if (r === 'cancel') return finish(null);
      if (r === 'pick') return finish(candidates[st.current.index] ?? null);
      if (r) {
        st.current.index = movePick(st.current.index, candidates.length, r);
        bump();
      }
    }
    return undefined;
  });

  const cols = dims.columns;
  const room = Math.max(1, dims.rows - 6);
  st.current.first = pickWindow(st.current.index, candidates.length, room, st.current.first);
  const shown = candidates.slice(st.current.first, st.current.first + room);
  const cur = candidates[st.current.index];
  return h(
    Box,
    { flexDirection: 'column', width: cols },
    h(Text, { bold: true, color: COLOR.warn, wrap: 'truncate' }, t('pickCandidate.title', { n: candidates.length })),
    h(Text, { dimColor: true, wrap: 'truncate' }, ` ${ellipsizeStart(path, cols - 2)}`),
    h(Text, null, ' '),
    ...shown.map((c, i) => h(Row, { key: c.sessionId, segs: candidateLine(c, cols, st.current.first + i === st.current.index) })),
    h(Text, null, ' '),
    cur?.cwd ? h(Text, { dimColor: true, wrap: 'truncate' }, t('pickCandidate.cwd', { cwd: ellipsizeStart(cur.cwd, cols - 8) })) : h(Row, { segs: fitSegs([], cols) }),
    h(Text, { dimColor: true, wrap: 'truncate' }, cols >= 56 ? t('pickCandidate.hint') : t('pickCandidate.hintShort')),
  );
}

/**
 * Let the user choose one of `candidates` (`findWriters()` results: sessionId, cwd, project, lastAt, firstPrompt).
 * @param {object[]} candidates
 * @param {{path: string}} info
 * @param {{render?: Function, stdin?: object, size?: object}} [deps]  Ink's render (tests pass another one)
 * @returns {Promise<object | null>}  the chosen candidate, or null when cancelled
 */
export async function pickCandidate(candidates, { path }, deps = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const render = deps.render ?? inkRender;
  let resolve;
  const chosen = new Promise((r) => {
    resolve = r;
  });
  const options = deps.render ? {} : { alternateScreen: true, exitOnCtrlC: false, patchConsole: false, ...(deps.stdin ? { stdin: deps.stdin } : {}) };
  const app = render(h(CandidatePicker, { candidates, path, onDone: resolve, size: deps.size }), options);
  try {
    return await chosen;
  } finally {
    app.unmount(); // leaves the alternate screen, restores raw mode and the cursor
    try {
      await app.waitUntilExit?.();
    } catch {
      /* unmounting is all that matters */
    }
  }
}
