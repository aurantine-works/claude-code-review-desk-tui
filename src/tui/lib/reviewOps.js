// Store mutations of the review screen. Each function returns a user-facing result instead of throwing, so the
// screen only has to show the notice: {ok, notice: {text, kind}, focusId?, line?, finished?}.
import { makeAnchor } from '../../anchor/index.js';
import {
  addThread,
  addUserMessage,
  setThreadStatus,
  deleteDraft,
  submitBatch,
  approveReview,
} from '../../store/index.js';
import { t } from '../../i18n/index.js';
import { lastDraft, reopenStatus } from './threadView.js';
import { approvedPendingText, approvedNotifyText, approvedWakeText } from './deliveryModel.js';

const ok = (text, extra = {}) => ({ ok: true, notice: { text, kind: 'info' }, ...extra });
const fail = (err) => ({ ok: false, notice: { text: t('ops.failed', { message: err?.message ?? err }), kind: 'err' } });

const ACTIVE = new Set(['approved', 'closed']);
export const isReadOnly = (meta) => ACTIVE.has(meta.status);

/**
 * Create a thread from a selection.
 * @param {object} p {id, meta, content, sel, text, send, kind}
 */
export async function createComment({ id, meta, content, sel, text, send }) {
  try {
    const anchor = makeAnchor(content, sel, meta.currentRevision);
    const thread = await addThread(id, { anchor, text, send });
    return ok(send ? t('ops.sent') : t('ops.draftSaved'), { focusId: thread.id, line: anchor.startLine - 1, off: anchor.startCol ?? 0, sent: send });
  } catch (err) {
    return fail(err);
  }
}

export async function createReply({ id, threadId, text, send }) {
  try {
    await addUserMessage(id, threadId, { text, send });
    return ok(send ? t('ops.sent') : t('ops.draftSaved'), { focusId: threadId, sent: send });
  } catch (err) {
    return fail(err);
  }
}

export async function toggleResolved(id, thread) {
  try {
    const resolved = thread.status === 'resolved';
    await setThreadStatus(id, thread.id, resolved ? reopenStatus(thread) : 'resolved');
    return ok(resolved ? t('ops.reopened', { id: thread.id }) : t('ops.resolved', { id: thread.id }));
  } catch (err) {
    return fail(err);
  }
}

export async function removeDraft(id, thread) {
  const draft = lastDraft(thread);
  if (!draft) return { ok: false, notice: { text: t('ops.noDraft'), kind: 'warn' } };
  try {
    await deleteDraft(id, thread.id, draft.id);
    return ok(t('ops.draftDeleted'));
  } catch (err) {
    return fail(err);
  }
}

export async function submitDrafts(id) {
  try {
    const n = await submitBatch(id);
    if (n === 0) return { ok: false, notice: { text: t('ops.nothingToSubmit'), kind: 'warn' } };
    return ok(t('ops.submitted', { n }), { sent: true });
  } catch (err) {
    return fail(err);
  }
}

export async function approve(id, meta, { awaitingAlive = false, watcherAlive = false } = {}) {
  try {
    const done = await approveReview(id);
    // A plan approved while no hook is blocking (Claude ended its turn behind `rd await`, or is gone): the approval
    // is stored and honoured at Claude's next ExitPlanMode.
    if (meta.kind === 'plan' && done.approvedPendingExit) {
      const text = awaitingAlive ? approvedNotifyText() : watcherAlive ? approvedWakeText() : approvedPendingText();
      return { ok: true, notice: { text, kind: 'info', ms: 8000 }, finished: 'approved', pendingExit: true };
    }
    return ok(meta.kind === 'plan' ? t('ops.approved') : t('ops.approvedClosed'), { finished: 'approved' });
  } catch (err) {
    return fail(err);
  }
}
