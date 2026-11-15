import { vi } from 'vitest';
vi.hoisted(() => {
  process.env.FORCE_COLOR = '1';
});
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { Box } from 'ink';
import stringWidth from 'string-width';
import { CommentBox, commentBoxModel } from '../../src/tui/CommentBox.js';
import { createBus } from '../../src/tui/mouse/filteredStdin.js';

const h = React.createElement;
// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
afterEach(() => cleanup());

const colOf = (line, needle) => stringWidth(line.slice(0, line.lastIndexOf(needle)));

describe('commentBoxModel', () => {
  it('height = input rows + frame, title and footer; grows to 8 rows then stops', () => {
    expect(commentBoxModel({ width: 40, text: '' }).height).toBe(5);
    expect(commentBoxModel({ width: 40, text: 'a\nb\nc' }).height).toBe(7);
    expect(commentBoxModel({ width: 40, text: Array(20).fill('x').join('\n') }).height).toBe(12);
    expect(commentBoxModel({ width: 40, text: Array(20).fill('x').join('\n'), maxRows: 2 }).height).toBe(6);
  });

  it('wraps CJK text by display width', () => {
    const m = commentBoxModel({ width: 24, text: '一二三四五六七八九十一二三四五六七八九十' }); // inner width 20 -> 19 usable
    expect(m.inputH).toBe(3);
  });

  it('button ranges match where the buttons are drawn', () => {
    for (const width of [30, 48, 72]) {
      const app = render(h(Box, { width: 90, height: 12 }, h(CommentBox, { x: 0, y: 0, width, title: 'Comment L1', text: 'text', version: 0, active: true, sendMode: 'instant', bus: createBus() })));
      const lines = strip(app.lastFrame()).split('\n');
      const m = commentBoxModel({ width, text: 'text' });
      const footer = lines[m.footerRow];
      expect(colOf(footer, ' send ')).toBe(m.send[0]);
      expect(colOf(footer, ' cancel ')).toBe(m.cancel[0]);
      expect(stringWidth(' draft ')).toBe(m.send[1] - m.send[0]); // the send button is as wide as the draft button
      expect(stringWidth(' cancel ')).toBe(m.cancel[1] - m.cancel[0]);
      expect(lines.slice(0, m.height).every((l) => l.trim() !== '')).toBe(true);
      cleanup();
    }
  });

  it('shows draft instead of send in batch mode', () => {
    const app = render(h(Box, { width: 90, height: 12 }, h(CommentBox, { x: 0, y: 0, width: 70, title: 't', text: '', version: 0, active: true, sendMode: 'batch', bus: createBus() })));
    expect(strip(app.lastFrame())).toContain(' draft ');
    expect(strip(app.lastFrame())).toContain('Enter save draft');
  });
});
