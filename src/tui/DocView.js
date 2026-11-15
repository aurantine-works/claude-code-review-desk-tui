// The document body: pre-rendered rows of the visible window (see lib/rowRender.js). All layout work is done
// by the caller for the visible lines only; this component just paints them.
import React from 'react';
import { Rows } from './Row.js';

const h = React.createElement;

export function DocView({ rows, width, height }) {
  return h(Rows, { rows, width, height });
}
