// Right-hand thread panel (wide layout) and bottom drawer (narrow layout). Cards are built and placed by
// lib/panelModel.js; this component paints the resulting rows.
import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { Rows } from './Row.js';
import { GLYPH } from './lib/theme.js';

const h = React.createElement;

export function ThreadPanel({ rows, width, height }) {
  return h(Rows, { rows, width, height });
}

/** The 1-column vertical rule between document and panel. */
export function Separator({ height }) {
  const text = chalk.dim(Array.from({ length: height }, () => GLYPH.vbar).join('\n'));
  return h(Box, { width: 1, height, flexShrink: 0 }, h(Text, { wrap: 'truncate' }, text));
}
