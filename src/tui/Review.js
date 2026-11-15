// Review screen: one plan / document with its threads.
//
// Structure
//   Review          loads the review (1 s poll) and shows load errors
//   ReviewScreen    owns the UI state (a ref + re-render, so key bursts never see stale state), derives the
//                   geometry, builds the visible rows, and routes keys and mouse events to the pure modules:
//                     lib/keymap.js      key -> action
//                     lib/reviewNav.js   cursor / scroll / focus transitions
//                     lib/reviewMouse.js mouse events -> state + effects
//                     lib/reviewOps.js   store mutations
//                   The diff view (d) is a second frame over the same state: lib/diffView.js (frame) and lib/diffNav.js (keys,
//                   mouse); the channel C dialog and the S picker are modal bodies (lib/dialogModel.js, lib/channelC.js);
//                   an external edit of the file is tracked by lib/externalModel.js.
//                   Rendering is by components: DocView, ThreadPanel, CommentBox, StatusBar, Help.
import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { DocView } from './DocView.js';
import { ThreadPanel, Separator } from './ThreadPanel.js';
import { CommentBox } from './CommentBox.js';
import { StatusBar, buildStatusBar } from './StatusBar.js';
import { Help, reviewHelpEntries, helpMaxTop } from './Help.js';
import { Row, Rows } from './Row.js';
import { useReview } from './useStore.js';
import { useBusEvent, editInEditor, sanitizeInput } from './input/index.js';
import { enableMouse, disableMouse, isMouseEnabled, suspendForEditor, copyToClipboard } from './terminal.js';
import { markInReview, rebindSession, adoptExternal, ensureTmp } from '../store/index.js';
import { makeAnchor } from '../anchor/index.js';
import { buildEditorHeader } from './lib/editorHeader.js';
import { deliver, endInstant } from '../delivery/index.js';
import { resumeInfo, startHeadless } from '../delivery/resume.js';
import { createDocViews, isMarkdownReview } from './lib/docView.js';
import { DocLayout } from './lib/viewport.js';
import { buildReviewFrame } from './lib/reviewFrame.js';
import { buildThreadView, stepThread, threadFromCursor, countDrafts, lineLabel } from './lib/threadView.js';
import { buildHeader } from './lib/headerModel.js';
import { mapKey, mapDiffKey, mapDialogKey, mapPickerKey, mapConfirmKey, splitKeys } from './lib/keymap.js';
import { handleMouse } from './lib/reviewMouse.js';
import * as nav from './lib/reviewNav.js';
import * as ops from './lib/reviewOps.js';
import { deliveryNotice, endInstantNotice, needsReviewReplyHint, aHint } from './lib/deliveryModel.js';
import { COLOR, GLYPH } from './lib/theme.js';
import { buildDiffFrame } from './lib/diffView.js';
import * as dnav from './lib/diffNav.js';
import { baseCandidates, loadDiffModel, resolveBase, buildDiffModel } from './lib/diffModel.js';
import { channelCOffer, takeAutoOpen, refusalText, headlessLine, headlessEndNotice, tildePath, RESUMABLE_REASONS } from './lib/channelC.js';
import { channelCRows, pickerRows } from './lib/dialogModel.js';
import { createExternalTracker } from './lib/externalModel.js';
import { sessionChoices, movePick } from './lib/pickList.js';
import { t } from '../i18n/index.js';

const h = React.createElement;

export const displayLines = (content) => {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const NOTICE_MS = 3500;

const ruleLine = (width, joint, jointAt) => {
  const cells = Array.from({ length: width }, (_, i) => (i === jointAt ? joint : GLYPH.hbar));
  return chalk.dim(cells.join(''));
};

export function Review({ id, bus, size, config, origin, incoming, wakeNotice = null, mdMode, onMdMode, pollMs = 1000, isCurrent = () => true, onBack, onFinished }) {
  const { value: data, error, refresh } = useReview(id, pollMs);
  useInput((input, key) => {
    if (!data && (input === 'q' || (key.ctrl && input === 'c'))) onBack();
  });
  if (!data) {
    return h(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      h(Text, { color: COLOR.err }, t('review.openFail', { id, message: error?.message ?? 'unknown error' })),
      h(Text, { dimColor: true }, t('review.pressQ')),
    );
  }
  return h(ReviewScreen, { key: id, id, data, refresh, bus, size, config, origin, incoming, wakeNotice, mdMode, onMdMode, isCurrent, onBack, onFinished });
}

function ReviewScreen({ id, data, refresh, bus, size, config, origin, incoming, wakeNotice, mdMode, onMdMode, isCurrent, onBack, onFinished }) {
  const { meta, threads, content, session, sessionAlive, hookAlive, delivery } = data;
  const { suspendTerminal } = useApp();
  const [, bump] = useReducer((n) => n + 1, 0);

  const lines = useMemo(() => displayLines(content), [content]);
  // The document's views: the source lines, and (Markdown only) the half-rendered text. State holds which one is shown.
  const isMd = isMarkdownReview(meta);
  const views = useMemo(() => createDocViews(lines, { markdown: isMd }), [lines, isMd]);
  const doc = useMemo(() => new DocLayout(views.source.lines), [views]);
  const view = useMemo(() => buildThreadView(threads, lines.length), [threads, lines.length]);

  // The diff view: its own layout over the diff rows, and the model of the comparison (cached per revision pair + content).
  const diffDoc = useMemo(() => new DocLayout([]), []);
  const diffCache = useRef({ key: '', model: null });
  const diffModelFor = (base) => {
    const from = resolveBase(meta, base);
    if (from == null) return null;
    const sha = meta.revisions[meta.revisions.length - 1]?.sha1 ?? '';
    const key = `${from}|${meta.currentRevision}|${sha}`;
    if (diffCache.current.key !== key) {
      let model;
      try {
        model = loadDiffModel(id, meta, base);
      } catch (err) {
        model = { ...buildDiffModel('', '', { from, to: meta.currentRevision }), kind: 'error', error: err.message };
      }
      diffCache.current = { key, model };
    }
    return diffCache.current.model;
  };

  // The file changed outside Claude Code? Reported after the same content was seen for 3 s (externalModel.js).
  const tracker = useRef(null);
  if (!tracker.current) tracker.current = createExternalTracker();
  const external = tracker.current.observe(data.external);
  const externalRef = useRef(external);
  externalRef.current = external;
  const waitKey = external.waitMs > 0 ? `${data.external?.state}:${data.external?.sha ?? ''}` : '';
  useEffect(() => {
    if (!waitKey) return undefined;
    const t = setTimeout(bump, externalRef.current.waitMs + 30); // re-render when the 3 s are up (the poll only re-renders on a change)
    return () => clearTimeout(t);
  }, [waitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sref = useRef(null);
  if (!sref.current) {
    sref.current = nav.initialState({
      sendMode: config?.review?.sendMode === 'batch' ? 'batch' : 'instant',
      mouseOn: isMouseEnabled(),
      md: (mdMode ?? config?.ui?.markdown) === 'source' ? 'source' : 'rendered',
    });
  }
  const commit = (next) => {
    sref.current = next;
    bump();
  };
  const patch = (p) => commit({ ...sref.current, ...p });
  const frameRef = useRef(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const busy = useRef(false);
  const inputReady = useRef(false); // the comment box has subscribed to the keyboard

  // Opening a review for the first time marks it as being looked at.
  useEffect(() => {
    markInReview(id).then(() => refresh()).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- derive the frame ---------------------------------------------------------------------------------
  const cols = size.columns;
  const rowsTotal = size.rows;
  // The diff view (`d`) is drawn instead of the body; the normal view's state and frame are kept underneath (the normal
  // frame must not touch the drawer scroll, which then belongs to the diff's drawer).
  const diffOpen = !!sref.current.diff;
  const F = buildReviewFrame({ s: diffOpen ? { ...sref.current, drawerScroll: 0 } : sref.current, doc, views, view, meta, size, delivery });
  const diffModel = diffOpen ? diffModelFor(F.state.diff.base) : null;
  const D = diffModel ? buildDiffFrame({ s: { ...F.state, drawerScroll: sref.current.drawerScroll }, doc: diffDoc, model: diffModel, view, meta, size, delivery }) : null;
  let s = D ? D.state : diffOpen ? { ...F.state, diff: null, drawerScroll: sref.current.drawerScroll } : F.state; // (no model: the comparison cannot be made, back to the document)
  sref.current = s;
  const { geo, wide, ctx, focus: normalFocus, cursor, boxRect, boxModel, menu, maxRows } = F;
  const focus = D ? D.focus : normalFocus;
  const drawer = D ? D.drawer : F.drawer;
  const readOnly = ops.isReadOnly(meta);

  // Modal dialogs replace the body (like the help screen). In the narrow layout they also take over the drawer's rows: a
  // dialog or the help text in 12 rows of an 80x24 terminal would hide most of what it has to say.
  const takesAll = !wide && geo.drawerH > 0 && (s.mode === 'help' || s.mode === 'dialog' || s.mode === 'picker');
  const overlayH = takesAll ? geo.bodyH + 1 + geo.drawerH : geo.bodyH;
  let overlay = null;
  if (s.mode === 'dialog' && s.dialog) overlay = channelCRows({ width: cols, height: overlayH, d: { ...s.dialog, queued: delivery?.queuedCount ?? s.dialog.queued }, headless: data.headless });
  else if (s.mode === 'picker' && s.picker) overlay = pickerRows({ width: cols, height: overlayH, picker: s.picker, title: t('resume.pickerTitle') });
  const overlayHits = overlay ? overlay.hits.map((b) => ({ ...b, y: geo.bodyY + b.y })) : [];

  // Header / status bar.
  const headerDiff = diffModel ? { from: diffModel.from, to: diffModel.to, kind: diffModel.kind, summary: diffModel.summary } : null;
  const header = buildHeader({ meta, session, sessionAlive, hookAlive, sendMode: s.sendMode, cols, incoming, delivery, headless: data.headless, external, diff: headerDiff });
  let cursorText = lines.length ? `L${cursor + 1}/${lines.length}` : '';
  if (D) {
    const dl = diffModel.rows[D.cursor];
    cursorText = dl ? (dl.newLine != null ? `L${dl.newLine}/${lines.length}` : `-L${dl.oldLine}`) : '';
  }
  const canResume = !readOnly && delivery?.channel === 'C' && RESUMABLE_REASONS.has(delivery.reason) && delivery.queuedCount > 0;
  const status = buildStatusBar(
    {
      mode: s.mode,
      visualKind: s.visual?.kind,
      sendMode: s.sendMode,
      readOnly,
      canReply: !!focus,
      canResolve: !!focus,
      resolved: focus?.status === 'resolved',
      drafts: countDrafts(threads),
      notice: s.notice,
      confirm: s.confirm,
      mouseOn: s.mouseOn,
      cursorText,
      mdMode: isMd && !D ? s.md : null,
      canEndQna: !!delivery?.awaitingAlive,
      diff: !!D,
      canResume,
      canAdopt: !readOnly && external.state === 'changed' && external.canAdopt,
      canRebind: !readOnly && meta.kind === 'doc' && sessionChoices(meta).length >= 2,
    },
    cols,
  );

  frameRef.current = {
    geo,
    doc,
    lines: F.lines, // display lines (the source's in source mode)
    dv: F.dv,
    views,
    view,
    layout: D ? D.layout : F.layout,
    ctx,
    dctx: D ? D.dctx : null, // the diff view's context (diffNav.js); null while it is closed
    helpMax: helpMaxTop(reviewHelpEntries(), cols, overlayH),
    overlayH,
    overlay: { hits: overlayHits },
    panel: D ? D.panel : F.panel,
    menu,
    box: boxRect
      ? { y: boxRect.y + (boxModel?.footerRow ?? 0), send: [boxRect.x + (boxModel?.send[0] ?? 0), boxRect.x + (boxModel?.send[1] ?? 0)], cancel: [boxRect.x + (boxModel?.cancel[0] ?? 0), boxRect.x + (boxModel?.cancel[1] ?? 0)] }
      : null,
    statusButtons: status.buttons,
    focus,
    meta,
    threads,
    content,
    readOnly,
  };

  // ---- notices ---------------------------------------------------------------------------------------------
  useEffect(() => {
    if (!s.notice) return undefined;
    const t = setTimeout(() => {
      if (sref.current.notice === s.notice) patch({ notice: null });
    }, s.notice.ms ?? NOTICE_MS);
    return () => clearTimeout(t);
  }, [s.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  // The app-level wake watcher (lib/wakeWatcher.js, run by App on every screen) typed the wake-up command: say so.
  const wakeAt = wakeNotice?.at ?? null;
  useEffect(() => {
    if (wakeAt === null) return;
    patch({ notice: { text: wakeNotice.text, kind: 'info' } });
  }, [wakeAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // A background resume (channel C [h]) ended while this screen was open: say how it went (the header keeps the status).
  const headlessState = data.headless?.state ?? null;
  const headlessSeen = useRef(headlessState);
  const headlessStartedHere = useRef(false);
  useEffect(() => {
    const prev = headlessSeen.current;
    headlessSeen.current = headlessState;
    if ((prev === 'running' || headlessStartedHere.current) && (headlessState === 'finished' || headlessState === 'failed')) {
      headlessStartedHere.current = false;
      patch({ notice: headlessEndNotice(dataRef.current.headless) });
    }
  }, [headlessState]); // eslint-disable-line react-hooks/exhaustive-deps

  // The dialog describes feedback waiting for a dead session; when that stops being true (the session was resumed elsewhere,
  // the feedback was taken) it closes itself.
  const dialogStale = s.mode === 'dialog' && !s.dialog?.busy && !!delivery && !(delivery.channel === 'C' && delivery.queuedCount > 0);
  useEffect(() => {
    if (!dialogStale) return;
    const cur = sref.current;
    if (cur.mode === 'dialog') commit({ ...cur, mode: 'normal', dialog: null, notice: { text: t('review.dialogStale'), kind: 'info' } });
  }, [dialogStale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Idle session, no injector: nothing can reach Claude until the user types /review-reply there. Say so once.
  const hintedA = useRef(false);
  const wantsAHint = needsReviewReplyHint(delivery) && !ops.isReadOnly(meta);
  useEffect(() => {
    if (!wantsAHint || hintedA.current) return;
    hintedA.current = true;
    if (!sref.current.notice) patch({ notice: { text: aHint(), kind: 'info', ms: 7000 } });
  }, [wantsAHint]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions -----------------------------------------------------------------------------------------------
  const notice = (text, kind = 'info') => patch({ notice: { text, kind } });
  const guardWrite = () => {
    const f = frameRef.current;
    if (f.readOnly) {
      notice(t('review.finished', { status: f.meta.status }), 'warn');
      return false;
    }
    return true;
  };

  /**
   * After a send: hand the feedback to the delivery engine (fire and forget: only the `inject` channel has anything
   * to do, and it may wait for the session to become idle) and tell the user which channel carries it.
   */
  const fireDeliver = (sentNotice) => {
    deliver(id)
      .then((r) => {
        const cur = sref.current;
        // Do not overwrite a message the user has caused since.
        if (!cur.notice || cur.notice === sentNotice) patch({ notice: deliveryNotice(r) });
        refresh();
      })
      .catch((err) => patch({ notice: { text: t('review.deliverCheckFailed', { message: err.message }), kind: 'warn' } }));
  };

  // ---- channel C: the session is gone and feedback waits ------------------------------------------------------------------
  const openChannelCDialog = (offer, { error = null } = {}) => {
    const cur = sref.current;
    commit({
      ...cur,
      mode: 'dialog',
      dialog: { reviewId: id, queued: offer.queued, sessionId: dataRef.current.meta.sessionId, command: null, copied: false, error, busy: false },
      notice: null,
      input: null,
      visual: null,
      menu: null,
      pending: null,
    });
  };

  /**
   * Start the background resume (the dialog's [h]). Never throws; `r.ok` says whether it started. startHeadless itself refuses a second
   * start for a session that has a run going (its own lock + the live run in the review metas), so two cannot run at once.
   */
  const launchHeadless = async () => {
    let r;
    try {
      r = await startHeadless(id, { config });
    } catch (err) {
      r = { ok: false, reason: 'error', message: err.message };
    }
    if (r.ok) {
      headlessStartedHere.current = true;
      r.exited.then(() => refresh(), () => {});
    }
    return r;
  };

  /** delivery.autoResume = "headless": the same start without asking; the notice replaces the dialog (which only opens when the start fails). */
  const autoResume = async (offer) => {
    const r = await launchHeadless();
    if (r.ok) {
      patch({ notice: { text: t('review.autoResumed', { pid: r.pid, log: tildePath(r.log) }), kind: 'info', ms: 6000 } });
    } else if (['headless-running', 'session-alive', 'nothing-waiting'].includes(r.reason)) {
      patch({ notice: { text: refusalText(r), kind: 'info', ms: 6000 } });
    } else if (sref.current.mode === 'normal') {
      openChannelCDialog(offer, { error: t('review.autoResumeFailed', { reason: refusalText(r) }) });
    }
    refresh();
  };

  /** After a send / submit: open the dialog once for each batch of feedback that has to wait for a resumed session (or resume by itself, delivery.autoResume). */
  const offerChannelC = () => {
    try {
      const offer = channelCOffer(id);
      if (!takeAutoOpen(offer)) return false;
      if (config?.delivery?.autoResume === 'headless') {
        autoResume(offer);
        return true;
      }
      openChannelCDialog(offer);
      return true;
    } catch {
      return false; // an unreadable store: the header still says what is going on
    }
  };

  const closeDialog = (notice) => {
    const cur = sref.current;
    commit({ ...cur, mode: 'normal', dialog: null, picker: null, ...(notice ? { notice } : {}) });
  };

  const updateDialog = (p) => {
    const cur = sref.current;
    if (cur.dialog) commit({ ...cur, dialog: { ...cur.dialog, ...p } });
  };

  const dialogAction = async (name) => {
    const cur = sref.current;
    const d = cur.dialog;
    if (!d || d.busy) return;
    if (name === 'show') {
      try {
        const info = resumeInfo(id, { config });
        updateDialog({ command: info.interactive, copied: copyToClipboard(info.interactive), error: null });
      } catch (err) {
        updateDialog({ command: null, error: t('review.cmdFailed', { message: err.message }) });
      }
    } else if (name === 'headless') {
      updateDialog({ busy: true, error: null });
      const r = await launchHeadless();
      if (!r.ok) return updateDialog({ busy: false, error: refusalText(r) });
      closeDialog({ text: t('review.resumedBg', { pid: r.pid, log: tildePath(r.log) }), kind: 'info', ms: 6000 });
      refresh();
    } else if (name === 'leave') {
      closeDialog({ text: t('review.leftQueued'), kind: 'info', ms: 5000 });
    }
    return undefined;
  };

  const openComment = (text = '') => {
    if (!guardWrite()) return;
    const cur = sref.current;
    const f = frameRef.current;
    if (f.lines.length === 0) return;
    const sel = nav.selectionToSel(cur, f.dv); // source columns: characters for v, lines for V, the cursor line otherwise
    commit({ ...cur, mode: 'input', input: { kind: 'comment', sel, text, returnMode: cur.mode }, inputVersion: cur.inputVersion + 1, pending: null, menu: null });
  };

  const openReply = (text = '') => {
    if (!guardWrite()) return;
    const cur = sref.current;
    const thread = frameRef.current.focus;
    if (!thread) return notice(t('review.noThreadHere'), 'warn');
    // panelScroll: null lets the panel scroll the thread (and the floating box next to it) into view.
    commit({ ...cur, mode: 'input', input: { kind: 'reply', threadId: thread.id, text, returnMode: 'normal' }, inputVersion: cur.inputVersion + 1, pending: null, panelScroll: null, drawerScroll: 0 });
  };

  const closeInput = (extra = {}) => {
    const cur = sref.current;
    commit({ ...cur, mode: cur.input?.returnMode === 'visual' && cur.visual ? 'visual' : 'normal', input: null, confirm: null, ...extra });
  };

  // ---- $EDITOR (C / R / Ctrl+E in the box) -------------------------------------------------------------------
  /** Run the editor on `text` under `header`; the temp file lives in RD_HOME/tmp. Never throws. */
  const runEditor = (text, header) => {
    let dir;
    try {
      dir = ensureTmp();
    } catch {
      /* no RD_HOME/tmp: the OS temp dir is used */
    }
    return editInEditor(text, { suspend: (fn) => suspendForEditor(fn, { suspendTerminal }), dir, header, config });
  };

  /** The header comment of the editor file for an input (a comment on a selection / a reply to a thread). */
  const headerFor = (inp, purpose) => {
    const f = frameRef.current;
    const sendMode = sref.current.sendMode;
    if (inp.kind === 'reply') {
      const t = f.threads.find((x) => x.id === inp.threadId);
      return buildEditorHeader({ kind: 'reply', label: inp.threadId, quote: t?.anchor?.quote ?? '', sendMode, purpose });
    }
    let quote = '';
    try {
      quote = makeAnchor(f.content, inp.sel, f.meta.currentRevision).quote;
    } catch {
      /* the header is a courtesy */
    }
    return buildEditorHeader({ kind: 'comment', label: lineLabel({ startLine: inp.sel.startLine, endLine: inp.sel.endLine }), quote, sendMode, purpose });
  };

  /** Notice for an editor that did not run or did not exit cleanly. `consequence` says what happened to the text. */
  const editorFailed = (r, consequence) => {
    const why = r.error
      ? t('review.editorUnusable', { editor: r.editor, error: r.error })
      : t('review.editorExited', { editor: r.editor, how: r.signal ? t('review.editorSignal', { signal: r.signal }) : t('review.editorCode', { code: r.code }) });
    return { text: t('review.editorFailed', { why, consequence }), kind: 'err', ms: 7000 };
  };

  /** C / R: write the comment in the editor and send it (or save the draft) exactly like Enter in the box. */
  const externalFromNormal = async (kind) => {
    if (!guardWrite()) return undefined;
    const cur = sref.current;
    const f = frameRef.current;
    let inp;
    if (kind === 'reply') {
      if (!f.focus) return notice(t('review.noThreadHere'), 'warn');
      inp = { kind: 'reply', threadId: f.focus.id, text: '', returnMode: 'normal' };
    } else {
      if (f.lines.length === 0) return undefined;
      inp = { kind: 'comment', sel: nav.selectionToSel(cur, f.dv), text: '', returnMode: cur.mode };
    }
    const r = await runEditor('', headerFor(inp, 'send'));
    if (r.status === 'failed') return patch({ notice: editorFailed(r, t('review.notSent')) });
    if (r.status !== 'saved') return notice(r.status === 'unchanged' ? t('review.editorUnchanged') : t('review.editorEmpty'));
    return submitInput(r.text, inp);
  };

  /** Enter in the box (`forced` undefined) or the text of C / R: send it (instant) or keep it as a draft (batch). */
  const submitInput = async (text, forced = null) => {
    const cur = sref.current;
    const inp = forced ?? cur.input;
    if (!inp || busy.current) return;
    busy.current = true;
    const f = frameRef.current;
    const send = cur.sendMode === 'instant';
    try {
      const res =
        inp.kind === 'comment'
          ? await ops.createComment({ id, meta: f.meta, content: f.content, sel: inp.sel, text, send })
          : await ops.createReply({ id, threadId: inp.threadId, text, send });
      if (!res.ok) {
        // Text that came from the editor must not be lost: put it in the box so it can be sent again.
        if (forced) commit({ ...sref.current, mode: 'input', input: { ...forced, text }, inputVersion: sref.current.inputVersion + 1, notice: res.notice, pending: null, menu: null });
        else patch({ notice: res.notice });
        return;
      }
      const now = sref.current;
      let next = {
        ...now,
        mode: 'normal',
        input: null,
        confirm: null,
        visual: null,
        focusId: res.focusId ?? now.focusId,
        notice: res.notice,
        panelScroll: null,
      };
      // res.off is the anchor's source column; the cursor is in view coordinates.
      if (res.line != null) next = nav.setCursor(next, f.ctx, res.line, { focusId: next.focusId, off: f.dv.toDisp(res.line, res.off ?? 0) });
      commit(next);
      refresh();
      if (res.sent) {
        fireDeliver(res.notice);
        offerChannelC();
      }
    } finally {
      busy.current = false;
    }
  };

  const askDiscard = (hasContent) => {
    if (!hasContent) return closeInput();
    return commit({ ...sref.current, mode: 'confirm', confirm: { kind: 'discard', text: t('review.discard'), yes: t('review.discardYes'), no: t('review.discardNo') } });
  };

  const askApprove = () => {
    if (!guardWrite()) return;
    const f = frameRef.current;
    const drafts = countDrafts(f.threads);
    const waiting = f.meta.kind === 'plan' && !dataRef.current.hookAlive;
    let text = f.meta.kind === 'plan' ? t('review.approvePlan') : t('review.approveDoc');
    if (waiting) {
      const d = dataRef.current.delivery;
      text = d?.awaitingAlive
        ? t('review.approveNotify')
        : d?.watcherAlive
          ? t('review.approveWake')
          : t('review.approveIdle');
    }
    if (drafts) text += t('review.draftsIgnored', { n: drafts });
    commit({ ...sref.current, mode: 'confirm', confirm: { kind: 'approve', text, yes: t('review.approveYes'), no: t('review.approveNo') } });
  };

  const runConfirm = async () => {
    const cur = sref.current;
    const c = cur.confirm;
    if (!c) return;
    if (c.kind === 'discard') return closeInput();
    commit({ ...cur, mode: 'normal', confirm: null });
    const f = frameRef.current;
    if (c.kind === 'approve') {
      const res = await ops.approve(id, f.meta, { awaitingAlive: !!dataRef.current.delivery?.awaitingAlive, watcherAlive: !!dataRef.current.delivery?.watcherAlive });
      patch({ notice: res.notice });
      refresh();
      if (res.finished && origin === 'inbox') onFinished?.('approved', res.notice);
    } else if (c.kind === 'adopt') {
      try {
        const r = await adoptExternal(id);
        patch({ notice: r.changed ? { text: t('review.adopted', { n: r.n }), kind: 'info' } : { text: t('review.adoptSame'), kind: 'info' } });
      } catch (err) {
        patch({ notice: { text: t('ops.failed', { message: err.message }), kind: 'err' } });
      }
      refresh();
    } else if (c.kind === 'deleteDraft') {
      const th = f.threads.find((x) => x.id === c.threadId);
      const res = th ? await ops.removeDraft(id, th) : { notice: { text: t('review.noSuchThread'), kind: 'warn' } };
      patch({ notice: res.notice });
      refresh();
    }
  };

  const cancelConfirm = () => {
    const cur = sref.current;
    commit({ ...cur, mode: cur.input ? 'input' : 'normal', confirm: null });
  };

  const runAction = async (action, extra = {}) => {
    const cur = sref.current;
    const f = frameRef.current;
    const c = f.ctx;
    switch (action) {
      case 'down':
        return commit(nav.moveCursor(cur, c, 1));
      case 'up':
        return commit(nav.moveCursor(cur, c, -1));
      case 'halfDown':
        return commit(nav.pageStep(cur, c, 1, 0.5));
      case 'halfUp':
        return commit(nav.pageStep(cur, c, -1, 0.5));
      case 'pageDown':
        return commit(nav.pageStep(cur, c, 1, 1));
      case 'pageUp':
        return commit(nav.pageStep(cur, c, -1, 1));
      case 'top':
        return commit(nav.setCursor(cur, c, 0));
      case 'bottom':
        return commit(nav.setCursor(cur, c, c.lineCount - 1));
      case 'pendingKey':
        return commit({ ...cur, pending: extra.pending });
      case 'nextThread':
      case 'prevThread': {
        const dir = action === 'nextThread' ? 1 : -1;
        const th = threadFromCursor(f.view.placed, cur.cursor, dir) ?? stepThread(f.view.orphans, cur.focusId, dir);
        if (!th) return notice(t('review.noComments'), 'warn');
        return commit(nav.jumpToThread({ ...cur, pending: null }, c, th));
      }
      case 'nextFocus':
      case 'prevFocus': {
        const list = f.view.byLine.get(cur.cursor) ?? [];
        if (list.length === 0) return undefined;
        const i = list.findIndex((t) => t.id === cur.focusId);
        const j = (i + (action === 'nextFocus' ? 1 : -1) + list.length) % list.length;
        return commit({ ...cur, focusId: list[j].id, panelScroll: null });
      }
      case 'left':
      case 'right':
      case 'wordNext':
      case 'wordPrev':
      case 'wordEnd':
      case 'lineStart':
      case 'firstNonBlank':
      case 'lineEnd':
        return commit(nav.moveColumn(cur, c, action));
      case 'visualChar':
      case 'visualLine':
        if (!guardWrite()) return undefined;
        return commit(nav.enterVisual(cur, action === 'visualChar' ? 'char' : 'line'));
      case 'escape':
        return commit(nav.clearSelection(cur));
      case 'cancel':
        return commit(nav.clearSelection(cur));
      case 'comment':
        return openComment();
      case 'commentExternal':
        return externalFromNormal('comment');
      case 'reply':
        return openReply();
      case 'replyExternal':
        return externalFromNormal('reply');
      case 'resolve': {
        if (!guardWrite()) return undefined;
        if (!f.focus) return notice(t('review.noThread'), 'warn');
        const res = await ops.toggleResolved(id, f.focus);
        patch({ notice: res.notice });
        return refresh();
      }
      case 'deleteDraft': {
        if (!guardWrite()) return undefined;
        if (!f.focus) return notice(t('review.noThread'), 'warn');
        if (!f.focus.messages.some((m) => m.author === 'user' && m.state === 'draft')) return notice(t('ops.noDraft'), 'warn');
        return commit({ ...cur, mode: 'confirm', confirm: { kind: 'deleteDraft', threadId: f.focus.id, text: t('review.deleteDraft', { id: f.focus.id }), yes: t('review.deleteYes'), no: t('review.deleteNo') } });
      }
      case 'diff': {
        if (baseCandidates(f.meta).length === 0) return notice(t('review.oneRevision'), 'info');
        return commit(dnav.openDiff(cur));
      }
      case 'channelC': {
        let offer;
        try {
          offer = channelCOffer(id);
        } catch (err) {
          return notice(t('ops.failed', { message: err.message }), 'err');
        }
        if (offer.offer) return openChannelCDialog(offer);
        const hl = dataRef.current.headless?.state === 'running' ? headlessLine(dataRef.current.headless) : null;
        if (hl) return notice(hl, 'info');
        if (offer.channel === 'none') return notice(t('review.resumeFinished'), 'info');
        if (offer.channel !== 'C') return notice(t('review.resumeAlive'), 'info');
        if (offer.reason === 'no-session') return notice(t('review.resumeNoSession'), 'warn');
        return notice(t('review.resumeNothing'), 'info');
      }
      case 'adoptExternal': {
        if (!guardWrite()) return undefined;
        const e = externalRef.current;
        if (e.state === 'missing') return notice(t('review.extMissing'), 'warn');
        if (e.state !== 'changed') return notice(t('review.extSame'), 'info');
        if (!e.canAdopt) return notice(t('review.extCannot', { why: e.tooLarge ? t('external.tooLarge') : t('external.notText') }), 'warn');
        const n = f.meta.currentRevision + 1;
        return commit({ ...nav.clearSelection(cur), mode: 'confirm', confirm: { kind: 'adopt', text: t('review.adoptConfirm', { n }), yes: t('review.adoptYes'), no: t('review.adoptNo') } });
      }
      case 'rebind': {
        if (!guardWrite()) return undefined;
        if (f.meta.kind !== 'doc') return notice(t('review.rebindDocOnly'), 'warn');
        const items = sessionChoices(f.meta);
        if (items.length < 2) return notice(t('review.rebindNone'), 'info');
        const first = Math.max(0, items.findIndex((x) => !x.current));
        return commit({ ...nav.clearSelection(cur), mode: 'picker', picker: { items, index: first, first: 0 }, pending: null });
      }
      case 'submit': {
        if (!guardWrite()) return undefined;
        if (cur.sendMode !== 'batch') return notice(t('review.batchHint'), 'info');
        const res = await ops.submitDrafts(id);
        patch({ notice: res.notice });
        refresh();
        if (res.ok) fireDeliver(res.notice);
        // Feedback for a session that has ended stays on this screen long enough to choose what to do with it.
        const offered = res.ok && offerChannelC();
        if (res.ok && origin === 'inbox' && !offered) onFinished?.('submitted', res.notice);
        return undefined;
      }
      case 'toggleMode': {
        const next = cur.sendMode === 'instant' ? 'batch' : 'instant';
        return commit({ ...cur, sendMode: next, notice: { text: next === 'batch' ? t('review.modeBatch') : t('review.modeInstant'), kind: 'info' } });
      }
      case 'approve':
        return askApprove();
      case 'endQna': {
        if (!guardWrite()) return undefined;
        const res = await endInstant(id); // the whole session's instant Q&A, see store/lifecycle.js
        patch({ notice: endInstantNotice({ ...res, watcherAlive: !!dataRef.current.delivery?.watcherAlive }) });
        refresh();
        return undefined;
      }
      case 'back':
        return onBack?.();
      case 'help':
        return commit({ ...cur, mode: 'help', helpTop: 0, pending: null });
      case 'toggleMd': {
        if (!f.views.markdown) return notice(t('review.notMarkdown'), 'warn');
        const md = cur.md === 'rendered' ? 'source' : 'rendered';
        const row = f.doc.window(cur.top, f.geo.bodyH).rowOf(cur.cursor);
        const switched = nav.switchView(cur, md, row >= 0 ? row : null);
        onMdMode?.(md);
        return commit({ ...switched, notice: { text: md === 'rendered' ? t('review.mdRendered') : t('review.mdSource'), kind: 'info' } });
      }
      case 'toggleMouse': {
        if (isMouseEnabled()) disableMouse();
        else enableMouse();
        return commit({ ...cur, mouseOn: isMouseEnabled(), notice: { text: isMouseEnabled() ? t('review.mouseOn') : t('review.mouseOff'), kind: 'info' } });
      }
      case 'panelDown':
        return commit({ ...cur, panelScroll: f.panel.clamp((cur.panelScroll ?? f.panel.shift) + 3), drawerScroll: cur.drawerScroll + 3 });
      case 'panelUp':
        return commit({ ...cur, panelScroll: f.panel.clamp((cur.panelScroll ?? f.panel.shift) - 3), drawerScroll: Math.max(0, cur.drawerScroll - 3) });
      case 'confirmYes':
        return runConfirm();
      case 'confirmNo':
        return cancelConfirm();
      default:
        return undefined;
    }
  };

  /** The diff view's keys and buttons (read-only; `runAction` still serves the panel scroll and the mouse toggle). */
  const runDiffAction = async (action, extra = {}) => {
    const cur = sref.current;
    const f = frameRef.current;
    const dc = f.dctx;
    if (!dc) return undefined;
    switch (action) {
      case 'down':
        return commit(dnav.moveDiffCursor(cur, dc, 1));
      case 'up':
        return commit(dnav.moveDiffCursor(cur, dc, -1));
      case 'halfDown':
        return commit(dnav.pageDiff(cur, dc, 1, 0.5));
      case 'halfUp':
        return commit(dnav.pageDiff(cur, dc, -1, 0.5));
      case 'pageDown':
        return commit(dnav.pageDiff(cur, dc, 1, 1));
      case 'pageUp':
        return commit(dnav.pageDiff(cur, dc, -1, 1));
      case 'top':
        return commit(dnav.setDiffCursor(cur, dc, 0));
      case 'bottom':
        return commit(dnav.setDiffCursor(cur, dc, dc.lineCount - 1));
      case 'pendingKey':
        return commit({ ...cur, pending: extra.pending });
      case 'diffNext':
      case 'diffPrev': {
        const dir = action === 'diffNext' ? 1 : -1;
        const next = dnav.stepDiffChange({ ...cur, pending: null }, dc, dir);
        if (next.diff === cur.diff) return patch({ pending: null, notice: { text: dir > 0 ? t('review.noNextChange') : t('review.noPrevChange'), kind: 'info' } });
        return commit(next);
      }
      case 'diffOlder':
      case 'diffNewer': {
        const dir = action === 'diffOlder' ? -1 : 1;
        const next = dnav.stepDiffBase({ ...cur, pending: null }, f.meta, dir);
        if (next.diff === cur.diff) return patch({ pending: null, notice: { text: dir < 0 ? t('review.oldestRevision') : t('review.newestBase'), kind: 'info' } });
        return commit(next);
      }
      case 'diffJump':
        return commit(dnav.jumpToNormal(cur, dc, { lineCount: f.lines.length, bodyH: f.geo.bodyH }));
      case 'diff':
      case 'diffBack':
        return commit(dnav.closeDiff(cur));
      case 'diffReadOnly':
        return notice(t('review.diffReadOnly'), 'warn');
      case 'help':
        return commit({ ...cur, mode: 'help', helpTop: 0, pending: null });
      case 'panelDown':
      case 'panelUp':
      case 'toggleMouse':
        return runAction(action, extra);
      default:
        return undefined;
    }
  };

  const appendEarlyText = (input, key) => {
    if (key.ctrl || key.meta || key.escape || key.return || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.backspace || key.delete) return;
    const text = sanitizeInput(input);
    const cur = sref.current;
    if (text && cur.input) commit({ ...cur, input: { ...cur.input, text: cur.input.text + text } });
  };

  const onActionError = (err) => patch({ notice: { text: t('ops.failed', { message: err?.message ?? err }), kind: 'err' } });
  /** Run an action; failures of the async part become a notice instead of an unhandled rejection. */
  const run = (action, extra) => {
    (sref.current.diff ? runDiffAction : runAction)(action, extra).catch(onActionError);
  };

  /** Picker rows: move / choose / cancel. Choosing rebinds the review's session. */
  const pickerAction = async (name) => {
    const cur = sref.current;
    const p = cur.picker;
    if (!p) return;
    if (name === 'cancel') return commit({ ...cur, mode: 'normal', picker: null });
    if (name === 'pick') {
      const item = p.items[p.index];
      commit({ ...cur, mode: 'normal', picker: null });
      if (!item || item.current) return notice(t('review.alreadyBound'), 'info');
      try {
        await rebindSession(id, item.sessionId);
        patch({ notice: { text: t('review.rebound', { id: item.sessionId.slice(0, 8), project: item.project }), kind: 'info', ms: 6000 } });
      } catch (err) {
        patch({ notice: { text: t('review.rebindFailed', { message: err.message }), kind: 'err', ms: 8000 } });
      }
      refresh();
      return;
    }
    commit({ ...cur, picker: { ...p, index: movePick(p.index, p.items.length, name) } });
  };

  /** A press on a dialog / picker row. */
  const overlayAction = (name) => {
    if (name.startsWith('dialog:')) return dialogAction(name.slice(7));
    if (name.startsWith('pick:')) {
      const cur = sref.current;
      if (!cur.picker) return undefined;
      commit({ ...cur, picker: { ...cur.picker, index: Number(name.slice(5)) } });
      return pickerAction('pick');
    }
    return undefined;
  };

  // ---- keyboard ----------------------------------------------------------------------------------------------
  const onKey = (input, key) => {
    const cur = sref.current;
    if (cur.mode === 'help') {
      // Arrows / paging scroll the help text; any other key closes it.
      const max = frameRef.current.helpMax ?? 0;
      const page = Math.max(1, (frameRef.current.overlayH ?? frameRef.current.geo.bodyH) - 2);
      let top = null;
      if (key.downArrow) top = cur.helpTop + 1;
      else if (key.upArrow) top = cur.helpTop - 1;
      else if (key.pageDown || (key.ctrl && input === 'f')) top = cur.helpTop + page;
      else if (key.pageUp || (key.ctrl && input === 'b')) top = cur.helpTop - page;
      else if (key.ctrl && input === 'd') top = cur.helpTop + Math.floor(page / 2);
      else if (key.ctrl && input === 'u') top = cur.helpTop - Math.floor(page / 2);
      else if (key.home) top = 0;
      else if (key.end) top = max;
      if (top === null) return commit({ ...cur, mode: 'normal' });
      return commit({ ...cur, helpTop: Math.max(0, Math.min(max, top)) });
    }
    if (cur.mode === 'dialog') {
      if (cur.dialog?.busy) return undefined;
      const r = mapDialogKey(input, key);
      return r ? dialogAction(r).catch(onActionError) : undefined;
    }
    if (cur.mode === 'picker') {
      const r = mapPickerKey(input, key);
      return r ? pickerAction(r).catch(onActionError) : undefined;
    }
    if (cur.mode === 'confirm') {
      const r = mapConfirmKey(input, key);
      if (r === 'yes') return runConfirm();
      if (r === 'no') return cancelConfirm();
      return undefined;
    }
    if (cur.mode === 'menu') {
      const m = cur.menu;
      if (key.escape || input === 'q' || (key.ctrl && input === 'c')) return commit({ ...cur, mode: 'normal', menu: null });
      if (key.downArrow || input === 'j') return commit({ ...cur, menu: { ...m, index: (m.index + 1) % m.ids.length } });
      if (key.upArrow || input === 'k') return commit({ ...cur, menu: { ...m, index: (m.index + m.ids.length - 1) % m.ids.length } });
      if (key.return) {
        const t = frameRef.current.view.order.find((x) => x.id === m.ids[m.index]);
        return commit(nav.jumpToThread({ ...cur, mode: 'normal', menu: null }, frameRef.current.ctx, t));
      }
      return undefined;
    }
    if (cur.notice && (key.escape || key.return)) patch({ notice: null });
    if (cur.diff) {
      const dr = mapDiffKey(input, key, cur.pending);
      if (!dr) return cur.pending ? commit({ ...cur, pending: null }) : undefined;
      return run(dr.action, dr);
    }
    const r = mapKey(input, key, cur.pending, cur.mode === 'visual' ? 'visual' : 'normal');
    if (!r) return cur.pending ? commit({ ...cur, pending: null }) : undefined;
    if (r.action === 'enter') return undefined;
    return run(r.action, r);
  };
  // Always subscribed (Ink adds and removes input handlers in passive effects, so toggling `isActive` would leave
  // a window in which keys are lost or reach the wrong handler). While the comment box is open it owns the
  // keyboard; keys that arrive before it has subscribed are kept as text instead of being run as commands.
  useInput((input, key) => {
    if (!isCurrent()) return;
    const cur = sref.current;
    if (cur.mode === 'input') {
      if (!inputReady.current && cur.input) appendEarlyText(input, key);
      return;
    }
    const parts = splitKeys(input, key);
    for (let i = 0; i < parts.length; i++) {
      onKey(parts[i][0], parts[i][1]);
      if (sref.current.mode === 'input') {
        // "c" and the text typed right behind it arrived in one chunk: the text belongs in the box.
        const rest = parts.slice(i + 1).map((p) => p[0]).join('');
        if (rest) appendEarlyText(rest, {});
        break;
      }
    }
  });

  // ---- mouse -------------------------------------------------------------------------------------------------
  useBusEvent(bus, 'mouse', (ev) => {
    const f = frameRef.current;
    if (!f || !isCurrent()) return;
    const out = handleMouse(ev, sref.current, f, f.ctx);
    if (out.state !== sref.current) commit(out.state);
    const e = out.effect;
    if (!e) return;
    if (e.type === 'action') run(e.name === 'cancel' ? 'escape' : e.name);
    else if (e.type === 'closeHelp') commit({ ...sref.current, mode: 'normal' });
    else if (e.type === 'overlay') overlayAction(e.action)?.catch?.(onActionError);
    else if (e.type === 'boxSend') {
      const t = sref.current.input?.text ?? '';
      if (t.trim()) submitInput(t).catch(onActionError);
    } else if (e.type === 'boxCancel') askDiscard((sref.current.input?.text ?? '').length > 0);
  });

  // ---- render ------------------------------------------------------------------------------------------------
  if (geo.tooSmall) {
    return h(Box, { padding: 1 }, h(Text, { color: COLOR.warn }, t('review.tooSmall', { cols, rows: rowsTotal })));
  }

  const split = wide && !overlay; // a dialog covers the whole body: no panel separator in the rules
  const topRule = ruleLine(cols, GLYPH.tee, split ? geo.sepX : -1);
  let bottomRule;
  if (wide) bottomRule = ruleLine(cols, GLYPH.teeUp, split ? geo.sepX : -1);
  else if (geo.drawerH > 0) {
    const label = t('review.panelLabel', { n: view.order.length });
    bottomRule = chalk.dim(GLYPH.hbar.repeat(2)) + chalk.bold(label) + chalk.dim(GLYPH.hbar.repeat(Math.max(0, cols - 2 - stringWidth(label))));
  } else bottomRule = ruleLine(cols, GLYPH.hbar, -1);

  const body =
    s.mode === 'help'
      ? h(Help, { width: cols, height: overlayH, top: s.helpTop })
      : overlay
        ? h(Rows, { rows: overlay.rows, width: cols, height: overlayH })
        : h(
            Box,
            { flexDirection: 'row', width: cols, height: geo.bodyH },
            h(DocView, { rows: D ? D.docRows : F.docRows, width: geo.docW, height: geo.bodyH }),
            wide ? h(Separator, { height: geo.bodyH }) : null,
            wide ? h(ThreadPanel, { rows: D ? D.panelRows : F.panelRows, width: geo.panelW, height: geo.bodyH }) : null,
          );

  const box =
    s.input && boxRect
      ? h(CommentBox, {
          x: boxRect.x,
          y: boxRect.y,
          width: boxRect.w,
          title: s.input.kind === 'reply' ? t('review.replyTitle', { id: s.input.threadId }) : t('review.commentTitle', { label: lineLabel({ startLine: s.input.sel.startLine, endLine: s.input.sel.endLine }) }),
          text: s.input.text,
          version: s.inputVersion,
          active: s.mode === 'input',
          maxRows,
          onActive: (a) => {
            inputReady.current = a;
          },
          sendMode: s.sendMode,
          bus,
          onChange: (t) => {
            const cur = sref.current;
            if (cur.input && cur.input.text !== t) commit({ ...cur, input: { ...cur.input, text: t } });
          },
          onSubmit: (t) => submitInput(t).catch(onActionError),
          onCancel: (hasContent) => askDiscard(hasContent),
          onEditExternal: (boxText) => {
            const inp = sref.current.input;
            if (!inp) return;
            runEditor(boxText, headerFor(inp, 'box'))
              .then((r) => {
                const cur = sref.current;
                if (!cur.input) return;
                if (r.status === 'failed') patch({ notice: editorFailed(r, t('review.boxKept')) });
                else if (r.status === 'unchanged') patch({ notice: { text: t('review.editorUnchangedBox'), kind: 'warn' } });
                else commit({ ...cur, input: { ...cur.input, text: r.text }, inputVersion: cur.inputVersion + 1 });
              })
              .catch(onActionError);
          },
        })
      : null;

  return h(
    Box,
    { flexDirection: 'column', width: cols, height: rowsTotal },
    h(Row, { segs: header }),
    h(Text, { wrap: 'truncate' }, topRule),
    body,
    takesAll ? null : h(Text, { wrap: 'truncate' }, bottomRule),
    drawer && !takesAll ? h(Rows, { rows: drawer.rows, width: cols, height: geo.drawerH }) : null,
    h(StatusBar, { segs: status.segs }),
    box,
  );
}
