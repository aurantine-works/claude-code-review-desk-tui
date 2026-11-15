// Seed a demo doc review (use with RD_HOME=<tmp>). Prints the review id.
import { createReview } from '../../src/store/reviews.js';
import { addThread } from '../../src/store/threads.js';
import { makeAnchor } from '../../src/anchor/index.js';

const content = ['# Weekly report', '', '## Risks', 'Migrating the old store is low risk because it only affects two slices.', '', '## Schedule', 'Expected to take two weeks.'].join('\n');
const meta = await createReview({ kind: 'doc', docPath: '/tmp/week-45.md', sessionId: 'demo', cwd: process.cwd(), content, source: 'Write', turn: 1 });
await addThread(meta.id, { anchor: makeAnchor(content, { startLine: 4, endLine: 4 }, 1), text: 'What makes the risk low?', send: true });
await addThread(meta.id, { anchor: makeAnchor(content, { startLine: 7, endLine: 7, startCol: 0, endCol: 4 }, 1), text: 'Does it include testing?', send: true });
console.log(meta.id);
