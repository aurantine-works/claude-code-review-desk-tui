// Geometry of the comment box (see ../CommentBox.js for the component that draws it).
import stringWidth from 'string-width';
import { inputHeight } from '../input/index.js';
import { t } from '../../i18n/index.js';

/** Labels of the two footer buttons: the first one is 'send' or 'save draft' (as wide as the wider), the second 'cancel'. */
export const buttonLabels = () => ({ send: t('box.btnSend'), draft: t('box.btnDraft'), cancel: t('box.btnCancel') });
export function buttonWidths() {
  const l = buttonLabels();
  return { send: Math.max(stringWidth(l.send), stringWidth(l.draft)) + 2, cancel: stringWidth(l.cancel) + 2 };
}
export const MAX_INPUT_ROWS = 8;

/**
 * Geometry of the box for a given text. `height` includes the border, the title and the footer.
 * Button ranges are relative to the left edge of the box; `footerRow` relative to its top.
 */
export function commentBoxModel({ width, text, maxRows = MAX_INPUT_ROWS }) {
  const innerW = Math.max(8, width - 4); // border + 1 column of padding on each side
  const inputH = inputHeight(text, innerW, maxRows);
  const bw = buttonWidths();
  const send0 = 2 + innerW - (bw.send + bw.cancel + 1);
  return {
    innerW,
    inputH,
    height: inputH + 4,
    footerRow: inputH + 2,
    send: [send0, send0 + bw.send],
    cancel: [send0 + bw.send + 1, send0 + bw.send + 1 + bw.cancel],
  };
}
