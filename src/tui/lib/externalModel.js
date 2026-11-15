// External modification of the reviewed file, as the review screen reports it.
//
// store/docs.js `checkExternal(id)` is a cheap synchronous snapshot taken by every poll: the file's state against the
// latest revision. It cannot tell a finished edit from one in progress, and Claude's own writes are only registered by
// the post-tool-use hook a moment later (the store already reports the last 5 s of those as `settling`, not `changed`).
// The 3 s persistence rule therefore lives here: a difference is reported only after the SAME content (same sha) has
// been seen for 3 s; a changed sha restarts the clock. A vanished file follows the same rule (editors replace files).
import { t } from '../../i18n/index.js';

export const EXTERNAL_PERSIST_MS = 3000;

/**
 * @param {{now?: () => number, persistMs?: number}} [deps]
 * @returns {{observe: (ext: object | null | undefined) => {state: 'same'|'changed'|'missing', canAdopt: boolean, tooLarge: boolean,
 *            binary: boolean, waitMs: number}}}  `waitMs` > 0: a difference was seen but has not lasted long enough yet
 */
export function createExternalTracker({ now = Date.now, persistMs = EXTERNAL_PERSIST_MS } = {}) {
  let key = null;
  let since = 0;
  return {
    observe(ext) {
      const same = { state: 'same', canAdopt: false, tooLarge: false, binary: false, waitMs: 0 };
      let next = null;
      if (ext?.state === 'changed') next = `changed:${ext.sha ?? (ext.tooLarge ? 'too-large' : ext.binary ? 'binary' : '?')}`;
      else if (ext?.state === 'missing') next = 'missing';
      if (next !== key) {
        key = next;
        since = now();
      }
      if (next === null) return same;
      const waited = now() - since;
      if (waited < persistMs) return { ...same, waitMs: persistMs - waited };
      if (ext.state === 'missing') return { ...same, state: 'missing' };
      return { state: 'changed', canAdopt: ext.tooLarge !== true && ext.binary !== true, tooLarge: ext.tooLarge === true, binary: ext.binary === true, waitMs: 0 };
    },
  };
}

/**
 * The header part for a reported difference, or null.
 * @param {ReturnType<ReturnType<typeof createExternalTracker>['observe']>} e
 */
export function externalPart(e) {
  if (e.state === 'missing') return { id: 'external', prio: 9, text: t('external.missing'), short: t('external.missingShort'), kind: 'warn' };
  if (e.state !== 'changed') return null;
  if (e.canAdopt) return { id: 'external', prio: 9, text: t('external.adopt'), short: t('external.adoptShort'), kind: 'warn' };
  return { id: 'external', prio: 9, text: t('external.cannotAdopt', { why: e.tooLarge ? t('external.tooLarge') : t('external.notText') }), short: t('external.cannotAdoptShort'), kind: 'warn' };
}
