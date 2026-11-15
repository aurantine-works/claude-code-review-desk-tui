// Screen geometry of the review screen. Rendering and mouse hit-testing both read this, so they cannot
// drift apart. Coordinates are absolute terminal cells (0-based), matching SGR mouse events.

export const WIDE_MIN_COLS = 110;
export const MIN_COLS = 40;
export const MIN_ROWS = 10;
export const MAX_DRAWER_ROWS = 8;

/**
 * @param {object} o
 * @param {number} o.cols @param {number} o.rows
 * @param {number} [o.drawerRows=0]  rows requested for the narrow-layout drawer (below its title rule)
 * @returns {object}
 */
export function computeGeometry({ cols, rows, drawerRows = 0 }) {
  const wide = cols >= WIDE_MIN_COLS;
  const tooSmall = cols < MIN_COLS || rows < MIN_ROWS;
  const drawerH = wide ? 0 : Math.max(0, Math.min(drawerRows, rows - 4 - 5));
  const bodyH = Math.max(1, rows - 4 - drawerH);
  const panelW = wide ? Math.max(36, Math.floor(cols * 0.4)) : 0;
  const docW = wide ? cols - panelW - 1 : cols;
  const bodyY = 2;
  const bottomRuleY = bodyY + bodyH;
  return {
    cols,
    rows,
    wide,
    tooSmall,
    headerY: 0,
    topRuleY: 1,
    bodyY,
    bodyH,
    docX: 0,
    docW,
    sepX: wide ? docW : -1,
    panelX: wide ? docW + 1 : -1,
    panelW,
    bottomRuleY,
    drawerY: bottomRuleY + 1,
    drawerH,
    statusY: rows - 1,
  };
}

export const inRect = (x, y, rx, ry, rw, rh) => x >= rx && x < rx + rw && y >= ry && y < ry + rh;

/** Which part of the review screen a terminal cell belongs to. */
export function regionAt(g, x, y) {
  if (y === g.statusY) return 'status';
  if (y === g.headerY) return 'header';
  if (g.wide && inRect(x, y, g.panelX, g.bodyY, g.panelW, g.bodyH)) return 'panel';
  if (inRect(x, y, g.docX, g.bodyY, g.docW, g.bodyH)) return 'doc';
  if (g.drawerH > 0 && inRect(x, y, 0, g.drawerY, g.cols, g.drawerH)) return 'drawer';
  return 'other';
}
