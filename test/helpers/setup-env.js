// Vitest setup: the suite must behave the same whether it is started from an interactive Claude Code session or from a
// headless one (`claude -p`, which exports these two markers; rd's hooks switch to their non-interactive behaviour on them).
// Tests that need the headless behaviour pass an explicit `env` to the hook, or set the variables themselves.
delete process.env.CLAUDE_CODE_SESSION_ATTENDED;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
// The UI language of the suite is English, whatever `ui.lang` a local config.json or the shell's RD_LANG says. Vitest runs this file in
// the same isolated module graph as each test file, before it, so the language memo of src/i18n is still empty and picks this up.
process.env.RD_LANG = 'en';
