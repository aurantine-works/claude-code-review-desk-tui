// The in-place comment box: a bordered frame around B's MultiLineInput, with a title row and a footer row
// holding the hints and the clickable [send] / [cancel] buttons. It is positioned with absolute coordinates
// by the review screen (see lib/placement.js).
import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { MultiLineInput } from './input/index.js';
import { MAX_INPUT_ROWS, commentBoxModel, buttonWidths, buttonLabels } from './lib/commentBoxModel.js';
import { paint } from './lib/ansi.js';
import { COLOR } from './lib/theme.js';
import { t } from '../i18n/index.js';

const h = React.createElement;

export { commentBoxModel };

function footerText(model, sendMode) {
  const hint = sendMode === 'batch' ? t('box.hintDraft') : t('box.hintSend');
  const bw = buttonWidths();
  const labels = buttonLabels();
  const room = model.innerW - (bw.send + bw.cancel + 2);
  let shown = hint;
  if (stringWidth(shown) > room) shown = room >= 14 ? t('box.hintShort') : '';
  if (stringWidth(shown) > room) shown = '';
  const gap = ' '.repeat(Math.max(0, model.innerW - stringWidth(shown) - (bw.send + bw.cancel + 1)));
  const pad = (label, w) => ` ${label}${' '.repeat(Math.max(0, w - 2 - stringWidth(label)))} `;
  const send = paint(pad(sendMode === 'batch' ? labels.draft : labels.send, bw.send), { fg: '#101216', bg: COLOR.bgButton, bold: true });
  const cancel = paint(pad(labels.cancel, bw.cancel), { bg: COLOR.bgBadge });
  return `${paint(shown, { dim: true })}${gap}${send} ${cancel}`;
}

/**
 * @param {object} p
 * @param {number} p.x @param {number} p.y @param {number} p.width  absolute position / width of the frame
 * @param {string} p.title
 * @param {string} p.text         current text (mirrors the input; used for the height)
 * @param {number} p.version      bump to reload `text` into the input (after $EDITOR)
 * @param {boolean} p.active
 * @param {(active: boolean) => void} [p.onActive]  true once the input is subscribed to the keyboard, false when it is not
 */
export function CommentBox({ x, y, width, title, text, version, active, onActive, maxRows = MAX_INPUT_ROWS, sendMode, bus, onChange, onSubmit, onCancel, onEditExternal }) {
  const model = commentBoxModel({ width, text, maxRows });
  // Reported after MultiLineInput's own effects (children first), i.e. once it listens to the keyboard.
  useEffect(() => {
    onActive?.(active);
    return () => onActive?.(false);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return h(
    Box,
    {
      position: 'absolute',
      top: y,
      left: x,
      width,
      height: model.height,
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: COLOR.accent,
      paddingX: 1,
      backgroundColor: '#1d2129',
    },
    h(Text, { wrap: 'truncate' }, paint(title, { bold: true, fg: COLOR.accent })),
    h(MultiLineInput, {
      key: version,
      value: text,
      width: model.innerW,
      maxRows,
      bus,
      isActive: active,
      placeholder: t('box.placeholder'),
      onChange,
      onSubmit,
      onCancel,
      onEditExternal,
    }),
    h(Text, { wrap: 'truncate' }, footerText(model, sendMode)),
  );
}
