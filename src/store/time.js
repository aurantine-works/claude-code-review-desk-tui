// Time helpers. Deliberately free of moment so hooks and the statusline stay fast to start.

/** ISO timestamp (UTC) for stored data; identical to moment().toISOString(). */
export const nowIso = () => new Date().toISOString();

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Local-time stamp `YYYYMMDD-HHmmss` (review ids, backup file names). */
export function stamp(d = new Date()) {
  return (
    `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
