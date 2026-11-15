// One screen row built from segments. Rows are pre-fitted to their width, so `truncate` only guards against
// a width miscount (it keeps the row count stable instead of letting Ink wrap).
import React from 'react';
import { Box, Text } from 'ink';
import { segsToAnsi } from './lib/ansi.js';

const h = React.createElement;

export function Row({ segs }) {
  return h(Text, { wrap: 'truncate' }, segsToAnsi(segs));
}

/** A column of segment rows inside a fixed-size box. */
export function Rows({ rows, width, height }) {
  return h(
    Box,
    { flexDirection: 'column', width, height, flexShrink: 0 },
    ...rows.map((segs, i) => h(Row, { key: i, segs })),
  );
}
