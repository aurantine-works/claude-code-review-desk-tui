/**
 * React hook: subscribe to an event on the input bus (see mouse/filteredStdin.js `createBus`).
 */
import { useEffect, useRef } from 'react';

/**
 * Call `handler(...args)` whenever `bus` emits `event` (`'mouse'` or `'paste'`) while `isActive`.
 * The latest `handler` is always used, so callers may pass inline closures without resubscribing.
 *
 * @param {import('node:events').EventEmitter | undefined | null} bus
 * @param {'mouse' | 'paste' | string} event
 * @param {(...args: any[]) => void} handler
 * @param {{isActive?: boolean}} [options]
 */
export function useBusEvent(bus, event, handler, { isActive = true } = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!bus || !isActive) return undefined;
    const fn = (...args) => ref.current(...args);
    bus.on(event, fn);
    return () => {
      bus.off(event, fn);
    };
  }, [bus, event, isActive]);
}
