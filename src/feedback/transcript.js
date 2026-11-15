// Read-only access to Claude Code transcripts (~/.claude/projects/<dir>/<session>.jsonl)
// to recover the answers Claude wrote after a plan deny message.
//
// Observed format (Claude Code 2.1.322), one JSON object per line:
//   - Every content block of an assistant message is its own line:
//       {"type":"assistant","isSidechain":false,"message":{"id":"msg_…","role":"assistant",
//        "content":[{"type":"text","text":"…"}]}, "uuid", "parentUuid", "timestamp", "sessionId", …}
//     A message with thinking + text + tool_use is written as three lines sharing message.id.
//   - Tool results are user records:
//       {"type":"user","message":{"role":"user","content":[{"type":"tool_result",
//        "tool_use_id":"toolu_…","content":"<string>" | [{"type":"text","text":"…"}],"is_error":true}]}}
//     A typed prompt has `message.content` as a plain string.
//   - Besides the conversation there are bookkeeping records (permission-mode, attachment,
//     last-prompt, ai-title, file-history-snapshot, …) and `api-request-blob` records that
//     DUPLICATE assistant/user content ({"type":"api-request-blob","message":{"role":"assistant",…}}).
//     The blobs must be ignored, otherwise text is counted twice and out of order.
//   - Sidechain (subagent) turns carry "isSidechain": true.
//
// The file may lag the live turn (the hook can fire before the last record is flushed),
// so assistantTextSince() retries for a short while.
import fs from 'node:fs';

const CONVERSATION_NOISE = new Set(['assistant', 'api-request-blob', 'api-request', 'api-request-shape']);

const tryParse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null; // torn line at the end of a file that is still being written
  }
};

/**
 * Does this non-assistant record contain `marker`? The deny message normally arrives as
 * a tool_result in a user record; hook feedback could also surface as a plain text
 * block, a string content, or an attachment, so every record kind except assistant
 * output and API blobs is accepted.
 */
const isMarkerRecord = (rec, marker, line) =>
  !!rec && typeof rec.type === 'string' && !CONVERSATION_NOISE.has(rec.type) && line.includes(marker);

/** Text of the assistant `text` blocks in one transcript record ('' for anything else). */
function assistantText(rec) {
  if (!rec || rec.type !== 'assistant' || rec.isSidechain) return '';
  const content = rec.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Pure scan of transcript text: assistant text written after the LAST record that
 * contains `marker`. Returns { found, text }.
 */
export function scanTranscript(raw, marker) {
  const lines = raw.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(marker)) continue; // cheap pre-filter before parsing
    if (isMarkerRecord(tryParse(lines[i]), marker, lines[i])) {
      at = i;
      break;
    }
  }
  if (at === -1) return { found: false, text: '' };
  const parts = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (!lines[i].includes('"assistant"')) continue;
    const t = assistantText(tryParse(lines[i]));
    if (t) parts.push(t);
  }
  return { found: true, text: parts.join('\n\n') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * All assistant text after the last occurrence of `marker`
 * (`Review Desk (review <id>, round <n>)`, which the plan deny message contains).
 * Returns '' when the transcript or marker cannot be found.
 *
 * Retries until `ready({found, text})` or `timeoutMs` (default 2s:
 * transcript_path may lag the current turn). The default `ready` accepts any
 * non-empty text; plan recovery passes a stricter check for `</rd-reply>`.
 */
export async function assistantTextSince(transcriptPath, marker, opts = {}) {
  const { timeoutMs = 2000, intervalMs = 100, ready = (r) => r.found && r.text.trim().length > 0 } = opts;
  if (!transcriptPath || !marker) return '';
  const deadline = Date.now() + timeoutMs;
  let last = { found: false, text: '' };
  for (;;) {
    try {
      last = scanTranscript(fs.readFileSync(transcriptPath, 'utf8'), marker);
    } catch {
      /* missing/unreadable yet: keep retrying until the deadline */
    }
    if (ready(last) || Date.now() >= deadline) return last.text;
    await sleep(intervalMs);
  }
}

/** The marker embedded in the plan deny message (see renderPlanDeny). */
export const denyMarker = (reviewId, round) => `Review Desk (review ${reviewId}, round ${round})`;

// ---------------------------------------------------------------------------------------------
// ExitPlanMode tracking: which plan is being reviewed, and was its native dialog answered?
//
// Real records (Claude Code 2.1.322):
//   tool_use     {"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_…","name":"ExitPlanMode","input":{"plan":"…"}}]}}
//   approved     {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_…","content":"User has approved your plan. …"}]}}
//   rejected     same, with "is_error":true and content "The user doesn't want to proceed with this tool use. …"
//   hook deny    same, "is_error":true, content = the hook's message verbatim (preceded by an
//                {"type":"attachment","attachment":{"type":"hook_permission_decision",…}} record)
//   mode exit    {"type":"attachment","attachment":{"type":"plan_mode_exit","planFilePath":"…","planExists":true}}
// The hook input itself carries no tool_use_id, and `tool_input` is {} when Claude never wrote a plan
// file (the plan is then only in the tool_use above), so the transcript is the source of truth.
// ---------------------------------------------------------------------------------------------

const blocksOf = (rec) => (Array.isArray(rec?.message?.content) ? rec.message.content : []);

/** The last ExitPlanMode tool_use block of an assistant record, or undefined. */
const exitPlanBlock = (rec) =>
  rec && rec.type === 'assistant' && !rec.isSidechain
    ? blocksOf(rec).findLast((b) => b && b.type === 'tool_use' && b.name === 'ExitPlanMode')
    : undefined;

const resultBlock = (rec, id) =>
  rec && rec.type === 'user' ? blocksOf(rec).find((b) => b && b.type === 'tool_result' && b.tool_use_id === id) : undefined;

/**
 * The newest ExitPlanMode tool_use in transcript text, and whether it already has a tool_result.
 * @returns {null | {id: string, plan: string|null, resolved: boolean, error: boolean}}
 */
export function scanLastExitPlan(raw) {
  const lines = raw.split('\n');
  let at = -1;
  let block;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('ExitPlanMode') || !lines[i].includes('"tool_use"')) continue;
    block = exitPlanBlock(tryParse(lines[i]));
    if (block) {
      at = i;
      break;
    }
  }
  if (!block) return null;
  let result;
  for (let j = at + 1; j < lines.length && !result; j++) {
    if (lines[j].includes(block.id) && lines[j].includes('"tool_result"')) result = resultBlock(tryParse(lines[j]), block.id);
  }
  return {
    id: block.id,
    plan: typeof block.input?.plan === 'string' ? block.input.plan : null,
    resolved: !!result,
    error: !!result?.is_error,
  };
}

/** Whole transcript plus the byte offset just after its last complete line, or null if unreadable. */
export function snapshotTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const buf = fs.readFileSync(transcriptPath);
    const offset = buf.lastIndexOf(0x0a) + 1; // a torn last line is re-read by the tail later
    return { raw: buf.toString('utf8', 0, offset), offset };
  } catch {
    return null;
  }
}

/**
 * Find the ExitPlanMode tool_use that is waiting for a decision right now: the newest one without a
 * tool_result. The transcript may lag the hook, so with `timeoutMs` > 0 the file is
 * re-read until such a tool_use shows up (a resolved newest one is an earlier round, not ours).
 * @returns {Promise<{pending: object|null, offset: number|null}>} offset: where tailing should resume
 */
export async function findPendingExitPlan(transcriptPath, { timeoutMs = 0, intervalMs = 100, needPlan = false } = {}) {
  if (!transcriptPath) return { pending: null, offset: null };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = snapshotTranscript(transcriptPath);
    const last = snap ? scanLastExitPlan(snap.raw) : null;
    const pending = last && !last.resolved && (!needPlan || last.plan) ? last : null;
    if (pending || Date.now() >= deadline) return { pending, offset: snap ? snap.offset : null };
    await sleep(intervalMs);
  }
}

/** Reads only what was appended to a JSONL file since `offset` (cheap enough to call every second). */
export class TranscriptTail {
  constructor(transcriptPath, offset) {
    this.path = transcriptPath;
    this.offset = offset;
  }

  /** New complete records since the last call. Never throws. */
  poll() {
    if (!this.path || this.offset == null) return [];
    let fd;
    try {
      const size = fs.statSync(this.path).size;
      if (size < this.offset) {
        this.offset = size; // file was rewritten: never replay its history as new events
        return [];
      }
      if (size === this.offset) return [];
      fd = fs.openSync(this.path, 'r');
      const buf = Buffer.alloc(size - this.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
      const end = buf.subarray(0, n).lastIndexOf(0x0a) + 1;
      this.offset += end;
      return buf
        .toString('utf8', 0, end)
        .split('\n')
        .filter(Boolean)
        .map(tryParse)
        .filter(Boolean);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

/**
 * Detects that a pending ExitPlanMode dialog was answered by someone else (the user in Claude Code's
 * own dialog) by tailing the transcript from `offset`:
 *  - a tool_result for the watched tool_use: is_error -> 'rejected', otherwise 'approved';
 *  - a plan_mode_exit attachment -> 'approved' (plan mode was left);
 * A newer ExitPlanMode tool_use appearing in the tail becomes the watched one (newest wins), which
 * also covers a hook that started before its own tool_use reached the file.
 */
export class ExitPlanWatcher {
  constructor(transcriptPath, { offset, targetId = null }) {
    this.tail = new TranscriptTail(transcriptPath, offset);
    this.targetId = targetId;
  }

  /** @returns {null | {kind: 'approved'|'rejected', via: 'tool_result'|'plan_mode_exit', toolUseId: string|null}} */
  check() {
    for (const rec of this.tail.poll()) {
      const use = exitPlanBlock(rec);
      if (use) this.targetId = use.id;
      if (this.targetId) {
        const res = resultBlock(rec, this.targetId);
        if (res) return { kind: res.is_error ? 'rejected' : 'approved', via: 'tool_result', toolUseId: this.targetId };
      }
      if (rec.type === 'attachment' && rec.attachment?.type === 'plan_mode_exit') {
        return { kind: 'approved', via: 'plan_mode_exit', toolUseId: this.targetId };
      }
    }
    return null;
  }
}
