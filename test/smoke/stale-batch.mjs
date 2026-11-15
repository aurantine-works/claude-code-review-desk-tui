// Make a review look like "Claude received a batch 2 minutes ago and never answered" (the lost wake-up case):
// sends a comment, marks it received 120 s ago. Usage: RD_HOME=<dir> node stale-batch.mjs <reviewId>
import { addThread } from '../../src/store/threads.js';
import { takeUnreceived } from '../../src/store/outbox.js';
import { withReview } from '../../src/store/reviews.js';
import { makeAnchor } from '../../src/anchor/index.js';
import { readRevision } from '../../src/store/reviews.js';

const [id] = process.argv.slice(2);
const content = readRevision(id, 1);
await addThread(id, { anchor: makeAnchor(content, { startLine: 3, endLine: 3 }, 1), text: 'A question that never got an answer', send: true });
await takeUnreceived(id, { via: 'await' });
const old = new Date(Date.now() - 120_000).toISOString();
await withReview(id, (ctx) => {
  for (const e of ctx.outbox) e.receivedAt = old;
});
console.log('ok');
