// Dependency-free constants and predicates shared by `rd await`, the hooks and the instruction texts (which must stay light).

/** First line of everything `rd await` prints: the prompt-submit hook recognises rd's task output by it. */
export const AWAIT_MARKER = '# rd-await v1';

/**
 * Is this process part of a headless Claude Code run (`claude -p`, also `claude --resume <id> -p`)? Verified on 2.1.322:
 * hooks and the Bash tool of such a run get CLAUDE_CODE_SESSION_ATTENDED=0 and
 * CLAUDE_CODE_ENTRYPOINT=sdk-cli (interactive: 1 / cli). Nobody can answer questions or be woken up in such a run.
 */
export const isHeadlessEnv = (env = process.env) => env.CLAUDE_CODE_SESSION_ATTENDED === '0' || env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli';
