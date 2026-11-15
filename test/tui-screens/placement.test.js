import { describe, it, expect } from 'vitest';
import { placeCards, revealShift, clampPanelScroll, placeCommentBox, commentBoxWidth } from '../../src/tui/lib/placement.js';
import { computeGeometry, regionAt } from '../../src/tui/lib/geometry.js';

describe('placeCards', () => {
  it('puts cards at their anchors when there is room', () => {
    const cards = [
      { h: 3, desired: 2 },
      { h: 3, desired: 10 },
    ];
    expect(placeCards(cards, { pivot: 0 })).toEqual([2, 10]);
  });

  it('pushes later cards down to avoid overlap (pivot first)', () => {
    const cards = [
      { h: 4, desired: 2 },
      { h: 3, desired: 3 },
      { h: 3, desired: 4 },
    ];
    expect(placeCards(cards, { pivot: 0 })).toEqual([2, 7, 11]);
  });

  it('keeps the pivot at its anchor and pushes the cards before it up', () => {
    const cards = [
      { h: 4, desired: 2 },
      { h: 3, desired: 3 },
      { h: 3, desired: 4 },
    ];
    expect(placeCards(cards, { pivot: 2 })).toEqual([-5, 0, 4]);
  });

  it('packs off-screen cards against their neighbours', () => {
    const cards = [
      { h: 2, desired: null },
      { h: 2, desired: 5 },
      { h: 2, desired: null },
      { h: 2, desired: null },
    ];
    expect(placeCards(cards, { pivot: 1 })).toEqual([2, 5, 8, 11]);
  });

  it('puts an off-screen pivot at the top', () => {
    expect(placeCards([{ h: 2, desired: null }], { pivot: 0 })).toEqual([0]);
    expect(placeCards([], { pivot: 0 })).toEqual([]);
  });
});

describe('panel scroll helpers', () => {
  it('revealShift brings a card into view', () => {
    expect(revealShift(2, 3, 20)).toBe(0);
    expect(revealShift(-4, 3, 20)).toBe(-4);
    expect(revealShift(18, 5, 20)).toBe(3);
    expect(revealShift(18, 30, 20)).toBe(18); // taller than the pane: show its top
  });
  it('clampPanelScroll limits to the content', () => {
    expect(clampPanelScroll(50, [0, 10], [5, 5], 12)).toBe(3);
    expect(clampPanelScroll(-50, [-4, 3], [5, 5], 12)).toBe(-4);
    expect(clampPanelScroll(5, [], [], 12)).toBe(0);
  });
});

describe('placeCommentBox', () => {
  const base = { paneW: 90, paneH: 30, boxW: 60, boxH: 6 };
  it('goes below the selection, left aligned with its start', () => {
    expect(placeCommentBox({ ...base, selTop: 4, selBottom: 6, selLeft: 12 })).toEqual({ top: 7, left: 12, side: 'below' });
  });
  it('flips above when there is no room below', () => {
    expect(placeCommentBox({ ...base, selTop: 20, selBottom: 26, selLeft: 5 })).toEqual({ top: 14, left: 5, side: 'above' });
  });
  it('clamps horizontally so the box stays inside the pane', () => {
    expect(placeCommentBox({ ...base, selTop: 1, selBottom: 1, selLeft: 70 }).left).toBe(30);
  });
  it('falls back to the bottom when neither side fits', () => {
    const p = placeCommentBox({ ...base, paneH: 10, selTop: 1, selBottom: 8, selLeft: 0 });
    expect(p.side).toBe('overlap');
    expect(p.top).toBe(4);
  });
  it('box width is the text width capped at 72', () => {
    expect(commentBoxWidth(95)).toBe(72);
    expect(commentBoxWidth(40)).toBe(40);
  });
});

describe('geometry', () => {
  it('wide layout puts a ~40% panel on the right', () => {
    const g = computeGeometry({ cols: 160, rows: 45 });
    expect(g.wide).toBe(true);
    expect(g.panelW).toBe(64);
    expect(g.docW + 1 + g.panelW).toBe(160);
    expect(g.bodyH).toBe(41);
    expect(g.drawerH).toBe(0);
  });
  it('panel has a 36-column minimum', () => {
    expect(computeGeometry({ cols: 110, rows: 30 }).panelW).toBe(44);
  });
  it('narrow layout uses a drawer below the body', () => {
    const g = computeGeometry({ cols: 80, rows: 30, drawerRows: 8 });
    expect(g.wide).toBe(false);
    expect(g.drawerH).toBe(8);
    expect(g.bodyH).toBe(18);
    expect(g.docW).toBe(80);
    expect(g.drawerY).toBe(g.bodyY + g.bodyH + 1);
  });
  it('never lets the drawer eat the document', () => {
    expect(computeGeometry({ cols: 80, rows: 14, drawerRows: 12 }).bodyH).toBeGreaterThanOrEqual(5);
  });
  it('regionAt', () => {
    const g = computeGeometry({ cols: 160, rows: 45 });
    expect(regionAt(g, 3, 0)).toBe('header');
    expect(regionAt(g, 3, 2)).toBe('doc');
    expect(regionAt(g, g.panelX + 2, 5)).toBe('panel');
    expect(regionAt(g, g.sepX, 5)).toBe('other');
    expect(regionAt(g, 3, 44)).toBe('status');
    const n = computeGeometry({ cols: 80, rows: 30, drawerRows: 8 });
    expect(regionAt(n, 3, n.drawerY + 1)).toBe('drawer');
  });
});
