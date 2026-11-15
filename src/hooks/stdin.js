// Bounded stdin reader shared by hooks and the statusline.

/**
 * Read stdin as text. Resolves on 'end'/'close'/error, or after `timeoutMs`
 * with whatever has arrived so far, so a parent that never closes the pipe can
 * not hang us. A TTY (manual run) yields ''.
 */
export function readStdin({ stream = process.stdin, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) return resolve('');
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', finish);
      stream.removeListener('close', finish);
      stream.removeListener('error', finish);
      try {
        stream.pause?.();
      } catch {
        /* ignore */
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const timer = setTimeout(finish, timeoutMs);
    stream.on('data', onData);
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

/** JSON.parse that returns null for empty or malformed input. */
export function parseJsonLoose(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
