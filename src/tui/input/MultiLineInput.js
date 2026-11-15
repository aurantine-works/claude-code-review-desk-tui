/**
 * MultiLineInput: the in-place comment box (Ink component, no JSX / no build step).
 *
 * Keys (as delivered by Ink 8's `useInput`, see mouse/filteredStdin.js for the raw bytes):
 *   Enter                      submit (`onSubmit(text)`; ignored while the text is blank)
 *   Alt+Enter, Ctrl+J          insert a line break  (also Shift+Enter where the terminal reports it)
 *   Esc, Ctrl+C                `onCancel(hasContent)`; the parent confirms when hasContent is true
 *   Ctrl+E                     `onEditExternal(text)`; the parent runs $EDITOR, then feeds the result back via `value`
 *   Backspace / Delete         remove the previous / next grapheme
 *   Left Right Up Down         move by grapheme / visual row (display column is kept)
 *   Home / End                 start / end of the logical line
 *   any other text             inserted in one operation (an IME commit or an unbracketed paste is one chunk;
 *                              CR/LF inside it are line breaks, never "submit")
 * Bracketed paste arrives on `bus` ('paste') and is inserted as is: newlines stay newlines.
 *
 * Mouse is not handled here (the component does not know its absolute screen position); the
 * parent can map clicks with `mouse/layout.js` and move the caret by re-rendering with a new `value`.
 *
 * Layout: the component is `width` columns wide and `min(rows, maxRows)` rows high with no border
 * (the parent draws the frame). One column is reserved for the caret, so text wraps at `width - 1`.
 * When there are more than `maxRows` visual rows the box scrolls to keep the caret visible.
 *
 * `value` is "controlled enough": whenever it changes to something other than a value this
 * component just reported through `onChange`, the text is replaced and the caret goes to the end.
 * That is how the parent injects the result of an external editor. Without `value` it is uncontrolled.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  createEditor,
  insert,
  newline,
  backspace,
  deleteForward,
  left,
  right,
  up,
  down,
  home,
  end,
  visualRows,
} from './editor.js';
import { useBusEvent } from './useBus.js';

const h = React.createElement;

/**
 * @typedef {object} MultiLineInputProps
 * @property {string} [value]            Initial text; later changes (not echoes of onChange) replace the text.
 * @property {number} width              Total columns of the box.
 * @property {number} [maxRows=8]        Maximum visible rows before the box scrolls.
 * @property {(text: string) => void} [onSubmit]
 * @property {(hasContent: boolean) => void} [onCancel]
 * @property {(text: string) => void} [onChange]
 * @property {(text: string) => void} [onEditExternal]
 * @property {import('node:events').EventEmitter} [bus]  Source of 'paste' events.
 * @property {boolean} [isActive=true]   When false the box ignores keys/paste and hides the caret.
 * @property {string} [placeholder]      Dimmed text shown while empty.
 */

/**
 * Number of rows a MultiLineInput with this text will occupy (for positioning popups).
 * @param {string} text
 * @param {number} width    Same `width` prop as the component.
 * @param {number} [maxRows=8]
 */
export function inputHeight(text, width, maxRows = 8) {
  const rows = visualRows({ text, cursor: 0 }, Math.max(1, width - 1)).rows.length;
  return Math.max(1, Math.min(rows, maxRows));
}

/**
 * @param {MultiLineInputProps} props
 */
export function MultiLineInput({
  value,
  width,
  maxRows = 8,
  onSubmit,
  onCancel,
  onChange,
  onEditExternal,
  bus,
  isActive = true,
  placeholder,
}) {
  const textWidth = Math.max(1, width - 1);
  const [state, setState] = useState(() => createEditor(value ?? ''));
  const stateRef = useRef(state);
  const echoes = useRef([]); // values reported via onChange that the parent may feed back
  const scrollRef = useRef(0);
  const props = useRef({});
  props.current = { onSubmit, onCancel, onChange, onEditExternal, textWidth };

  const apply = useCallback((next) => {
    const prev = stateRef.current;
    if (next === prev) return;
    stateRef.current = next;
    setState(next);
    if (next.text !== prev.text) {
      echoes.current.push(next.text);
      if (echoes.current.length > 64) echoes.current.shift();
      props.current.onChange?.(next.text);
    }
  }, []);

  // External value changes (e.g. text returned by $EDITOR).
  useEffect(() => {
    if (value === undefined) return;
    const k = echoes.current.indexOf(value);
    if (k !== -1) {
      echoes.current.splice(0, k + 1); // an echo of our own onChange
      return;
    }
    if (value !== stateRef.current.text) {
      echoes.current = [];
      const next = createEditor(value);
      stateRef.current = next;
      setState(next);
    }
  }, [value]);

  useInput(
    (input, key) => {
      const s = stateRef.current;
      const w = props.current.textWidth;
      if (key.escape || (key.ctrl && input === 'c')) {
        props.current.onCancel?.(s.text.length > 0);
        return;
      }
      if (key.return) {
        if (key.meta || key.shift) apply(newline(s));
        else if (s.text.trim() !== '') props.current.onSubmit?.(s.text);
        return;
      }
      if ((input === '\n' || (key.ctrl && input === 'j')) && !key.meta) {
        apply(newline(s));
        return;
      }
      if (key.ctrl && input === 'e') {
        props.current.onEditExternal?.(s.text);
        return;
      }
      if (key.backspace) apply(backspace(s));
      else if (key.delete) apply(deleteForward(s));
      else if (key.leftArrow) apply(left(s));
      else if (key.rightArrow) apply(right(s));
      else if (key.upArrow) apply(up(s, w));
      else if (key.downArrow) apply(down(s, w));
      else if (key.home) apply(home(s));
      else if (key.end) apply(end(s));
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.escape) apply(insert(s, input));
    },
    { isActive },
  );

  useBusEvent(bus, 'paste', (text) => apply(insert(stateRef.current, text)), { isActive });

  // --- render -------------------------------------------------------------------------------
  const view = visualRows(state, textWidth);
  const total = view.rows.length;
  const height = Math.max(1, Math.min(total, maxRows));
  let top = scrollRef.current;
  if (view.cursor.row < top) top = view.cursor.row;
  if (view.cursor.row >= top + height) top = view.cursor.row - height + 1;
  top = Math.max(0, Math.min(top, total - height));
  scrollRef.current = top;

  const showPlaceholder = state.text === '' && placeholder;
  const lines = [];
  for (let r = top; r < top + height; r++) {
    const row = view.rows[r];
    const isCursorRow = isActive && r === view.cursor.row;
    if (showPlaceholder && r === 0) {
      lines.push(
        h(
          Text,
          { key: r },
          isActive ? h(Text, { inverse: true }, ' ') : null,
          h(Text, { dimColor: true }, placeholder),
        ),
      );
      continue;
    }
    if (!isCursorRow) {
      lines.push(h(Text, { key: r }, row.text === '' ? ' ' : row.text));
      continue;
    }
    const ci = view.cursor.cell;
    const before = row.cells.slice(0, ci === -1 ? row.cells.length : ci).map((c) => c.display).join('');
    const cur = ci === -1 ? ' ' : row.cells[ci].display || ' ';
    const after = ci === -1 ? '' : row.cells.slice(ci + 1).map((c) => c.display).join('');
    lines.push(h(Text, { key: r }, before, h(Text, { inverse: true }, cur), after));
  }
  return h(Box, { flexDirection: 'column', width }, ...lines);
}

export default MultiLineInput;
