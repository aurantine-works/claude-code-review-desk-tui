// Root component: routes between Inbox and Review, and implements watch mode (auto-open new plans).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useApp, useWindowSize } from 'ink';
import { Inbox } from './Inbox.js';
import { Review } from './Review.js';
import { useInbox } from './useStore.js';
import { bell } from './terminal.js';
import { autoOpenKey, findAutoOpen, newlyAnswered } from './lib/watch.js';
import { closeReview } from '../store/index.js';
import { createWakeWatcher, WAKE_POLL_MS, wakeOkText } from './lib/wakeWatcher.js';
import { createResumeWatcher } from '../delivery/resume.js';
import { t } from '../i18n/index.js';

/** The one-time message after the resume watcher typed `/review-reply` into a session that was resumed (channel C). */
export const resumeOkText = () => t('wake.resumed');

const h = React.createElement;

/**
 * @param {object} p
 * @param {import('node:events').EventEmitter} p.bus
 * @param {{columns: number, rows: number}} [p.size]  overrides the terminal size (tests)
 * @param {object} p.config
 * @param {string} [p.reviewId]   open this review first (`rd open <id>`); `q` then quits
 * @param {boolean} [p.watch]     auto-open new plan reviews
 * @param {number} [p.pollMs]        inbox poll interval
 * @param {number} [p.reviewPollMs]  review poll interval
 * @param {number} [p.wakePollMs]    wake-up check interval (lib/wakeWatcher.js)
 * @param {object} [p.wakeDeps]      overrides for the wake watcher (tests): deliveryState, planDelivery, injectWake, now, ...
 * @param {number} [p.resumePollMs]  check interval of the resume watcher (delivery/resume.js createResumeWatcher)
 * @param {object} [p.resumeDeps]    overrides for the resume watcher (tests): planDelivery, deliver, waitingSince, now
 */
export function App({ bus, size, config, reviewId, watch = false, pollMs = 2000, reviewPollMs = 1000, wakePollMs = WAKE_POLL_MS, wakeDeps, resumePollMs = WAKE_POLL_MS, resumeDeps }) {
  const { exit } = useApp();
  const win = useWindowSize();
  const dims = size ?? { columns: win.columns, rows: win.rows };
  const inbox = useInbox(pollMs);
  const [route, setRouteState] = useState(reviewId ? { name: 'review', id: reviewId, origin: 'open' } : { name: 'inbox' });
  // Input hooks (Ink's useInput, the mouse bus) unsubscribe in passive effects, i.e. a moment after the screen
  // changed. This ref switches synchronously so a key typed in that window cannot reach the old screen.
  const routeRef = useRef(route);
  const setRoute = useCallback((r) => {
    routeRef.current = r;
    setRouteState(r);
  }, []);
  const isCurrent = useCallback((name) => () => routeRef.current.name === name, []);
  const [ui, setUiState] = useState({ selectedId: null, showAll: false });
  const setUi = useCallback((p) => setUiState((cur) => ({ ...cur, ...p })), []);
  const seen = useRef(new Set());
  const belled = useRef(new Set());
  // How Markdown bodies are shown ('rendered' | 'source'); the M key in a review sets it, later reviews start with it.
  const mdMode = useRef(config?.ui?.markdown === 'source' ? 'source' : 'rendered');
  const setMdMode = useCallback((m) => {
    mdMode.current = m;
  }, []);
  const data = inbox.value ?? { metas: [], threads: {}, hookAlive: {} };

  // Watch mode: open a plan as soon as its hook starts waiting.
  useEffect(() => {
    if (!watch || route.name !== 'inbox') return;
    const cand = findAutoOpen(data, seen.current, { docsAutoOpen: config?.docs?.autoOpen === true });
    if (!cand) return;
    seen.current.add(cand.key);
    bell();
    setRoute({ name: 'review', id: cand.id, origin: 'inbox' });
  }, [watch, route, data, config, setRoute]);

  // Watch mode: a review that Claude has just answered rings the bell once (not at start-up for reviews that were already answered).
  const statuses = useRef(null);
  const polled = inbox.value?.metas ?? null;
  useEffect(() => {
    if (!polled) return;
    const prev = statuses.current;
    statuses.current = new Map(polled.map((m) => [m.id, m.status]));
    if (watch && prev && newlyAnswered(prev, polled).length > 0) bell();
  }, [watch, polled]);

  // A new plan arrives while another review is open: ring once; it opens when the user goes back.
  const incoming = watch && route.name === 'review' ? findAutoOpen(data, seen.current, { docsAutoOpen: config?.docs?.autoOpen === true }) : null;
  useEffect(() => {
    if (incoming && incoming.id !== route.id && !belled.current.has(incoming.key)) {
      belled.current.add(incoming.key);
      bell();
    }
  }, [incoming, route]);

  // Wake-ups of idle sessions that received feedback and never answered: checked here, not in
  // the review screen, so it also runs in the inbox and survives navigating. A success is announced once, in the
  // review screen (notice) or the inbox (footer).
  const [wake, setWake] = useState(null);
  const metasRef = useRef(data.metas);
  metasRef.current = data.metas;
  const wakeDepsRef = useRef(wakeDeps); // test overrides, read once at mount
  useEffect(() => {
    const watcher = createWakeWatcher({ listReviews: () => metasRef.current, ...wakeDepsRef.current });
    let stopped = false;
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const woke = await watcher.tick();
        if (!stopped && woke.length > 0) setWake({ text: wakeOkText(), at: Date.now(), ms: 4000 });
      } catch {
        /* a failed check is retried on the next tick */
      } finally {
        running = false;
      }
    };
    run();
    const t = setInterval(run, wakePollMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [wakePollMs]);
  // Feedback that waited for a dead session (channel C) is handed over once that session is alive and idle again (the user
  // resumed it with the command from the dialog): rd types /review-reply when an injector exists, else the next message carries it.
  const resumeDepsRef = useRef(resumeDeps);
  useEffect(() => {
    const watcher = createResumeWatcher({ listReviews: () => metasRef.current, ...resumeDepsRef.current });
    let stopped = false;
    const run = async () => {
      try {
        const done = await watcher.tick(); // (the watcher never overlaps its own runs)
        if (!stopped && done.some((d) => d.result?.action === 'injected')) setWake({ text: resumeOkText(), at: Date.now(), ms: 4000 });
      } catch {
        /* a failed check is retried on the next tick */
      }
    };
    run();
    const t = setInterval(run, resumePollMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [resumePollMs]);
  useEffect(() => {
    if (!wake) return undefined;
    const t = setTimeout(() => setWake(null), wake.ms);
    return () => clearTimeout(t);
  }, [wake]);

  const open = useCallback(
    (id) => {
      const m = data.metas.find((x) => x.id === id);
      if (m) seen.current.add(autoOpenKey(m));
      setUi({ selectedId: id });
      setRoute({ name: 'review', id, origin: 'inbox' });
    },
    [data, setUi, setRoute],
  );

  const back = useCallback(() => {
    if (route.origin === 'open') exit();
    else setRoute({ name: 'inbox' });
  }, [route, exit, setRoute]);

  // A message from the review that just ended (e.g. "approved; Claude is not waiting") stays visible in the inbox.
  const [flash, setFlash] = useState(null);
  const onFinished = useCallback(
    (_why, notice) => {
      setRoute({ name: 'inbox' });
      if (notice) setFlash({ text: notice.text, at: Date.now(), ms: notice.ms ?? 4000 });
    },
    [setRoute],
  );
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), flash.ms);
    return () => clearTimeout(t);
  }, [flash]);

  const onClose = useCallback(async (id) => {
    await closeReview(id);
    inbox.refresh();
  }, [inbox]);

  return h(
    Box,
    { width: dims.columns, height: dims.rows, flexDirection: 'column' },
    route.name === 'review'
      ? h(Review, {
          key: route.id,
          id: route.id,
          bus,
          size: dims,
          config,
          origin: route.origin,
          incoming: incoming && incoming.id !== route.id ? incoming.meta.title : null,
          wakeNotice: wake,
          mdMode: mdMode.current,
          onMdMode: setMdMode,
          pollMs: reviewPollMs,
          isCurrent: isCurrent('review'),
          onBack: back,
          onFinished,
        })
      : h(Inbox, { data, size: dims, bus, watch, ui, setUi, flash: flash ?? wake, isCurrent: isCurrent('inbox'), onOpen: open, onClose, onQuit: exit }),
  );
}
