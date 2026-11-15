// Polling readers over the on-disk store. State lives in files, not in watchers (fs.watch is unreliable on
// remote filesystems), so the TUI re-reads on a timer and re-renders only when something changed.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listMetas,
  getMeta,
  readRevision,
  listThreads,
  getSession,
  isPidAlive,
  checkExternal,
} from '../store/index.js';
import { planDelivery, deliveryState } from '../delivery/index.js';
import { headlessStatus } from '../delivery/resume.js';
import { summarizeDelivery } from './lib/deliveryModel.js';

const FINAL = new Set(['approved', 'closed']);

/**
 * Poll `read()` every `ms`. The value keeps its identity until its signature changes.
 * @template T
 * @param {() => T} read
 * @param {number} ms
 * @param {{sig?: (v: T) => string}} [opts]
 * @returns {{value: T | null, error: Error | null, refresh: () => void}}
 */
export function usePoll(read, ms, { sig = JSON.stringify } = {}) {
  const readRef = useRef(read);
  readRef.current = read;
  const sigFn = useRef(sig);
  const sigRef = useRef('');
  const [state, setState] = useState(() => {
    try {
      const value = read();
      sigRef.current = sig(value);
      return { value, error: null };
    } catch (error) {
      return { value: null, error };
    }
  });

  const refresh = useCallback(() => {
    try {
      const value = readRef.current();
      const s = sigFn.current(value);
      if (s !== sigRef.current) {
        sigRef.current = s;
        setState({ value, error: null });
      } else {
        setState((cur) => (cur.error ? { value: cur.value, error: null } : cur));
      }
    } catch (error) {
      setState((cur) => (cur.error?.message === error.message ? cur : { value: cur.value, error }));
    }
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  }, [ms, refresh]);

  return { value: state.value, error: state.error, refresh };
}

/** Everything the inbox needs: all metas, thread lists of open reviews, liveness of waiting hooks. */
export function readInbox() {
  const metas = listMetas();
  const threads = {};
  const hookAlive = {};
  for (const m of metas) {
    if (!FINAL.has(m.status)) {
      try {
        threads[m.id] = listThreads(m.id);
      } catch {
        threads[m.id] = [];
      }
    }
    hookAlive[m.id] = !!m.hook && isPidAlive(m.hook.pid);
  }
  return { metas, threads, hookAlive };
}

export const useInbox = (ms = 2000) => usePoll(readInbox, ms);

/** Reader for one review. Revision contents are cached (a revision never changes once written... except merges, which bump sha1). */
export function makeReviewReader(id) {
  const contents = new Map();
  return function readReview() {
    const meta = getMeta(id);
    const threads = listThreads(id);
    const sha = meta.revisions?.[meta.revisions.length - 1]?.sha1 ?? '';
    const key = `${meta.currentRevision}:${sha}`;
    let content = contents.get(key);
    if (content === undefined) {
      content = readRevision(id, meta.currentRevision);
      contents.set(key, content);
    }
    const session = meta.sessionId ? getSession(meta.sessionId) : null;
    // Synchronous, cheap reads (a few small files and kill -0): done here, in the 1 s poll, never per keystroke.
    let delivery = null;
    try {
      delivery = summarizeDelivery(planDelivery(id), deliveryState(id));
    } catch {
      /* a half-written review or an unreadable sessions.json: show the review without delivery hints */
    }
    // The background resume of channel C [h] (null when none was started) and whether the file changed behind our back.
    // Both are cheap and synchronous; the 3 s persistence rule for the latter is applied by the screen.
    let headless = null;
    try {
      headless = headlessStatus(id, { meta, session });
      // A finished / failed run is shown only while nothing happened since it ended (resumed session, later comment).
      if (headless?.superseded) headless = null;
    } catch {
      /* unreadable outbox / threads: no headless line */
    }
    let external = null;
    try {
      external = checkExternal(id);
    } catch {
      /* a half-written meta: no banner */
    }
    // rd's own background resume is running: the feedback is about to be fetched even though the session record still says ended.
    if (delivery && headless?.state === 'running') delivery = { ...delivery, headlessRunning: true };
    return {
      meta,
      threads,
      content,
      session,
      sessionAlive: session ? isPidAlive(session.pid) : false,
      hookAlive: !!meta.hook && isPidAlive(meta.hook.pid),
      delivery,
      headless,
      external,
    };
  };
}

const reviewSig = (v) => JSON.stringify([v.meta, v.threads, v.session, v.sessionAlive, v.hookAlive, v.delivery, v.headless, v.external]);

export function useReview(id, ms = 1000) {
  const reader = useRef(null);
  if (!reader.current || reader.current.id !== id) reader.current = { id, read: makeReviewReader(id) };
  return usePoll(() => reader.current.read(), ms, { sig: reviewSig });
}
