import crypto from 'node:crypto';
import { stamp } from './time.js';

export const REVIEW_ID_RE = /^(plan|doc)-\d{8}-\d{6}-[a-z0-9]{4}$/;
export const THREAD_ID_RE = /^t\d+$/;
export const MESSAGE_ID_RE = /^m\d+$/;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newReviewId(kind) {
  if (kind !== 'plan' && kind !== 'doc') throw new Error(`invalid review kind: ${kind}`);
  let rand = '';
  for (let i = 0; i < 4; i++) rand += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${kind}-${stamp()}-${rand}`;
}

/** Every entry point (CLI args, outbox, injection) must pass through this check. */
export function assertReviewId(id) {
  if (typeof id !== 'string' || !REVIEW_ID_RE.test(id)) {
    throw new Error(`invalid review id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function assertThreadId(id) {
  if (typeof id !== 'string' || !THREAD_ID_RE.test(id)) {
    throw new Error(`invalid thread id: ${JSON.stringify(id)}`);
  }
  return id;
}
