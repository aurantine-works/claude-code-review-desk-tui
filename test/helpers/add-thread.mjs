// Child process used by the concurrency test: adds one thread to a review.
import { addThread } from '../../src/store/threads.js';
const [id, n] = process.argv.slice(2);
await addThread(id, {
  anchor: { revision: 1, startLine: 1, endLine: 1, startCol: null, endCol: null, quote: 'a', before: '', after: '', orphaned: false },
  text: `comment ${n}`,
  send: true,
});
