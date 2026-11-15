import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { useTempHome } from './helpers/env.js';
import { planGc, applyGc, gcCommand, formatPlan, LOG_MAX_BYTES, LOG_KEEP_BYTES } from '../src/cli/gc.js';
import { paths } from '../src/store/paths.js';
import { createReview, getMeta } from '../src/store/reviews.js';
import { setActiveReview, getActiveReview } from '../src/store/docsIndex.js';
import { updateSession, readSessions } from '../src/store/sessions.js';
import { readJson, writeJsonAtomic } from '../src/store/io.js';
import { addThread } from '../src/store/threads.js';
import { makeAnchor } from '../src/anchor/index.js';

const BIN = fileURLToPath(new URL('../bin/rd.js', import.meta.url));
const home = useTempHome();
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

/** A review with the given status and age (days since its last update). */
async function review({ kind = 'doc', status, age, sessionId = 'sess-a', docPath = null, title }) {
  const content = `# ${title ?? 'T'}\n\nbody\n`;
  const m = await createReview({ kind, docPath: kind === 'doc' ? (docPath ?? `/tmp/gc-${Math.random()}.md`) : null, sessionId, cwd: '/w', content, source: 'Write' });
  await addThread(m.id, { anchor: makeAnchor(content, { startLine: 1, endLine: 1 }, 1), text: 'q?', send: false });
  const meta = readJson(paths.meta(m.id), null);
  meta.status = status;
  meta.updatedAt = ago(age);
  writeJsonAtomic(paths.meta(m.id), meta);
  return m.id;
}
const exists = (id) => fs.existsSync(paths.reviewDir(id));
const writeLines = (rows) => fs.writeFileSync(paths.writes(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

describe('rd gc: reviews', () => {
  it('deletes closed / approved reviews older than N days, nothing else', async () => {
    const oldClosed = await review({ status: 'closed', age: 45 });
    const oldApproved = await review({ kind: 'plan', status: 'approved', age: 31 });
    const youngClosed = await review({ status: 'closed', age: 5 });
    const oldOpen = await review({ status: 'awaiting_review', age: 90 });
    const oldAnswered = await review({ status: 'answered', age: 90 });
    const plan = planGc({ days: 30 });
    expect(plan.reviews.map((r) => r.id).sort()).toEqual([oldClosed, oldApproved].sort());
    expect(plan.reviews.every((r) => r.bytes > 0)).toBe(true);
    const done = await applyGc(plan);
    expect(done.reviews.sort()).toEqual([oldClosed, oldApproved].sort());
    expect(exists(oldClosed)).toBe(false);
    expect(exists(oldApproved)).toBe(false);
    for (const keep of [youngClosed, oldOpen, oldAnswered]) expect(exists(keep)).toBe(true);
    expect(done.errors).toEqual([]);
    expect(fs.readdirSync(paths.tmp())).toEqual([]); // the trash is gone too
  });

  it('--days is the limit (0 = every finished review)', async () => {
    const a = await review({ status: 'closed', age: 2 });
    expect(planGc({ days: 3 }).reviews).toEqual([]);
    expect(planGc({ days: 1 }).reviews.map((r) => r.id)).toEqual([a]);
  });

  it('removes docs-index entries of the deleted reviews and dangling ones, keeps live ones', async () => {
    const docPath = '/tmp/gc-doc-a.md';
    const old = await review({ status: 'closed', age: 60, docPath });
    const live = await review({ status: 'in_review', age: 1, docPath: '/tmp/gc-doc-b.md' });
    await setActiveReview(docPath, old);
    await setActiveReview('/tmp/gc-doc-b.md', live);
    await setActiveReview('/tmp/gc-doc-c.md', 'doc-20200101-000000-dead'); // its review is long gone
    const plan = planGc({ days: 30 });
    expect(plan.docsIndex.map((e) => e.path).sort()).toEqual(['/tmp/gc-doc-a.md', '/tmp/gc-doc-c.md']);
    await applyGc(plan);
    expect(getActiveReview(docPath)).toBeNull();
    expect(getActiveReview('/tmp/gc-doc-c.md')).toBeNull();
    expect(getActiveReview('/tmp/gc-doc-b.md')).toBe(live);
  });

  it('re-checks before deleting: a review reopened after the plan was made stays', async () => {
    const id = await review({ status: 'closed', age: 60 });
    const plan = planGc({ days: 30 });
    const meta = getMeta(id);
    meta.status = 'in_review';
    meta.updatedAt = new Date().toISOString();
    writeJsonAtomic(paths.meta(id), meta);
    const done = await applyGc(plan);
    expect(done.reviews).toEqual([]);
    expect(exists(id)).toBe(true);
  });

  it('a review directory it cannot understand is never deleted', async () => {
    const id = 'doc-20200101-000000-abcd';
    fs.mkdirSync(paths.reviewDir(id), { recursive: true });
    fs.writeFileSync(paths.meta(id), '{broken');
    expect(planGc({ days: 0 }).reviews).toEqual([]);
  });
});

describe('rd gc: sessions', () => {
  it('removes ended sessions older than N days that no remaining review references', async () => {
    await review({ status: 'closed', age: 60, sessionId: 'old-and-done' });
    await review({ status: 'in_review', age: 1, sessionId: 'old-but-used' });
    await updateSession('old-and-done', { state: 'ended', endedAt: ago(50) });
    await updateSession('old-but-used', { state: 'ended', endedAt: ago(50) });
    await updateSession('old-unreferenced', { state: 'ended', endedAt: ago(40) });
    await updateSession('recently-ended', { state: 'ended', endedAt: ago(2) });
    await updateSession('still-live', { state: 'idle', pid: process.pid });
    await updateSession('live-but-old', { state: 'idle', pid: process.pid, startedAt: ago(100) });
    const plan = planGc({ days: 30 });
    expect(plan.sessions.map((s) => s.sessionId).sort()).toEqual(['old-and-done', 'old-unreferenced']);
    await applyGc(plan);
    expect(Object.keys(readSessions()).sort()).toEqual(['live-but-old', 'old-but-used', 'recently-ended', 'still-live']);
  });
});

describe('rd gc: writes.jsonl, logs, tmp', () => {
  it('keeps only the last N days of writes (torn lines go), atomically', async () => {
    writeLines([
      { path: '/a', sessionId: 's', at: ago(40) },
      { path: '/b', sessionId: 's', at: ago(31) },
      { path: '/c', sessionId: 's', at: ago(29) },
      { path: '/d', sessionId: 's', at: ago(1) },
    ]);
    fs.appendFileSync(paths.writes(), '{"path": "/torn", "at": \n');
    const plan = planGc({ days: 30 });
    expect(plan.writes).toMatchObject({ total: 5, drop: 3 });
    await applyGc(plan);
    const left = fs.readFileSync(paths.writes(), 'utf8').trim().split('\n').map((l) => JSON.parse(l).path);
    expect(left).toEqual(['/c', '/d']);
    expect(fs.readdirSync(home()).filter((n) => n.includes('.tmp'))).toEqual([]);
    expect(planGc({ days: 30 }).writes).toBeNull();
  });

  it('deletes old headless logs, keeps young ones and other files', async () => {
    fs.mkdirSync(paths.logs(), { recursive: true });
    const oldLog = path.join(paths.logs(), 'headless-doc-20260101-000000-abcd.log');
    const newLog = path.join(paths.logs(), 'headless-doc-20260102-000000-abcd.log');
    fs.writeFileSync(oldLog, 'x'.repeat(100));
    fs.writeFileSync(newLog, 'y');
    fs.writeFileSync(path.join(paths.logs(), 'other.txt'), 'z');
    const t = new Date(Date.now() - 50 * DAY);
    fs.utimesSync(oldLog, t, t);
    fs.utimesSync(path.join(paths.logs(), 'other.txt'), t, t);
    const plan = planGc({ days: 30 });
    expect(plan.logs.map((l) => l.name)).toEqual(['headless-doc-20260101-000000-abcd.log']);
    await applyGc(plan);
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(newLog)).toBe(true);
    expect(fs.existsSync(path.join(paths.logs(), 'other.txt'))).toBe(true);
  });

  it('cuts rd.log above 5 MB down to its last 1 MB, at a line boundary', async () => {
    fs.mkdirSync(paths.logs(), { recursive: true });
    const line = (i) => `2026-11-01T00:00:00.000Z [t] entry ${String(i).padStart(7, '0')} ${'x'.repeat(80)}\n`;
    let text = '';
    for (let i = 0; text.length < LOG_MAX_BYTES + 100_000; i++) text += line(i);
    fs.writeFileSync(paths.log(), text);
    const plan = planGc({ days: 30 });
    expect(plan.logs).toHaveLength(1);
    expect(plan.logs[0].kind).toBe('truncate');
    await applyGc(plan);
    const kept = fs.readFileSync(paths.log(), 'utf8');
    expect(kept.length).toBeLessThanOrEqual(LOG_KEEP_BYTES);
    expect(kept.length).toBeGreaterThan(LOG_KEEP_BYTES - 200);
    expect(kept.startsWith('2026-11-01T')).toBe(true); // starts on a whole line
    expect(kept.endsWith(text.slice(-100))).toBe(true);
    expect(planGc({ days: 30 }).logs).toEqual([]);
  });

  it('clears tmp/ leftovers older than an hour, not fresh files (an editor may be open)', async () => {
    fs.mkdirSync(paths.tmp(), { recursive: true });
    const stale = path.join(paths.tmp(), 'rd-edit-old.md');
    const fresh = path.join(paths.tmp(), 'rd-edit-new.md');
    fs.writeFileSync(stale, 'left behind');
    fs.writeFileSync(fresh, 'being edited');
    const t = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(stale, t, t);
    const plan = planGc({ days: 30 });
    expect(plan.tmp.map((x) => x.name)).toEqual(['rd-edit-old.md']);
    await applyGc(plan);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('rd gc: the command', () => {
  const lines = () => {
    const out = [];
    return { out, say: (s) => out.push(s) };
  };

  it('--dry-run lists the plan and changes nothing', async () => {
    const id = await review({ status: 'closed', age: 60, title: 'Old document' });
    writeLines([{ path: '/a', at: ago(60) }]);
    const before = fs.readFileSync(paths.writes(), 'utf8');
    const { out, say } = lines();
    const r = await gcCommand({ days: 30, dryRun: true }, { out: say, confirm: () => { throw new Error('must not ask'); } });
    expect(r.done).toBeNull();
    const text = out.join('\n');
    expect(text).toContain('--dry-run: nothing is deleted');
    expect(text).toContain(id);
    expect(text).toContain('Old document');
    expect(text).toMatch(/writes\.jsonl: 1 of 1/);
    expect(exists(id)).toBe(true);
    expect(fs.readFileSync(paths.writes(), 'utf8')).toBe(before);
  });

  it('asks first: declining deletes nothing, --yes does not ask', async () => {
    const id = await review({ status: 'closed', age: 60 });
    const asked = [];
    let r = await gcCommand({ days: 30 }, { out: () => {}, confirm: async (q) => (asked.push(q), false) });
    expect(asked).toEqual(['Delete these?']);
    expect(r.done).toBeNull();
    expect(exists(id)).toBe(true);
    r = await gcCommand({ days: 30, yes: true }, { out: () => {}, confirm: () => { throw new Error('must not ask'); } });
    expect(r.done.reviews).toEqual([id]);
    expect(exists(id)).toBe(false);
  });

  it('without a terminal and without --yes it refuses (nothing deleted)', async () => {
    const id = await review({ status: 'closed', age: 60 });
    const r = spawnSync(process.execPath, [BIN, 'gc', '--days', '30'], { env: { ...process.env, RD_HOME: home() }, encoding: 'utf8', input: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--yes/);
    expect(exists(id)).toBe(true);
    const ok = spawnSync(process.execPath, [BIN, 'gc', '--days', '30', '--yes'], { env: { ...process.env, RD_HOME: home() }, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Deleted 1 review/);
    expect(exists(id)).toBe(false);
  });

  it('rejects a bad --days; a second run finds nothing', async () => {
    await expect(gcCommand({ days: 'soon' }, { out: () => {} })).rejects.toThrow(/--days/);
    await expect(gcCommand({ days: '-3' }, { out: () => {} })).rejects.toThrow(/--days/);
    await review({ status: 'closed', age: 60 });
    await gcCommand({ days: 30, yes: true }, { out: () => {} });
    const { out, say } = lines();
    await gcCommand({ days: 30, yes: true }, { out: say });
    expect(out.join('\n')).toContain('Nothing to delete.');
  });

  it('an empty RD_HOME is fine', () => {
    expect(planGc({ days: 30 })).toMatchObject({ reviews: [], sessions: [], writes: null, logs: [], tmp: [], bytes: 0 });
    expect(formatPlan(planGc({ days: 30 }))).toContain('Nothing to delete.');
  });
});
