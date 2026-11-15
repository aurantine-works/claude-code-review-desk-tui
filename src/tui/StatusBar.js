// Bottom status bar. The segments (and the clickable button ranges) come from lib/statusModel.js.
import React from 'react';
import { Row } from './Row.js';

const h = React.createElement;

export function StatusBar({ segs }) {
  return h(Row, { segs });
}

export { buildStatusBar } from './lib/statusModel.js';
