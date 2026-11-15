// Help screen: key table. Replaces the body area while open; arrows / paging / the wheel scroll it, any other key (or click) closes it.
import React from 'react';
import { Rows } from './Row.js';
import stringWidth from 'string-width';
import { fitSegs, pushSeg } from './lib/ansi.js';
import { COLOR } from './lib/theme.js';
import { wrapPlain } from './lib/cards.js';
import { t } from '../i18n/index.js';

const h = React.createElement;

/** The key table of the review screen / of the inbox, in the active language (evaluated at use time). */
export const reviewHelpEntries = () => t('help.review');
export const inboxHelpEntries = () => t('help.inbox');

const KEY_COL = 22;

/** Every row of the help text for a width (descriptions wrap under the key column). */
export function helpLines(entries, width) {
  const out = [];
  for (const [key, text] of entries) {
    if (text === null) {
      out.push(fitSegs([{ text: ` ${key}`, style: { bold: true, fg: COLOR.warn } }], width));
      continue;
    }
    wrapPlain(text, Math.max(10, width - KEY_COL - 1)).forEach((part, i) => {
      const segs = [];
      if (i === 0) pushSeg(segs, `   ${key}${' '.repeat(Math.max(1, KEY_COL - 3 - stringWidth(key)))}`, { fg: COLOR.accent, bold: true });
      else pushSeg(segs, ' '.repeat(KEY_COL), null);
      pushSeg(segs, part, null);
      out.push(fitSegs(segs, width));
    });
  }
  return out;
}

/** Largest scroll of the help text in a body of `height` rows (the title row stays). */
export const helpMaxTop = (entries, width, height) => Math.max(0, helpLines(entries, width).length - Math.max(1, height - 1));

export function helpRows(entries, width, height, title, top = 0) {
  const lines = helpLines(entries, width);
  const first = Math.max(0, Math.min(top, Math.max(0, lines.length - Math.max(1, height - 1))));
  const rows = [fitSegs([{ text: ` ${title}`, style: { bold: true, fg: COLOR.accent } }], width), ...lines.slice(first, first + Math.max(0, height - 1))];
  while (rows.length < height) rows.push(fitSegs([], width));
  return rows.slice(0, height);
}

export function Help({ width, height, entries = reviewHelpEntries(), title = t('help.title'), top = 0 }) {
  return h(Rows, { rows: helpRows(entries, width, height, title, top), width, height });
}
