// Inbox: the list of reviews that need attention. Data is polled by the App (2 s); selection, filter and
// confirmation live here.
import React, { useMemo, useReducer, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { Row, Rows } from './Row.js';
import { Help, inboxHelpEntries } from './Help.js';
import { useBusEvent } from './input/index.js';
import { buildRows, formatRow, inboxCounts, visibleMetas } from './lib/inboxModel.js';
import { fitSegs, pushSeg, ellipsize } from './lib/ansi.js';
import { COLOR, GLYPH } from './lib/theme.js';
import { t } from '../i18n/index.js';

const h = React.createElement;

const rule = (cols) => chalk.dim(GLYPH.hbar.repeat(cols));

/** Footer hints / confirmation as segments. What does not fit is left out (hints by priority), never cut in the middle. */
function footer({ cols, watch, confirm, showAll, notice }) {
  const bar = { bg: COLOR.bgBar };
  const segs = [];
  if (confirm) {
    // The question is cut, the y / n buttons stay.
    const yes = t('inbox.confirm');
    const no = t('inbox.cancel');
    const buttons = `y ${yes}  n ${no}`;
    const room = Math.max(0, cols - stringWidth(buttons) - 3);
    pushSeg(segs, ` ${ellipsize(confirm.text, room)} `, { bold: true, fg: COLOR.warn, ...bar });
    pushSeg(segs, 'y', { bold: true, fg: COLOR.accent, ...bar });
    pushSeg(segs, ` ${yes}  `, bar);
    pushSeg(segs, 'n', { bold: true, fg: COLOR.accent, ...bar });
    pushSeg(segs, ` ${no}`, bar);
  } else if (notice) {
    pushSeg(segs, ` ${ellipsize(notice, Math.max(0, cols - 2))}`, { fg: COLOR.ok, bold: true, ...bar });
  } else {
    let items = [
      { k: '↑↓/jk', label: t('inbox.select'), prio: 3 },
      { k: 'Enter', label: t('inbox.open'), prio: 10 },
      { k: 'a', label: showAll ? t('inbox.hideEnded') : t('inbox.showAll'), prio: 5 },
      { k: 'x', label: t('inbox.closeReview'), prio: 6 },
      { k: '?', label: t('inbox.help'), prio: 8 },
      { k: 'q', label: t('inbox.quit'), prio: 9 },
    ];
    const width = (list) => 1 + list.reduce((n, it) => n + stringWidth(it.k) + 1 + stringWidth(it.label), 0) + Math.max(0, list.length - 1) * 3;
    while (items.length > 1 && width(items) > cols - 1) {
      let drop = 0;
      items.forEach((it, i) => {
        if (it.prio < items[drop].prio) drop = i;
      });
      items = items.filter((_, i) => i !== drop);
    }
    pushSeg(segs, ' ', bar);
    items.forEach((it, i) => {
      pushSeg(segs, it.k, { bold: true, fg: COLOR.accent, ...bar });
      pushSeg(segs, ` ${it.label}`, bar);
      if (i < items.length - 1) pushSeg(segs, ' · ', { dim: true, ...bar });
    });
    if (watch) {
      const used = segs.reduce((n, s) => n + stringWidth(s.text), 0);
      const tag = 'watching ';
      if (used + stringWidth(tag) + 1 < cols) {
        pushSeg(segs, ' '.repeat(cols - used - stringWidth(tag)), bar);
        pushSeg(segs, tag, { fg: COLOR.ok, ...bar });
      }
    }
  }
  return fitSegs(segs, cols, bar);
}

/**
 * @param {object} p
 * @param {{metas: object[], threads: Record<string, object[]>, hookAlive: Record<string, boolean>}} p.data
 * @param {{columns: number, rows: number}} p.size
 * @param {{selectedId: string | null, showAll: boolean}} p.ui
 * @param {(patch: object) => void} p.setUi
 * @param {(id: string) => void} p.onOpen
 * @param {(id: string) => Promise<void>} p.onClose
 * @param {() => void} p.onQuit
 */
export function Inbox({ data, size, bus, watch, ui, setUi, flash = null, isCurrent = () => true, onOpen, onClose, onQuit }) {
  const [, bump] = useReducer((n) => n + 1, 0);
  const local = useRef({ scroll: 0, confirm: null, help: false, notice: null });
  const L = local.current;
  const set = (p) => {
    Object.assign(local.current, p);
    bump();
  };

  const { columns: cols, rows } = size;
  const metas = useMemo(() => visibleMetas(data.metas, ui.showAll), [data.metas, ui.showAll]);
  const listRows = useMemo(
    () => buildRows(metas, { threads: new Map(Object.entries(data.threads)), hookAlive: new Map(Object.entries(data.hookAlive)) }),
    [metas, data],
  );
  const bodyH = Math.max(1, rows - 4);
  let idx = Math.max(0, listRows.findIndex((r) => r.id === ui.selectedId));
  if (listRows.length === 0) idx = -1;
  if (idx >= 0) {
    if (idx < L.scroll) L.scroll = idx;
    if (idx >= L.scroll + bodyH) L.scroll = idx - bodyH + 1;
  }
  L.scroll = Math.max(0, Math.min(L.scroll, Math.max(0, listRows.length - bodyH)));

  const select = (i) => {
    if (listRows.length === 0) return;
    const j = Math.max(0, Math.min(listRows.length - 1, i));
    setUi({ selectedId: listRows[j].id });
  };

  useInput((input, key) => {
    if (!isCurrent()) return undefined;
    if (L.help) return set({ help: false });
    if (L.confirm) {
      if (key.return || input === 'y' || input === 'Y') {
        const c = L.confirm;
        set({ confirm: null });
        onClose(c.id).then(() => set({ notice: t('inbox.closed', { id: c.id }) }), (err) => set({ notice: t('ops.failed', { message: err.message }) }));
        return undefined;
      }
      if (key.escape || input === 'n' || input === 'N' || input === 'q' || (key.ctrl && input === 'c')) return set({ confirm: null });
      return undefined;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) return onQuit();
    if (input === '?') return set({ help: true });
    if (input === 'j' || key.downArrow) return select(idx + 1);
    if (input === 'k' || key.upArrow) return select(idx - 1);
    if (input === 'g' || key.home) return select(0);
    if (input === 'G' || key.end) return select(listRows.length - 1);
    if (key.ctrl && input === 'd') return select(idx + Math.floor(bodyH / 2));
    if (key.ctrl && input === 'u') return select(idx - Math.floor(bodyH / 2));
    if (key.pageDown) return select(idx + bodyH);
    if (key.pageUp) return select(idx - bodyH);
    if (key.return && idx >= 0) return onOpen(listRows[idx].id);
    if (input === 'a') {
      set({ notice: null });
      return setUi({ showAll: !ui.showAll });
    }
    if (input === 'x' && idx >= 0) {
      const r = listRows[idx];
      const plan = r.kind === 'plan' ? t('inbox.planSuffix') : '';
      return set({ confirm: { id: r.id, text: t('inbox.closeConfirm', { title: r.title, plan }) }, notice: null });
    }
    return undefined;
  });

  useBusEvent(bus, 'mouse', (ev) => {
    if (!isCurrent()) return undefined;
    if (L.help) return ev.kind === 'press' ? set({ help: false }) : undefined;
    if (ev.kind === 'wheel') {
      const dir = ev.button === 'wheelUp' ? -1 : ev.button === 'wheelDown' ? 1 : 0;
      if (!dir) return undefined;
      L.scroll = Math.max(0, Math.min(Math.max(0, listRows.length - bodyH), L.scroll + dir * 3));
      // keep the selection inside the visible window
      const sel = Math.max(L.scroll, Math.min(idx, L.scroll + bodyH - 1));
      if (sel !== idx) select(sel);
      return bump();
    }
    if (ev.kind === 'press' && ev.button === 'left' && ev.y >= 2 && ev.y < 2 + bodyH) {
      const i = L.scroll + (ev.y - 2);
      if (i < listRows.length && !L.confirm) {
        select(i);
        onOpen(listRows[i].id);
      }
    }
    return undefined;
  });

  const counts = inboxCounts(data.metas);
  const headerSegs = [];
  pushSeg(headerSegs, ' Review Desk', { bold: true });
  pushSeg(headerSegs, `${GLYPH.sep}inbox${ui.showAll ? ' (all)' : ''}`, { dim: true });
  const right = `${counts.open} open · ${counts.answered} answered `;
  const used = headerSegs.reduce((n, s) => n + stringWidth(s.text), 0);
  pushSeg(headerSegs, ' '.repeat(Math.max(1, cols - used - stringWidth(right))), null);
  pushSeg(headerSegs, right, { fg: COLOR.warn });

  const shown = listRows.slice(L.scroll, L.scroll + bodyH);
  const body = [];
  shown.forEach((r, i) => body.push(formatRow(r, cols, L.scroll + i === idx)));
  if (listRows.length === 0) {
    const msg = watch ? t('inbox.emptyWatch') : t('inbox.empty');
    body.push(fitSegs([{ text: msg, style: { dim: true } }], cols));
  }
  while (body.length < bodyH) body.push(fitSegs([], cols));

  return h(
    Box,
    { flexDirection: 'column', width: cols, height: rows },
    h(Row, { segs: fitSegs(headerSegs, cols) }),
    h(Text, { wrap: 'truncate' }, rule(cols)),
    L.help ? h(Help, { width: cols, height: bodyH, entries: inboxHelpEntries(), title: t('help.inboxTitle') }) : h(Rows, { rows: body, width: cols, height: bodyH }),
    h(Text, { wrap: 'truncate' }, rule(cols)),
    h(Row, { segs: footer({ cols, watch, confirm: L.confirm, showAll: ui.showAll, notice: L.notice ?? flash?.text ?? null }) }),
  );
}
