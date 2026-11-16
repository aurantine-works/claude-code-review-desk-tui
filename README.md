# Claude Code Review Desk (TUI)

**Claude Code Review Desk** is a terminal-only review desk, started with the command `rd`. The npm package is `@aurantine-works/claude-code-review-desk-tui`. Over SSH, add margin comments to the **plans** and **documents** that Claude Code produces; the very **session that wrote the content** answers each comment and edits the text if needed.

- Everything works with the keyboard and with the mouse. All features fit in an 80x24 terminal, and wrapping, the cursor and the input box are computed from display width (so CJK text works).
- Comments are anchored to the original text (line, character range, quoted text) and are re-anchored automatically when the text changes.
- All state lives on disk in `~/.review-desk/`: dropped connections, closing the desk or restarting Claude Code never lose a comment.
- **Instant Q&A** by default: write a comment, send it, and Claude answers within seconds without you going back to Claude's terminal. An idle Claude is **woken up automatically**, so you type nothing in Claude. You can also switch to batch submission.
- No browser, port forwarding, tmux or session tool required (tmux / ccd are only used as an optional fallback for auto-injection).

## Verified versions

**Verified Claude Code version: `2.1.325`** (`claude --version`). The hook input and output formats were checked against the official documentation, and the following were exercised on real Claude Code: plan review, document review, instant Q&A and offline recovery (2.1.322), and **automatic wake-up** (2.1.325): an idle session receives a comment within 0.3-0.7 seconds and starts answering without anything being typed, also after several comments in a row, `/clear`, `/exit` and `--resume`. Other versions will most likely work, but `rd doctor` warns when the version differs. Automatic wake-up depends on the hook option `asyncRewake`; earlier versions have not been verified.

## Preview

The inbox, `rd` (80 columns):

```
 Review Desk · inbox                                        3 open · 1 answered
────────────────────────────────────────────────────────────────────────────────
 ● plan proj-x     Plan: refactor the devi…  awaiting_review · hook …   <1m ago
 ● doc  proj-x     Weekly report · Week 45   awaiting_review             <1m ago
 ○ doc  proj-x     Weekly report · Week 45   feedback_pending (1/2)      <1m ago
────────────────────────────────────────────────────────────────────────────────
 ↑↓/jk select · Enter open · a show all · x close review · ? help · q quit
```

The review screen on a wide terminal (110 columns or more): text and comments side by side:

```
 Weekly report · Week 45 · rev 1/1 · After you send: with your next message                            [d] diff
───────────────────────────────────────────────────────────────────┬────────────────────────────────────────────
 3 │ ## Summary                                                    │
 4 │                                                               │
 5 │ This week the device table refactor was completed, mostly the │
   │ store migration and the slice split. Overall progress is on   │
   │ track, but two risks need attention.                          │
 6 │                                                               │
 7 │ ## Risks                                                      │
 8 │                                                               │ ▌t1 · L9 · answered
 9▌│ Migrating the old store is low risk because it only affects   │   you: What makes the risk low?
  ▌│ the device and policy slices.                                 │   Claude: Both slices are only used by the
10 │ The rollback plan relies on a feature flag; see               │            device table component; there
   │ `store.migrate()` for details.                                │           are no cross-slice dependencies.
───────────────────────────────────────────────────────────────────┴────────────────────────────────────────────
 NORMAL  Type /review-reply in Claude to start instant Q&A                                instant · src · L9/27
```

On a narrow terminal (under 110 columns, for example a phone SSH client or an 80x24 window) the comment pane becomes a drawer at the bottom that shows the threads of the cursor line, and the input box floats at the bottom of the screen:

```
 Weekly report · Week 45 · rev 1/1                                     [d] diff
────────────────────────────────────────────────────────────────────────────────
 3 │ ## Summary
 4 │
 5 │ This week the device table refactor was completed, mostly the store
   │ migration and the slice split. Overall progress is on track, but two risks
   │ need attention.
 6 │
 7 │ ## Risks
 8 │
 9▌│ Migrating the old store is low risk because it only affects the device and
  ▌│ policy slices.
10 │ The rollback plan relies on a feature flag; see `store.migrate()` for
   │ details.
11 │
12 │ - Risk 1: the old data format is incompatible
── Comments (2) ────────────────────────────────────────────────────────────────
 no comment on the cursor line · c comment · ]c jump to the next thread
╭──────────────────────────────────────────────────────────────────────────────╮
│ Comment L9-10                                                                │
│ Which slices exactly, and who owns them?                                     │
│ Enter send · Alt+Enter newline                               send    cancel  │
╰──────────────────────────────────────────────────────────────────────────────╯
 INPUT  Enter send · Alt+Enter newline · Esc cancel      instant · src · L10/27
```

## Requirements

- Node.js **22 or newer** (required by Ink 8).
- A Linux host (process discovery reads `/proc`) running the Claude Code CLI in a terminal.
- A terminal of at least 40x10; 80x24 or larger is recommended. A terminal with SGR mouse and bracketed paste support gives the best experience (everything can also be done with the keyboard alone).

## Installation

Install the package from npm (Node.js 22 or newer is required):

```bash
npm install -g @aurantine-works/claude-code-review-desk-tui
rd --help
```

This puts the `rd` command on your PATH (`claude-code-review-desk-tui` is an alias of the same command). Then hook it into Claude Code with `rd install`, as described below.

**From source** (for contributors):

```bash
git clone https://github.com/aurantine-works/claude-code-review-desk-tui.git
cd claude-code-review-desk-tui
npm install
npm link            # afterwards `rd` is on your PATH
```

Hook it into Claude Code. Look at what `--dry-run` would change first, then write for real (a backup is made and you are asked to confirm):

```bash
rd install --dry-run     # print the merged settings.json, write nothing
rd install               # merge and write; the original is backed up as settings.json.rd-backup-<timestamp>
rd doctor                # check that it took effect
```

`rd install` writes the following into the Claude Code configuration directory (`$CLAUDE_CONFIG_DIR`, default `~/.claude`):

| Where | What |
| --- | --- |
| `hooks` in `settings.json` | 6 hooks: `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PostToolUse` (`Write\|Edit\|MultiEdit`) and `PermissionRequest` (`ExitPlanMode`, `timeout: 86400`), all of the form `rd hook <event>`; plus two `rd hook watch` entries for automatic wake-up (one on `SessionStart`, one on `Stop`, with `asyncRewake: true`, `timeout: 604800` and the two texts `rewakeMessage` / `rewakeSummary`) |
| `permissions.allow` in `settings.json` | `Bash(rd show:*)`, `Bash(rd reply:*)`, `Bash(rd done:*)`, `Bash(rd await:*)` (Claude needs them to answer comments; no confirmation prompt, even in plan mode) |
| `statusLine` in `settings.json` | `rd statusline` (refreshed every 2 seconds), **written only if you have no status line yet**; an existing one is left alone, see below |
| `commands/review-reply.md` | the `/review-reply` command (only an older version carrying the rd marker is overwritten; someone else's file of the same name is never touched) |

### Status line

If you already have a status line script, append the output of `rd statusline` to it, for example:

```bash
#!/bin/sh
echo "$(your-existing-status) $(rd statusline)"
```

**Installing for a single project only**: point `--config-dir` at the project's `.claude` (project-level `settings.json` and `commands/`):

```bash
cd my-project
rd install --config-dir ./.claude --dry-run
rd install --config-dir ./.claude
```

Do not install at both the user level and the project level: every hook would run twice (`rd doctor` warns about this).

**Upgrading from an older version**: run `rd install` again. It adds the two `rd hook watch` entries and repairs rd hooks that lack `asyncRewake` / `timeout` (other people's hooks are left alone). Without those two entries `rd doctor` reports `!` and reminds you that, while a session is idle, comments need `/review-reply` typed in Claude. A running Claude Code must be restarted (or `/clear`ed) before it reads the new hooks.

During development the hooks can point at the source tree: `rd install --hook-prefix "node /abs/path/to/review-desk/bin/rd.js"` (`rd` must still be on your PATH, because commands such as `rd reply` that Claude runs use that name).

## Everyday use

### Keep a review desk open

Keep it open in **another terminal tab**:

```bash
rd            # = rd inbox --watch
```

When a new plan appears it opens by itself and rings the bell; after you submit or approve you are back in the inbox, waiting for the next one. A screen opened on its own with `rd open <id>` exits with `q`.

### Reviewing a plan

1. Claude Code submits a plan in plan mode (`ExitPlanMode`). The `PermissionRequest` hook of `rd` registers the plan and **keeps waiting** for your decision. Claude Code's own confirmation prompt is shown in Claude's terminal at the same time; answering there works too (rd then shows the plan as approved).
2. `rd` (in watch mode) opens the plan automatically. Select text with `v` / `V` and write a comment with `c`. Plans are sent instantly by default: after you press Enter the hook hands the comments to Claude at once as the message of a deny.
3. Claude answers each comment with `rd reply` (the answer is written into the matching thread) and, where changes are needed, submits a revised plan. Afterwards it can enter the instant Q&A loop (see below) so you can keep asking without resubmitting.
4. When you are satisfied, press `A` to approve; the hook returns allow and Claude starts executing. If Claude is parked in instant Q&A at that moment, the approval notifies it to let the plan through.

### Reviewing a document

- A file that Claude writes with Write / Edit and whose path matches `docs.include` (by default `**/docs/**/*.md`, `**/reports/**/*.md`, `**/*.report.md`, `**/*-plan.md`, `**/*.design.md`, excluding `node_modules`, `.git`, `README.md` and `CHANGELOG.md`) is **registered automatically** for review. The Claude Code status line shows `rd: 2 doc to review`, and the watching inbox sorts it to the top. With `docs.autoOpen: true` it opens by itself like a plan.
- Several writes to the same file within one turn are merged into one revision. When Claude changes the document a new revision is created and old comments are re-anchored automatically (those that cannot be found go into a "lost anchor" group).
- Any path can be registered by hand: `rd add <path>` or simply `rd open <path>`. rd looks in `writes.jsonl` first (every Write/Edit is recorded there), and if the path is not there it scans `~/.claude/projects/*/*.jsonl` for sessions that mentioned it. With several candidates it asks you to choose in the terminal (non-interactively it lists them and exits with code 2; pick one with `--session <id>`).

### Writing comments

`c` opens an input box on the cursor line (or on the range selected with `v` / `V`). Enter sends, `Alt+Enter` or `Ctrl+J` inserts a newline, `Esc` cancels (with content it asks first), and a pasted multi-line text does not trigger sending. Input is handled per grapheme, and a whole string committed at once by an input method counts as a single input.

**Long comments in `$EDITOR`**: press `C` in Visual mode (or on the cursor line when nothing is selected), `R` on a thread, or `Ctrl+E` in the input box.

- The editor is taken from `editor` in `config.json`, then `$VISUAL`, `$EDITOR`, `vi`. A command with arguments (`code -w`) is split on whitespace and started directly, without a shell.
- The temporary file lives in `~/.review-desk/tmp/` (mode 600, deleted afterwards). A few `# ` comment lines at the top show the first lines of the quoted text and explain what saving does; they are not sent.
- `C` / `R`: save and quit = the same as pressing Enter in the input box (sends in instant mode, saves a draft in batch mode); emptying the content or making no change = cancel. `Ctrl+E`: save and quit = back to the input box to keep editing.
- While the editor runs, the mouse and bracketed paste are suspended; they come back and the screen is redrawn afterwards. If the editor exits non-zero or cannot be started at all, you get a notice and the text in the input box is not lost.

### Instant Q&A

Documents and plans work the same way: you send a comment in the review desk, Claude receives it within seconds and answers, and the answer is written back to the thread.

**Automatic wake-up (the default; installing the hooks is enough)**: at session start and at the end of every turn, Claude Code itself starts a tiny `rd hook watch` in the background (one per session). It checks once a second for new comments; when there is one, it hands the comment together with the answering steps to Claude and **wakes the session up, even if Claude is idle**; if Claude is busy, it receives them between two tool calls. You do nothing in Claude and need no tmux. The text Claude receives begins by saying "this is not an error, it is a comment the user sent from Review Desk". The header shows `After you send: delivered to Claude automatically`, and one line `Review Desk: new review feedback` appears in the Claude Code terminal. If a plan is approved while no hook is waiting, the watcher also tells Claude to call ExitPlanMode once more to let it through (once per approval; this path has only been verified by tests, not separately on real Claude Code). Waiting costs no tokens.

Without a watcher (an old Claude Code, or hooks that were not reinstalled) rd falls back to the older approach, where the first time Claude has to be put into an `rd await` loop:

- Claude is busy: the Stop hook injects instructions when the turn ends, and after working through the backlog Claude enters the loop by itself.
- Claude is idle and runs in tmux / ccd: rd types `/review-reply <id>` for you (see "Delivery channels").
- Anything else: the header says so once; **type `/review-reply` in Claude**, after which every comment is delivered instantly and you do not need to go back.

`E` ends the instant Q&A of this session: it only ends the `rd await` that Claude started (it prints `end` and exits; sending another comment starts it again). Automatic wake-up is unaffected, and comments sent afterwards are delivered as usual.

### Batch mode

`B` toggles between instant and batch (the default is `review.sendMode`). In batch mode Enter only saves a draft and `s` submits everything at once; `D` deletes the unsubmitted draft in the thread under the cursor. Submitted comments are delivered by automatic wake-up just like instantly sent ones.

### Replying, resolving, approving

`r` replies in the current thread, `x` resolves or reopens it, `A` approves (plan: allow; document: close the review and send Claude nothing more; both ask for confirmation), and `q` goes back without changing any state. `rd close <id>` closes a review without approving it.

### Revision diff

`d` switches to a line diff from the previous revision to the current one (additions green, deletions red, read-only). `<` / `>` change the base revision, `]c` / `[c` jump to the next / previous change, and `Enter` returns to the text at the matching line. Use it to see what Claude changed in response to your comments.

### Files changed outside Claude

When an open document is modified by another program (after it has been stable for 3 seconds) the header says so. `U` creates a `manual` revision from the current file content and the comments are re-anchored automatically. If the file is deleted only the snapshot is shown, and the review can still be closed.

### Offline recovery

Comments submitted after Claude Code has exited (or the process has died) stay in the queue, and the review screen opens a "session ended" window with three choices:

- `c` shows the resume command `cd <directory> && claude --resume <session>` (and also tries to copy it to the clipboard with OSC 52); run it in your own terminal.
- `h` resumes headless in the background: `claude --resume <session> -p "/review-reply <id>"`. The output is appended to `~/.review-desk/logs/headless-<id>.log` and the answer is written back to the review desk. It is a one-shot start: the session answers and exits, so adding more comments means resuming again and spending more tokens; for a back-and-forth, use `c`.
- `l` / `Esc` leave it for later. The comments are delivered with the next message once the session is resumed (a resumed session starts a watcher again, so the comments then arrive automatically).

`O` reopens this window; the command-line equivalent is `rd resume <id> [--headless]`. Without a watcher, rd types `/review-reply` automatically after the resume (when tmux / ccd is available).

**Automatic background resume**: if you do not want to be asked every time, set `"delivery": {"autoResume": "headless"}` in `config.json`. When you send a comment to an ended session, rd then starts the background resume of `h` directly and shows a notice (`session ended · resumed in the background automatically (pid ...)`) instead of the window. At most one background resume runs per session at a time; only when starting fails is the window opened, with the reason. The default `"ask"` keeps the window described above.

### A document written by several sessions

By default the document is bound to the session that wrote it last. `S` rebinds it to another session that has written it (not possible while Claude is answering).

## Key reference

The tables below are the same data as the help you get by pressing `?` in the review screen (they are generated by `test/helpers/readmeKeys.mjs` and `test/readme.test.js` compares them). While the input box is open the keyboard belongs to it, but the mouse wheel still scrolls the text and the comment pane. Mouse: the wheel scrolls, a click moves the cursor, a click on a comment card focuses it and jumps to its anchor, and the buttons in the footer and in the input box are clickable. **Drag selection is not supported** (use `v` on the keyboard for character-level selection). `m` turns the mouse off so you can copy with your terminal's own selection.

<!-- keys:start (generated by test/helpers/readmeKeys.mjs from the ? help; do not edit by hand) -->

#### Review screen

**Move**

| Key | Action |
| --- | --- |
| `j / k  ↓ / ↑` | next / previous line (keeps the column) |
| `h / l  ← / →` | one character left / right |
| `w / b / e` | next word start / previous word start / word end (CJK text is split into words) |
| `0 / ^ / $` | line start / first non-blank character / line end |
| `Ctrl-d / Ctrl-u` | half page down / up |
| `g / G` | jump to start / end |
| `]c / [c` | next / previous thread |
| `Tab` | switch focus between the threads on the cursor line |

**Comments**

| Key | Action |
| --- | --- |
| `v` | character selection: h/l/w/b/e/j/k extend (may span lines), c comment, Esc cancel |
| `V` | line selection (v / V switch between them, the same key again leaves) |
| `c / C` | comment: c inline box, C in $EDITOR (save and quit sends / saves the draft; empty or unchanged = cancel); without a selection the cursor line is commented |
| `r / R` | reply in the current thread: r inline box, R in $EDITOR (same rules as C) |
| `x` | resolve / reopen |
| `D` | delete an unsubmitted draft |
| `s` | batch mode: submit all drafts of this round |
| `B` | toggle instant / batch send mode |
| `A` | approve (plan: allow; doc: close), asks for confirmation |
| `E` | end this session's instant Q&A (all its reviews; Claude's rd await exits; sending again reopens it; automatic wake-up / delivery are unaffected) |

**Versions / session**

| Key | Action |
| --- | --- |
| `d` | diff view: source changes from the previous revision to the current one (read-only); d / q / Esc go back |
| `< / >  (in diff)` | change the base: older / newer revision |
| `]c / [c  (in diff)` | next / previous change |
| `Enter  (in diff)` | back to the text, cursor on the matching new line |
| `O` | session ended with feedback queued: open the resume dialog (c shows the command, h resumes in the background, l leaves it queued) |
| `U` | file modified outside (the header says so): make a new revision from the current file (asks for confirmation) |
| `S` | rebind the document to another session that wrote it (only while Claude is not answering) |

**Other**

| Key | Action |
| --- | --- |
| `m` | toggle the mouse (off: copy with the terminal’s own selection) |
| `M` | Markdown body: rendered / source view (md / src; comment anchors always refer to the source) |
| `Ctrl-e / Ctrl-y` | scroll the comment pane |
| `q / Ctrl-c` | back to Inbox / quit |
| `?` | help |

**Mouse**

| Key | Action |
| --- | --- |
| `Wheel` | scrolls the text / comment pane 3 lines each (also while the input box is open) |
| `Click` | move the cursor; click a comment card to focus it and jump to its anchor; click an overlapping highlight for a menu |
| `Input box` | Enter sends, Alt+Enter or Ctrl+J inserts a newline, Esc / Ctrl-c cancels, Ctrl+E edits in $EDITOR (back to the box after saving) |

#### Inbox

**List**

| Key | Action |
| --- | --- |
| `j / k  ↓ / ↑` | select |
| `Enter / click` | open |
| `a` | show / hide approved and closed |
| `x` | close the selected review (asks for confirmation) |
| `q / Ctrl-c` | quit |

<!-- keys:end -->

## Command line

| Command | Description |
| --- | --- |
| `rd` / `rd inbox [--watch]` | Open the inbox; plain `rd` is watch mode |
| `rd open <reviewId\|path> [--session <id>] [--json]` | Open the review screen; for a file path, look for an existing review first, otherwise find the session that wrote the file and register it |
| `rd add <path> [--session <id>] [--json]` | Register a document at any path for review |
| `rd list [--status <s>] [--json]` | List reviews non-interactively, for scripts |
| `rd close <reviewId>` | Close a review (without approving it) |
| `rd resume <reviewId> [--headless] [--json]` | Channel C: print the resume command, or resume the session in the background to answer |
| `rd install [--dry-run] [-y] [--hook-prefix <cmd>] [--config-dir <dir>]` | Merge hooks, permissions, status line and `/review-reply` into the Claude Code settings |
| `rd uninstall [--dry-run] [-y] [--config-dir <dir>]` | Undo what `rd install` wrote |
| `rd doctor [--json] [--fix] [--config-dir <dir>]` | Check the installation and runtime state; exit code 1 when something is marked ✗ |
| `rd gc [--days 30] [--dry-run] [-y]` | Clean up old reviews, sessions, write records and logs |
| `rd statusline` | One-line summary of pending reviews, for the Claude Code status line |
| `rd show [reviewId] [--pending [--all]] [--format prompt\|json]` | **For Claude**: print the comments waiting for an answer (`--pending` takes everything pending for the current session / project) |
| `rd reply <reviewId> <threadId> [text]` | **For Claude**: write an answer; without text it is read from stdin (heredoc) |
| `rd done <reviewId>` | **For Claude**: mark this round as answered |
| `rd await [--review <id>]` | **For Claude**: wait for the next comment as a background task (instant Q&A) |
| `rd deliver <reviewId> [--when-idle]` / `rd hook <event>` | Internal commands (delivery engine, hook entry point) |

## Configuration

`~/.review-desk/config.json` (`RD_HOME` selects another directory). Write only the keys you want to change; everything else uses the default:

| Key | Default | Description |
| --- | --- | --- |
| `docs.include` | `["**/docs/**/*.md","**/reports/**/*.md","**/*.report.md","**/*-plan.md","**/*.design.md"]` | Globs of documents registered automatically (minimatch, dotfiles included) |
| `docs.exclude` | `["**/node_modules/**","**/.git/**","**/README.md","**/CHANGELOG.md"]` | Globs that are excluded |
| `docs.autoOpen` | `false` | When true, watch mode opens a newly registered document by itself, like a plan |
| `review.sendMode` | `"instant"` | Default send mode, `"instant"` or `"batch"` (`B` toggles it at any time) |
| `review.idleEndMinutes` | `null` | Reserved: end instant Q&A automatically after this many idle minutes; `null` never ends it |
| `delivery.autoInject` | `true` | When tmux / ccd is detected and **there is no watcher**, type `/review-reply <id>` into an idle session; `false` always delivers with the next message. It never types while a watcher is running |
| `delivery.injectIdleSeconds` | `2` | The session must have been idle at least this long before injecting |
| `delivery.injectWaitSeconds` | `30` | How long to wait at most for the session to become idle; after that, fall back to channel A / B |
| `delivery.claudeBin` | `"claude"` | Executable started by channel C (a path or a name on PATH, no arguments) |
| `delivery.autoResume` | `"ask"` | When you send a comment to an ended session: `"ask"` opens the "session ended" window; `"headless"` starts the background resume automatically (`h` in the window) and shows a notice instead of the window. Other values are treated as `"ask"`, and `rd doctor` points them out |
| `anchor.threshold` | `0.5` | Threshold of the fuzzy anchor matching |
| `ui.mouse` | `true` | Whether the mouse is on at startup (`m` toggles it at any time) |
| `ui.markdown` | `"rendered"` | How Markdown text starts out: `"rendered"` (half-rendered) or `"source"`; `M` toggles it, and comment anchors always refer to the source |
| `ui.lang` | `"en"` | Interface language: `"en"`, or the name of an installed language pack (`src/i18n/<lang>.js`); the environment variable `RD_LANG` takes precedence |
| `notify.bell` | `true` | Ring the bell in Claude's terminal when a plan starts waiting |
| `editor` | `null` | External editor command; with `null`, `$VISUAL`, `$EDITOR`, then `vi` are tried in that order |

## Delivery channels

How a comment gets back to the original session depends on the state the session is in; the header always says "which one is used after you send":

| Channel | When | How |
| --- | --- | --- |
| Automatic wake-up | The session has a running watcher (`rd hook watch`), idle or busy | The watcher picks the comment up within 1 second and hands it to Claude Code with exit code 2 and stderr; an idle session wakes up immediately (a busy one receives it between two tool calls). It also delivers the notice when a plan is approved and no hook is waiting. Header: `After you send: delivered to Claude automatically`; no `/review-reply` is typed and nothing is injected |
| Plan deny | The plan's hook is waiting for you | The comments enter Claude's context directly as the deny message of the `PermissionRequest` |
| `rd await` | Claude is already in instant Q&A | A background task prints the new comment and exits, and its completion notification wakes Claude (with a watcher, Claude is no longer asked to start it; while it runs it delivers and the watcher steps aside) |
| A: with the next message | No watcher; the session is idle and there is no injection adapter | When you type `/review-reply` (or any message) in Claude, the `UserPromptSubmit` hook attaches the comments |
| B: Stop hook | No watcher; the session is busy | When the turn ends, the `Stop` hook injects instructions and Claude carries on |
| Auto-injection | No watcher; the session is idle and runs in tmux or ccd | rd types the fixed text `/review-reply <reviewId>` (never the comment text); the session must have been idle long enough and the target pane must belong to this session |
| C: resume the session | The session has ended | See "Offline recovery" |

The automatic wake-up row comes first because, as soon as a watcher exists, the other channels are only fallbacks: they all take comments through `takeUnreceived`, so each comment is sent by exactly one channel. `rd doctor` tells you which adapters are available in the current environment. tmux pane numbers are only unique within one tmux server, so rd records the socket as well.

## Known limitations

- **Prerequisites of automatic wake-up**: `rd install` has written `rd hook watch` (the `automatic wake-up` line of `rd doctor` shows ✓), Claude Code supports the hook option `asyncRewake` (verified on 2.1.325), and the session is interactive (`claude -p` does not start a watcher). Each session keeps one tiny node process that reads the `reviews/` directory once a second (about 7 ms for 300 reviews); it ends with Claude Code, and after `/clear` the old one exits by itself within a second.
- **The watcher is restarted by the `Stop` hook at the end of each turn**: after the run that woke Claude exits, there is no watcher until the turn ends. Comments sent in between are taken either by the `Stop` hook at the end of the turn (channel B; without a watcher the text asks Claude to start `rd await`) or by the next watcher. A turn interrupted with Esc fires no `Stop`, so there is no watcher again until the next turn that ends normally.
- **Claude Code's auto mode (`permission_mode: auto`) judges Bash commands by "what you said yourself"**: the wake-up message was not typed by you, so if Claude appends something like `; echo $?` or `&&` after `rd reply` / `rd done` (which no longer matches an allow rule such as `Bash(rd reply:*)`), the classifier refuses it (`Unsanctioned Communication`) and the answer cannot be written back. The wake-up text therefore asks Claude to "run exactly this one command and add nothing after it"; on Haiku both attempts complied once this sentence was added, while without it the first attempt was refused (`; echo` turned the command into a compound command). If it is refused, type `/review-reply` in Claude, or allow it in `/permissions`.
- **Documents written through Bash are not registered automatically** (`cat > file`, scripts, `cp` and other writes that do not go through Write / Edit are invisible to the hook). Use `rd add <path>` or `rd open <path>`; rd scans the transcripts to find the session that wrote the file. Bash writes inside a sub-agent cannot be found.
- **After you interrupt Claude with Esc, the session keeps showing as busy in the review desk**: Claude Code does not fire the `Stop` hook on an interrupt, so rd only learns that it is idle at the next turn.
- **Auto-injection may be mixed into input you have not submitted yet**: the injected `/review-reply <id>` is typed into Claude's input box. rd requires at least 2 seconds of idleness (`delivery.injectIdleSeconds`) and checks the target pane, but cannot know whether you happen to be typing; if that worries you, set `delivery.autoInject: false`.
- **Which model a headless resume (`h` of channel C) uses depends on Claude Code's own settings** (`--resume` keeps the original session's configuration); rd does not choose a model. `rd await` is not allowed in a headless run, and it does not call `ExitPlanMode`.
- When one session has several active reviews at once, `rd await` is per session, and `E` ends the instant Q&A of the whole session.
- In plan mode, Claude recording its answers depends on `rd` being on the PATH (the `Bash(rd reply:*)` rule matches that spelling); with a development install via `--hook-prefix` only the `<rd-reply>` fallback path works.
- Mouse drag selection has been removed (it was too easy to select the wrong lines); use `v` on the keyboard for character-level selection.
- OSC 52 clipboard copying is write-only, and rd cannot know whether the terminal really copied; the command in the channel C window can also be printed again with `rd resume <id>`.
- `rd uninstall` removes rd's own permission rules and hooks by exact text match: a rule of the same name that existed before the install (for example a hand-written `Bash(rd show:*)`) is removed as well, and empty `hooks` / `permissions` objects that existed before the install are not kept after uninstalling.
- Verified on Linux only; Node < 22 cannot run it.

## Uninstalling

```bash
rd uninstall --dry-run     # show what would be removed, plus the settings.json diff
rd uninstall               # write after confirmation (with a backup first, as for install)
```

Only what rd wrote is removed: rd hooks of every prefix (other people's hooks are kept even inside the same group), the 4 permission rules, rd's status line, and the `commands/review-reply.md` that rd wrote. Any other change you made to `settings.json` after installing (changed values, added or removed keys, your own hooks and rules) is left as it is. rd keeps the indentation of the original file when it writes `settings.json`, so with no other changes the file is identical to its pre-install state after uninstalling; a backup is left next to it before every write. Uninstalling twice does nothing; when `settings.json` is a symlink the write goes to the link target; a project-level install is removed with `--config-dir` as well.

If a plan hook, an `rd await` or an automatic wake-up watcher is still running at that moment, uninstall says so but does not terminate them (the watcher ends with its session). Data in `~/.review-desk/` is not deleted (use `rd gc` to clear out old data, or delete the directory if you do not want it at all).

## Troubleshooting

Start with `rd doctor`: it is non-interactive and prints a ✓ / ! / ✗ list with one line of explanation and a fix suggestion for each item; the exit code is 1 when anything is ✗, and `--json` prints structured results.

| Check | Description |
| --- | --- |
| Node >= 22, `rd` on PATH and pointing at this package | the hooks and `/review-reply` both call `rd` |
| `claude --version` | compared with the verified version recorded above; `!` when they differ (a failure to run it is only a warning) |
| Claude configuration directory and the project-level `./.claude/settings.json` | whether all 6 events are present, the command prefix, the `timeout` of the plan hook, the two `rd hook watch` entries for automatic wake-up (missing is `!`, noting "while a session is idle, comments need /review-reply"; no `asyncRewake` is `✗`, because Claude Code would wait for it at the end of every turn; a too short `timeout` is `!`), the 4 permission rules, whether the status line is taken by someone else, whether `commands/review-reply.md` is the current version; installing at both user and project level is flagged |
| `RD_HOME` | exists, mode 700, writable, JSON files parse, and no `*.lock` files left behind beyond the stale time |
| sessions.json | "zombie" sessions (process dead but state not ended), `awaiting` and `watcher` records that point at dead processes, failed background resumes |
| Injection adapters | whether tmux / ccd are usable in the current environment and whether the recorded pane still exists |
| `logs/rd.log` | number of hook errors in the last 24 hours and the last one |

`rd doctor --fix` repairs only three things: it marks zombie sessions as ended and removes the `awaiting` and `watcher` records that point at dead processes. For everything else it only prints the command to run (use `rd install` to add missing hooks). Values in `config.json` that rd does not recognise (for example `delivery.autoResume`) are pointed out as well.

Common situations:

- **The review desk does nothing after a plan is submitted**: run `rd doctor` and look at whether the hooks are installed (✗ `rd is not installed`) and whether `rd` is on Claude's PATH; the timeout of the plan hook must be 86400.
- **Claude's answers are not written back**: Claude has to run `rd reply`; make sure the 4 permission rules are present (the `permissions` line of doctor).
- **A comment was sent but Claude does nothing**: the header says which channel is used. When it says `After you send: delivered to Claude automatically` the comment should arrive within seconds; if nothing happens, check `rd doctor` (is `automatic wake-up` ✓, is `rd` on PATH) and `~/.review-desk/logs/rd.log` (a wake-up logs a line `woke the session for ...`), and make sure this Claude Code was started **after** the hooks were installed. Without a watcher, with an idle session and no injection adapter, you need to type `/review-reply` in Claude once. If Claude received the comment but wrote no answer (a common cause is auto mode refusing `rd reply`, see "Known limitations"), the header shows "Claude not woken: press Enter in Claude" after 60 seconds; in that case also type `/review-reply`.
- **A hook fails**: hooks never affect Claude Code (an error is only logged and the exit code is 0). The log is `~/.review-desk/logs/rd.log` and `rd doctor` counts the recent errors.

### Cleaning up: `rd gc`

```bash
rd gc --dry-run            # list what would be deleted, with sizes
rd gc --days 30            # 30 days by default; asks y/N on a TTY, needs --yes otherwise
```

It deletes: review directories whose status is closed / approved and that were last updated more than N days ago (including leftover entries in docs-index); ended sessions older than N days that no remaining review refers to; lines in `writes.jsonl` older than N days; `headless-*.log` files older than N days; an `rd.log` over 5 MB (only the last 1 MB is kept); leftovers in `tmp/` older than 1 hour.

## Development and testing

```bash
npm install
npx vitest run                      # unit and screen tests (ink-testing-library)
bash test/smoke/tui-smoke.sh        # tmux smoke test with a temporary RD_HOME; does not touch ~/.review-desk or ~/.claude
SMOKE_ONLY=n80,editor,cli bash test/smoke/tui-smoke.sh   # run only the named scenarios
```

The tests and the smoke script both use a temporary `RD_HOME` and a temporary `CLAUDE_CONFIG_DIR`, so they never modify your real `~/.claude` or `~/.review-desk`. The user interface is English; other languages can be added as packs next to `src/i18n/en.js` and selected with `ui.lang` or `RD_LANG`.

## License

MIT, (c) Aurantine Works. See [LICENSE](LICENSE).
