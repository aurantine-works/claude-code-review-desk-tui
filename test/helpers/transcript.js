// Builds transcript JSONL lines in the shape Claude Code 2.1.322 really writes
// (verified against ~/.claude/projects/*/*.jsonl): one line per content block,
// user tool_result records, and `api-request-blob` duplicates that must be ignored.
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const base = (sessionId) => ({
  isSidechain: false,
  sessionId,
  session_id: sessionId,
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/work/proj',
  version: '2.1.322',
  gitBranch: 'HEAD',
});

export function createTranscript(sessionId = 'sess-1') {
  const lines = [];
  let parent = null;
  const push = (rec) => {
    const r = { parentUuid: parent, ...base(sessionId), ...rec, uuid: uuid(), timestamp: new Date(1700000000000 + n * 1000).toISOString() };
    parent = r.uuid;
    lines.push(JSON.stringify(r));
    return r;
  };
  const msgId = () => `msg_${String(++n).padStart(6, '0')}`;
  const t = {
    lines,
    user(text) {
      push({ type: 'user', message: { role: 'user', content: text } });
      return t;
    },
    /** One assistant record per content block, like the real file. */
    assistantBlocks(blocks) {
      const id = msgId();
      for (const b of blocks) {
        push({
          type: 'assistant',
          message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [b], stop_reason: null },
        });
      }
      // The same content is also written as an api-request-blob record (no uuid/timestamp), to be ignored.
      lines.push(JSON.stringify({ type: 'api-request-blob', sessionId, hash: 'h' + n, message: { role: 'assistant', content: blocks } }));
      return t;
    },
    assistantText(text) {
      return t.assistantBlocks([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }]);
    },
    toolUse(name, input, id = `toolu_${n}`) {
      t.assistantBlocks([{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }]);
      return id;
    },
    /** tool_result user record. content may be a string or an array of text blocks. */
    toolResult(toolUseId, content, { isError = false } = {}) {
      push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content, tool_use_id: toolUseId, ...(isError ? { is_error: true } : {}) }] },
        toolUseResult: typeof content === 'string' ? `Error: ${content.slice(0, 40)}` : undefined,
      });
      lines.push(JSON.stringify({ type: 'api-request-blob', sessionId, message: { role: 'user', content: [{ type: 'tool_result', content, tool_use_id: toolUseId }] } }));
      return t;
    },
    /** attachment record, e.g. {type:'plan_mode_exit', planFilePath, planExists:true} or hook_permission_decision. */
    attachment(attachment) {
      push({ type: 'attachment', attachment });
      return t;
    },
    sidechainText(text) {
      push({ type: 'assistant', isSidechain: true, message: { id: msgId(), role: 'assistant', content: [{ type: 'text', text }] } });
      return t;
    },
    raw(line) {
      lines.push(line);
      return t;
    },
    write(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.join('\n') + '\n');
      return file;
    },
    append(file) {
      fs.appendFileSync(file, lines.join('\n') + '\n');
      lines.length = 0;
      return file;
    },
  };
  return t;
}
