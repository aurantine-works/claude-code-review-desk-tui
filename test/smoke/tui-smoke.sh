#!/usr/bin/env bash
# tmux smoke test for the Review Desk TUI. Not part of `npx vitest run`.
#
#   test/smoke/tui-smoke.sh            run everything
#   SMOKE_VERBOSE=1 test/smoke/tui-smoke.sh   also print the captured panes
#   SMOKE_ONLY=wide,watch ...          run only the named scenarios (wide narrow watch instant wakeup perf term crash resize misc md diff chanc ext pick n80 editor cli)
#
# Everything runs against a throw-away RD_HOME and private tmux sessions named rdsmoke<pid>-*. It never touches
# ~/.review-desk, ~/.claude or any other tmux session. Exit status is non-zero if any check failed.
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT" || exit 2
command -v tmux >/dev/null || { echo "tmux not found; skipping smoke test"; exit 0; }
# A private tmux server (own socket): the user's tmux is never touched, and everything is gone with `kill-server`.
TMUX_SOCK="rdsmoke$$"
tm() { tmux -L "$TMUX_SOCK" "$@"; }

OUT=${SMOKE_OUT:-$(mktemp -d)}
mkdir -p "$OUT"
export RD_HOME
RD_HOME=$(mktemp -d)
# The suite asserts on the English UI, whatever the local config says.
export RD_LANG=en
# Markdown bodies are half-rendered by default; the scenarios below assert on the source text (`## Schedule`, `- Risk 1`, ...),
# so this home starts in the source view. The `md` scenario switches the config for its own run.
printf '{"ui":{"markdown":"source"}}' >"$RD_HOME/config.json"
PREFIX="rdsmoke$$"
FAILS=0
CHECKS=0
S=""
ONLY=${SMOKE_ONLY:-all}

cleanup() {
  tm kill-server 2>/dev/null
  rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$TMUX_SOCK" # the socket file of our private server
  rm -rf "$RD_HOME"
}
trap cleanup EXIT

pass() { CHECKS=$((CHECKS + 1)); echo "ok   - $1"; }
fail() {
  CHECKS=$((CHECKS + 1))
  FAILS=$((FAILS + 1))
  echo "FAIL - $1"
  if [ -n "$S" ]; then echo "----- pane ($S) -----"; tm capture-pane -t "$S" -p 2>/dev/null | head -60; echo "-----"; fi
}
want() { [ "$ONLY" = all ] || case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# --- tmux helpers -----------------------------------------------------------------------------------------------
start_pane() { # name cols rows -> sets S
  S="$PREFIX-$1"
  tm new-session -d -s "$S" -x "$2" -y "$3" "bash --norc"
  tm send-keys -t "$S" "export RD_HOME='$RD_HOME' PS1='\$ '; cd '$ROOT'; clear" Enter
  sleep 0.3
}
stop_pane() { tm kill-session -t "$S" 2>/dev/null; S=""; }
keys() { tm send-keys -t "$S" "$@"; }
lit() { tm send-keys -t "$S" -l "$1"; }
cap() { tm capture-pane -t "$S" -p; }
save() { cap >"$OUT/$1.txt"; if [ "${SMOKE_VERBOSE:-0}" = 1 ]; then echo "=== capture: $1 ==="; cat "$OUT/$1.txt"; echo "=== end ==="; fi; }

wait_text() { # text [timeout seconds] -> 0 when it appears
  local t=${2:-6} i=0
  while [ $i -lt $((t * 20)) ]; do
    cap | grep -qF -- "$1" && return 0
    sleep 0.05
    i=$((i + 1))
  done
  return 1
}
expect() { if wait_text "$1" "${3:-6}"; then pass "$2"; else fail "$2 (expected on screen: $1)"; fi; }
expect_gone() { # text description
  sleep 0.3
  if cap | grep -qF -- "$1"; then fail "$2 (still on screen: $1)"; else pass "$2"; fi
}
mouse_sgr() { lit "$(printf '\033[<%s;%s;%s%s' "$1" "$(($2 + 1))" "$(($3 + 1))" "$4")"; } # button x y M|m (0-based cells)
click() { mouse_sgr 0 "$1" "$2" M; sleep 0.08; mouse_sgr 0 "$1" "$2" m; sleep 0.2; }

# Terminal state as tmux sees it.
term_flags() { tm display -p -t "$S" '#{mouse_any_flag} #{alternate_on}'; }
expect_restored() {
  sleep 0.3
  if [ "$(term_flags)" = "0 0" ]; then pass "$1: mouse mode and alternate screen are off"; else fail "$1: terminal not restored (mouse/alt = $(term_flags))"; fi
}
# Wait until `rd await` (pid $1) has registered itself in sessions.json (its start-up takes a moment).
wait_awaiting() {
  local i=0
  while [ $i -lt 100 ]; do
    [ "$(node -e "try{const s=JSON.parse(require('fs').readFileSync(process.env.RD_HOME+'/sessions.json','utf8'))['smoke-session'];console.log(s?.awaiting?.pid===Number(process.argv[1])?'yes':'no')}catch{console.log('no')}" "$1")" = yes ] && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
run_cmd() { keys "$1" Enter; } # type a shell command into the pane
wait_prompt_exit() { # expected exit code description
  if wait_text "EXIT=$1" 8; then pass "$2"; else fail "$2 (no EXIT=$1)"; fi
}

# --- store helpers ------------------------------------------------------------------------------------------------
js() { node -e "$1"; }
seed() { node test/smoke/seed.mjs "$@"; }
idof() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]])" "$1" "$2"; }
threads_js() { # review-id js-expression-on-t
  RID=$1 EXPR=$2 node -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync(process.env.RD_HOME+'/reviews/'+process.env.RID+'/threads.json','utf8'));console.log(eval(process.env.EXPR))"
}
meta_js() {
  RID=$1 EXPR=$2 node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.env.RD_HOME+'/reviews/'+process.env.RID+'/meta.json','utf8'));console.log(eval(process.env.EXPR))"
}
check_eq() { # description actual expected
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got: $2 | want: $3)"; fi
}
cell() { cap >"$OUT/.cell.txt"; node test/smoke/cell.mjs "$OUT/.cell.txt" "$@"; }
# widest row (display columns) and number of rows of the pane; the narrow scenarios assert both stay inside the terminal
pane_extent() { cap | node -e "const s=require('string-width');const w=s.default??s;const L=require('fs').readFileSync(0,'utf8').replace(/\\n+\$/,'').split('\\n');console.log(Math.max(...L.map((l)=>w(l)))+' '+L.length)"; }
expect_fits() { # cols rows description
  local ext; ext=$(pane_extent)
  local w=${ext% *} r=${ext#* }
  if [ "$w" -le "$1" ] && [ "$r" -le "$2" ]; then pass "$3 fits $1x$2 (widest row $w)"; else fail "$3 does not fit $1x$2 (widest row $w, $r rows)"; fi
}

# The seeded Claude session is "alive" for as long as this script runs (its pid is ours).
export SEED_SESSION_PID=$$
# The reviewed files exist (seed.mjs writes them here), so no screen reports a missing or externally modified file by accident.
export SEED_DOCS_DIR="$OUT/docs"
echo "smoke: RD_HOME=$RD_HOME out=$OUT"
IDS=$(seed --big --md --diff --ended)
DOC=$(idof "$IDS" doc)
DIFF=$(idof "$IDS" diff)
DIFFBIG=$(idof "$IDS" diffbig)
ENDED=$(idof "$IDS" ended)
MD=$(idof "$IDS" md)
PLAN=$(idof "$IDS" plan)
BIG=$(idof "$IDS" big)

# ================================================================================================================
# 1. Wide layout (160x45): clicks, scrolling, keyboard comments (V and v), resolve, approve, quit
# ================================================================================================================
if want wide; then
  echo; echo "## wide layout 160x45 (doc review)"
  start_pane wide 160 45
  run_cmd "node bin/rd.js open $DOC; echo EXIT=\$?"
  expect "rev 1/1" "doc opens"
  expect "Migrating the old store is low risk" "document text is rendered"
  expect "t1 · L9 · answered" "thread card is shown in the right panel"
  expect "NORMAL" "status bar shows the mode"
  [ "$(term_flags)" = "1 1" ] && pass "mouse reporting and alternate screen are on while running" || fail "mouse/alt flags while running: $(term_flags)"
  save wide-01-open

  # Clicks land on the row that is drawn there: wrapped continuation rows, a far row, then back
  cap >"$OUT/.c.txt"
  read -r CX CY < <(node test/smoke/cell.mjs "$OUT/.c.txt" "two risks need attention" )
  click "$CX" "$CY"
  expect "L5/27" "click on the wrapped continuation row of line 5 selects line 5"
  read -r CX CY < <(node test/smoke/cell.mjs "$OUT/.c.txt" "## Schedule" --row-containing "Schedule")
  click "$CX" "$CY"
  expect "L20/27" "click on '## Schedule' selects line 20"
  read -r CX CY < <(node test/smoke/cell.mjs "$OUT/.c.txt" "Last line of the report.")
  click "$CX" "$CY"
  expect "L27/27" "click on the last line selects line 27"
  keys g
  expect "L1/27" "g goes to the top"
  save wide-01b-after-clicks

  keys j j j j j j j j
  expect "L9/27" "j moves the cursor (8 presses)"
  lit "jj"
  expect "L11/27" "coalesced keys are separate commands"
  lit "kk"
  expect "L9/27" "k moves back"
  # V + j + c with Chinese text
  keys V j
  expect "VISUAL" "V enters line selection"
  keys c
  expect "INPUT" "c opens the comment box"
  expect "Comment L9-10" "box title shows the selected lines"
  lit "这个回滚方案需要列出具体步骤，谢谢"
  expect "这个回滚方案需要列出具体步骤，谢谢" "Chinese text is typed into the box"
  sleep 0.3
  save wide-02-comment-box
  keys Enter
  expect "t3 · L9-10 · open" "Enter sends the comment (instant mode): card appears"
  expect "sent · delivered with your next message" "sent but not received: the card says which channel will carry it (idle session, no injector = A)"
  expect "After you send: with your next message" "header shows the delivery channel"
  expect "round 1" "header shows the feedback round (the new message joins the round that is still waiting)"
  save wide-03-sent
  check_eq "store: new thread anchored to lines 9-10 as whole lines" "$(threads_js "$DOC" "JSON.stringify([t[2].anchor.startLine,t[2].anchor.endLine,t[2].anchor.startCol,t[2].anchor.endCol])")" "[9,10,null,null]"
  check_eq "store: message text and sent state" "$(threads_js "$DOC" "t[2].messages[0].text+'|'+t[2].messages[0].state")" "这个回滚方案需要列出具体步骤，谢谢|sent"
  check_eq "store: queued in the outbox" "$(RID=$DOC node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.RD_HOME+'/reviews/'+process.env.RID+'/outbox.json','utf8')).length)")" "2"

  # character-wise selection with the keyboard: click on the b of 'because', then v + 6 x l, c
  cap >"$OUT/.c.txt"
  read -r X0 Y0 < <(node test/smoke/cell.mjs "$OUT/.c.txt" "because it only" --row-containing "Migrating")
  click "$X0" "$Y0"
  expect "L9/27" "click on a word of line 9 puts the cursor on line 9"
  expect "MENU" "line 9 is covered by two threads there: the click opens the thread picker"
  keys Escape
  expect "NORMAL" "Esc closes the picker, the cursor stays on the word"
  keys v
  expect "VISUAL" "v starts character-wise selection"
  lit "llllll"
  expect "VISUAL" "still selecting"
  save wide-04-char-selection
  keys c
  expect "INPUT" "c opens the comment box for the selection"
  lit "comment on a char selection"
  sleep 0.3
  keys Enter
  expect "comment on a char selection" "the comment is sent and shown"
  sleep 0.5
  check_eq "store: char anchor startCol/endCol (UTF-16) and exact quote" "$(threads_js "$DOC" "JSON.stringify([t[3].anchor.startLine,t[3].anchor.endLine,t[3].anchor.startCol,t[3].anchor.endCol,t[3].anchor.quote])")" '[9,9,36,43,"because"]'
  save wide-05-after-char-comment

  # dragging selects nothing (mouse drag selection was removed)
  cap >"$OUT/.c.txt"
  read -r X0 Y0 < <(node test/smoke/cell.mjs "$OUT/.c.txt" "The rollback plan")
  mouse_sgr 0 "$X0" "$Y0" M; sleep 0.1
  mouse_sgr 32 $((X0 + 6)) "$Y0" M; sleep 0.1
  mouse_sgr 0 $((X0 + 6)) "$Y0" m; sleep 0.3
  expect_gone "VISUAL" "a mouse drag does not start a selection"
  expect_gone "[Comment]" "and there is no [Comment] button"

  # resolve / reopen with x
  keys x
  expect "resolved ✓" "x resolves the focused thread"
  check_eq "store: the focused thread is resolved" "$(threads_js "$DOC" "t.filter((x) => x.status === 'resolved').length")" "1"
  keys x
  expect_gone "resolved ✓" "x again reopens it"

  # approve with confirmation
  keys A
  expect "CONFIRM" "A asks for confirmation"
  expect "Approve and close this document review?" "confirmation text for a doc review"
  keys n
  expect "NORMAL" "n cancels"
  keys A
  keys y
  expect "approved and closed" "y approves"
  sleep 0.4
  check_eq "store: doc review closed" "$(meta_js "$DOC" "m.status")" "closed"
  keys c
  expect "Review is finished" "a finished review is read-only"
  keys q
  wait_prompt_exit 0 "q quits with exit code 0"
  expect_restored "wide"
  stop_pane
fi

# ================================================================================================================
# 2. Narrow layout (80x30): drawer, batch mode for plans, submit, approve
# ================================================================================================================
if want narrow; then
  echo; echo "## narrow layout 80x30 (plan review)"
  start_pane narrow 80 30
  run_cmd "node bin/rd.js open $PLAN; echo EXIT=\$?"
  expect "instant" "plan reviews default to instant mode"
  expect "rev 1/1" "plan opens"
  keys B
  expect "batch" "B switches to batch mode (b is 'back a word' now)"
  save narrow-01-open
  keys j j
  keys V j
  keys c
  expect "INPUT" "the comment box floats at the bottom of the screen"
  expect "Comment L3-4" "box title"
  lit "Please split step two into finer steps and list every slice"
  expect "list every slice" "text is shown in the box"
  sleep 0.3
  save narrow-02-comment-drawer
  keys Enter
  expect "draft saved" "Enter saves a draft in batch mode"
  expect "Comments (1)" "drawer lists the thread of the cursor line"
  expect "draft" "draft marker in the card"
  save narrow-03-draft
  check_eq "store: draft, not queued" "$(threads_js "$PLAN" "t[0].messages[0].state")" "draft"
  # the screen never exceeds 80 columns
  WIDTH=$(cap | node -e "const s=require('string-width').default??require('string-width');let m=0;for(const l of require('fs').readFileSync(0,'utf8').split('\n'))m=Math.max(m,s(l));console.log(m)")
  [ "$WIDTH" -le 80 ] && pass "no line wider than 80 columns (max $WIDTH)" || fail "line wider than 80 columns: $WIDTH"
  keys s
  expect "sent · delivered with your next message" "s submits the drafts: the card says how they are carried (channel A)"
  sleep 0.4
  check_eq "store: message sent, plan feedback_pending" "$(threads_js "$PLAN" "t[0].messages[0].state")|$(meta_js "$PLAN" "m.status")" "sent|feedback_pending"
  keys '?'
  expect "Ctrl-d / Ctrl-u" "? shows the help screen"
  save narrow-04-help
  keys x
  expect_gone "Ctrl-d / Ctrl-u" "any key closes help"
  keys A
  expect "Approve this plan" "plan approval is confirmed"
  keys y
  expect "Approved;" "approved"
  sleep 0.4
  check_eq "store: plan approved, to be let through at Claude's next ExitPlanMode (no hook was waiting)" "$(meta_js "$PLAN" "m.status+'|'+m.approvedPendingExit")" "approved|true"
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "narrow"
  stop_pane
fi

# ================================================================================================================
# 3. Watch mode: a plan review created by another process opens automatically; approve -> hook returns allow
# ================================================================================================================
if want watch; then
  echo; echo "## watch mode (rd with no arguments)"
  start_pane watch 160 45
  run_cmd "node bin/rd.js; echo EXIT=\$?"
  expect "watching" "plain rd is the watch inbox"
  expect "inbox" "inbox is shown"
  expect "big.md" "seeded reviews are listed"
  save watch-01-inbox
  rm -f "$OUT/hook1.json" "$OUT/hook2.json"
  node test/smoke/fake-hook.mjs "$OUT/hook1.json" smoke-hook-1 "Smoke test plan one" &
  HOOK1=$!
  expect "Smoke test plan one" "a new plan review auto-opens in the watch inbox" 8
  expect "plan · waiting for your decision" "header says the plan is waiting for the decision"
  save watch-02-auto-open
  [ "$(tm display -p -t "$S" '#{window_bell_flag}')" = "1" ] && pass "the bell rang (tmux bell flag)" || echo "note - tmux bell flag not set (not all tmux versions flag detached sessions)"
  sleep 0.3
  keys A
  expect "CONFIRM" "A asks for confirmation"
  keys y
  wait $HOOK1
  check_eq "simulated hook resolved with allow" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT/hook1.json','utf8')).decision.behavior)")" "allow"
  expect "inbox" "approval returns to the inbox"
  expect_gone "plan · waiting for your decision" "the review screen is gone"
  save watch-03-after-approve

  # feedback path: plan reviews are instant by default: Enter sends, the hook returns deny with the comment at once
  node test/smoke/fake-hook.mjs "$OUT/hook2.json" smoke-hook-2 "Smoke test plan two" &
  HOOK2=$!
  expect "Smoke test plan two" "the next plan opens automatically" 8
  expect "instant mode" "plan reviews default to instant mode"
  sleep 0.4
  keys j j
  keys c
  lit "Please split step two"
  sleep 0.3 # Enter in the same chunk as the text would count as a pasted line break, not as "send"
  keys Enter
  wait $HOOK2
  check_eq "simulated hook resolved with deny" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT/hook2.json','utf8')).decision.behavior)")" "deny"
  check_eq "deny message carries the comment" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT/hook2.json','utf8')).decision.message.includes('Please split step two'))")" "true"
  expect "Claude has it · answering" "the review stays open and says Claude has the feedback"
  expect "Claude is answering…" "the thread shows that Claude is answering"
  keys q
  expect "inbox" "q goes back to the inbox"
  expect "delivered" "the inbox shows the delivered plan"
  save watch-04-after-feedback
  keys q
  wait_prompt_exit 0 "q quits the watch inbox"
  expect_restored "watch"
  stop_pane
fi

# ================================================================================================================
# 3b. Instant Q&A with a simulated Claude: `rd await` in the background, `rd reply` + `rd done` from another process
# ================================================================================================================
if want instant; then
  echo; echo "## instant Q&A (simulated Claude: rd await / rd reply / rd done)"
  IDS_I=$(seed --plain --long)
  INST=$(idof "$IDS_I" plain)
  LONG=$(idof "$IDS_I" long)
  export CLAUDE_CODE_SESSION_ID=smoke-session
  start_pane instant 160 45
  run_cmd "node bin/rd.js open $INST; echo EXIT=\$?"
  expect "rev 1/1" "doc opens"
  expect "After you send: with your next message" "no rd await yet: channel A"
  expect "session idle" "header shows the session state"

  # Claude starts its background rd await for this review
  rm -f "$OUT/await1.out" "$OUT/await2.out" "$OUT/await3.out"
  node bin/rd.js await --review "$INST" >"$OUT/await1.out" 2>&1 &
  AWAIT1=$!
  wait_awaiting $AWAIT1 && pass "rd await registered itself" || fail "rd await did not register"
  expect "instant Q&A ·" "a live rd await shows as instant Q&A in the header" 8
  expect_gone "After you send: with your next message" "the channel hint is replaced by it"
  expect "E end Q&A" "the status bar offers E"

  # the user comments: rd await takes it, the thread shows that Claude is answering
  keys j j j
  keys c
  lit "Please explain the basis for this"
  sleep 0.3
  keys Enter
  expect "t1 · L4 · open" "the thread card appears"
  expect "Claude is answering…" "after rd await received it: Claude is answering…" 8
  wait $AWAIT1
  grep -q "^# rd-await v1" "$OUT/await1.out" && pass "rd await printed the marker line" || fail "rd await output: $(head -3 "$OUT/await1.out")"
  grep -q "Please explain the basis for this" "$OUT/await1.out" && pass "rd await delivered the comment text" || fail "comment missing in the rd await output"
  check_eq "store: the outbox entry was received via await" "$(RID=$INST node -e "const e=JSON.parse(require('fs').readFileSync(process.env.RD_HOME+'/reviews/'+process.env.RID+'/outbox.json','utf8'));console.log(e[0].deliveredVia+'|'+!!e[0].receivedAt)")" "await|true"
  save instant-01-answering

  # Claude answers from another process, like the Bash tool would
  node bin/rd.js reply "$INST" t1 "Answer: this only affects two slices, there is no cross-slice dependency." >/dev/null
  node bin/rd.js done "$INST" >/dev/null
  expect "Answer: this only affects two slices" "the answer shows up in the thread card within a second" 6
  expect_gone "Claude is answering…" "and the waiting line is gone"
  save instant-02-answered

  # Claude re-enters the loop; an interrupted await shows as Q&A interrupted, a fresh one takes over
  node bin/rd.js await --review "$INST" >"$OUT/await2.out" 2>&1 &
  AWAIT2=$!
  wait_awaiting $AWAIT2 && pass "the next rd await registered itself" || fail "second rd await did not register"
  expect "instant Q&A ·" "the next rd await shows as instant Q&A again" 8
  kill -9 $AWAIT2 2>/dev/null; wait $AWAIT2 2>/dev/null
  expect "Q&A interrupted" "a killed rd await shows as Q&A interrupted" 8
  node bin/rd.js await --review "$INST" >"$OUT/await3.out" 2>&1 &
  AWAIT3=$!
  wait_awaiting $AWAIT3 && pass "the replacement rd await registered itself" || fail "third rd await did not register"
  expect "instant Q&A ·" "a new rd await takes over" 8

  # E ends instant Q&A: the waiting rd await prints `end` and exits
  keys E
  expect "Ended this session's instant Q&A" "E ends instant Q&A (session-level status message)"
  wait $AWAIT3
  grep -q "^end" "$OUT/await3.out" && pass "the waiting rd await printed end" || fail "await3 output: $(head -3 "$OUT/await3.out")"
  expect "instant Q&A ended" "the header says it ended"
  check_eq "store: instant ended" "$(meta_js "$INST" "!!m.instant?.endedAt")" "true"
  keys E
  expect "instant Q&A already ended" "E again says so"
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "instant"
  stop_pane

  # a batch Claude received 2 minutes ago and never answered while the session idles: the lost wake-up case
  echo; echo "## lost wake-up"
  IDS_W=$(seed --plain); WAKE=$(idof "$IDS_W" plain)
  RID=$WAKE node test/smoke/stale-batch.mjs "$WAKE" >/dev/null
  start_pane wake 160 45
  run_cmd "node bin/rd.js open $WAKE; echo EXIT=\$?"
  expect "not woken" "unanswered for 60 s while idle: the header asks the user to wake Claude" 8
  save instant-03-wake
  keys q
  wait_prompt_exit 0 "q quits"
  stop_pane

  # a floating reply box under a very tall thread card is completely on screen, and the wheel still works
  echo; echo "## reply box under a tall card"
  start_pane reply 160 24
  run_cmd "node bin/rd.js open $LONG; echo EXIT=\$?"
  expect "t1 · L9" "the tall card is shown"
  keys j j j j j j j j
  expect "L9/27" "cursor on the thread line"
  keys r
  expect "Reply t1" "r opens the reply box"
  sleep 0.3
  cap >"$OUT/.c.txt"
  TOPROW=$(grep -n "Reply t1" "$OUT/.c.txt" | head -1 | cut -d: -f1)
  BOTROW=$(awk -v t="$TOPROW" 'NR>t && /╰/ {print NR; exit}' "$OUT/.c.txt")
  [ -n "$TOPROW" ] && [ -n "$BOTROW" ] && [ "$BOTROW" -lt 24 ] && pass "the box is completely on screen (rows $TOPROW-$BOTROW of 24)" || fail "box not fully visible: $TOPROW-$BOTROW"
  lit "reply text"
  expect "reply text" "typing goes to the box"
  save instant-04-reply-box
  BEFORE=$(grep -n "A very long answer" "$OUT/.c.txt" | head -1 | cut -d: -f1)
  mouse_sgr 65 120 6 M; sleep 0.1; mouse_sgr 65 120 6 M; sleep 0.4
  cap >"$OUT/.c2.txt"
  AFTER=$(grep -n "A very long answer" "$OUT/.c2.txt" | head -1 | cut -d: -f1)
  [ "$BEFORE" != "$AFTER" ] && pass "the wheel over the panel scrolls the cards while the box is open (row $BEFORE -> $AFTER)" || fail "wheel did not scroll the panel ($BEFORE -> $AFTER)"
  expect "reply text" "the box kept its text"
  keys Escape
  sleep 0.3
  keys y
  expect "NORMAL" "Esc + y discards the reply"
  keys q
  wait_prompt_exit 0 "q quits"
  stop_pane
  unset CLAUDE_CODE_SESSION_ID
fi

# ================================================================================================================
# 3c. The wake-up watcher: a real `rd hook watch` process is registered for the session; the top bar says comments are delivered
#     automatically, the watcher takes the comment (exit code 2, text on stderr) and the header falls back once it is gone
# ================================================================================================================
if want wakeup; then
  echo; echo "## wake-up watcher (real rd hook watch process)"
  IDS_K=$(seed --plain); KEEP=$(idof "$IDS_K" plain)
  rm -f "$OUT/watch.out" "$OUT/watch.err"
  # the seeded reviews of the session have feedback queued, and an earlier scenario approved the plan while no hook was waiting:
  # let Claude "receive" both first, so the watcher has nothing to take yet
  node --input-type=module -e "
    import { readSessionReviews, takeUnreceived } from './src/store/outbox.js';
    import { withReview } from './src/store/reviews.js';
    for (const r of readSessionReviews('smoke-session', { pendingExit: true })) {
      await takeUnreceived(r.meta.id, { via: 'A' });
      if (r.meta.approvedPendingExit) await withReview(r.meta.id, (c) => { c.meta.exitNotifiedAt = new Date().toISOString(); });
    }
  "
  # CLAUDE_PID = this script: a live process that is not claude, so the watcher takes it as its owner
  echo '{"session_id":"smoke-session","hook_event_name":"Stop"}' | CLAUDE_PID=$$ node bin/rd.js hook watch >"$OUT/watch.out" 2>"$OUT/watch.err" &
  WATCHER=$!
  i=0; until [ "$(node -e "try{const s=JSON.parse(require('fs').readFileSync(process.env.RD_HOME+'/sessions.json','utf8'))['smoke-session'];console.log(s?.watcher?.pid?'yes':'no')}catch{console.log('no')}")" = yes ] || [ $i -ge 100 ]; do sleep 0.1; i=$((i + 1)); done
  check_eq "the watcher registered itself in sessions.json" "$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.RD_HOME+'/sessions.json','utf8'))['smoke-session'].watcher.pid>0)")" "true"
  start_pane wakeup 160 45
  run_cmd "node bin/rd.js open $KEEP; echo EXIT=\$?"
  expect "rev 1/1" "doc opens"
  expect "After you send: delivered to Claude automatically" "a live watcher: the top bar says comments are delivered automatically"
  sleep 0.5
  expect_gone "/review-reply" "and nothing sends the user to the Claude terminal"
  save wakeup-01-header
  keys j j j
  keys c
  lit "Please explain the basis for this"
  sleep 0.3
  keys Enter
  wait $WATCHER; CODE=$?
  check_eq "the watcher took the comment and exited with code 2" "$CODE" "2"
  grep -q "Please explain the basis for this" "$OUT/watch.err" && pass "the comment text is on the watcher's stderr" || fail "watcher stderr: $(head -3 "$OUT/watch.err")"
  grep -q "this is not an error" "$OUT/watch.err" && pass "…with the lead that says it is not an error" || fail "lead missing"
  check_eq "nothing on the watcher's stdout" "$(wc -c <"$OUT/watch.out" | tr -d ' ')" "0"
  check_eq "store: received via watch, watcher record cleared" "$(RID=$KEEP node -e "const fs=require('fs');const h=process.env.RD_HOME;const e=JSON.parse(fs.readFileSync(h+'/reviews/'+process.env.RID+'/outbox.json','utf8'));const s=JSON.parse(fs.readFileSync(h+'/sessions.json','utf8'))['smoke-session'];console.log(e[0].deliveredVia+'|'+!!e[0].receivedAt+'|'+(s.watcher===undefined))")" "watch|true|true"
  expect "Claude is answering…" "the thread shows that Claude is answering" 8
  expect "After you send: with your next message" "the watcher is gone (until the next Stop arms another): the header falls back to channel A" 8
  save wakeup-02-after
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "wakeup"
  stop_pane
fi

# ================================================================================================================
# 4. Performance on a 2000-line document
# ================================================================================================================
now_ms() { date +%s%3N; }
settle_ms() { # waits until the last pane line stops changing for 250 ms; prints ms from `$1` (start) to the last change
  local start=$1 last_change=$1 prev="" cur
  local quiet_since
  quiet_since=$(now_ms)
  while :; do
    cur=$(cap | tail -1)
    if [ "$cur" != "$prev" ]; then prev=$cur; last_change=$(now_ms); quiet_since=$last_change; fi
    [ $(($(now_ms) - quiet_since)) -gt 250 ] && break
    sleep 0.01
  done
  echo $((last_change - start))
}
if want perf; then
  echo; echo "## performance (2000-line document, 160x45)"
  start_pane perf 160 45
  run_cmd "node bin/rd.js open $BIG; echo EXIT=\$?"
  expect "L1/2000" "big document opens"
  T0=$(now_ms); lit "$(printf 'j%.0s' $(seq 1 200))"
  expect "L201/2000" "200 x j in one burst" 10
  MS=$(settle_ms "$T0"); echo "perf - 200 x j burst settled in ${MS} ms"; [ "$MS" -lt 2000 ] && pass "200 j keys stay responsive (<2 s)" || fail "200 j keys took ${MS} ms"
  T0=$(now_ms); lit "$(printf '\004%.0s' $(seq 1 40))"
  MS=$(settle_ms "$T0"); echo "perf - 40 x Ctrl-d burst settled in ${MS} ms"; [ "$MS" -lt 2000 ] && pass "40 Ctrl-d presses stay responsive (<2 s)" || fail "40 Ctrl-d took ${MS} ms"
  LINE=$(cap | tail -1 | grep -o 'L[0-9]*/2000')
  [ -n "$LINE" ] && pass "cursor after Ctrl-d burst: $LINE" || fail "no cursor position after Ctrl-d burst"
  save perf-01-after-ctrl-d
  T0=$(now_ms); keys G; expect "L2000/2000" "G jumps to the end" ; echo "perf - G took $(($(now_ms) - T0)) ms"
  expect "Line 2000" "last line is visible"
  T0=$(now_ms); keys g; expect "L1/2000" "g jumps to the start"; echo "perf - g took $(($(now_ms) - T0)) ms"
  # separate key presses (each its own write) while the app keeps up
  T0=$(now_ms)
  for _ in $(seq 1 60); do keys j; done
  expect "L61/2000" "60 separate j presses are all applied" 10
  echo "perf - 60 separate presses (incl. tmux process spawn) $(($(now_ms) - T0)) ms"
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "perf"
  stop_pane
fi

# ================================================================================================================
# 5. Signals and crashes always restore the terminal
# ================================================================================================================
if want term; then
  echo; echo "## signals"
  for SIG in TERM INT HUP; do
    start_pane "sig$SIG" 100 24
    run_cmd "node bin/rd.js open $DOC; echo EXIT=\$?"
    expect "rev 1/1" "$SIG: review is open"
    PID=$(pgrep -f "^node bin/rd.js open $DOC" | head -1)
    kill -"$SIG" "$PID"
    case $SIG in TERM) CODE=143 ;; INT) CODE=130 ;; HUP) CODE=129 ;; esac
    wait_prompt_exit "$CODE" "SIG$SIG ends the process with exit code $CODE"
    expect_restored "SIG$SIG"
    expect_gone "rev 1/1" "SIG$SIG leaves no stale frame on the normal screen"
    stop_pane
  done
  CC=$(idof "$(seed)" doc) # a fresh, still open review (the wide scenario approved $DOC)
  start_pane ctrlc 100 24
  run_cmd "node bin/rd.js open $CC; echo EXIT=\$?"
  expect "rev 1/1" "Ctrl-C: review is open"
  # Ctrl-C is not Ink's exit key any more: in the comment box it is Esc (an unsent comment is never lost silently)
  expect "NORMAL" "Ctrl-C: the review accepts keys"
  sleep 0.5 # Ink subscribes its input handlers a moment after the first frame
  keys c
  expect "INPUT" "Ctrl-C: the comment box is open"
  lit "unsent text"
  sleep 0.3
  keys C-c
  expect "Discard this comment?" "Ctrl-C in the comment box asks before discarding text"
  keys C-c
  expect "INPUT" "Ctrl-C in the confirmation keeps editing"
  expect "unsent text" "the unsent text survived"
  keys C-c
  keys y
  expect "NORMAL" "confirming discards the comment"
  keys C-c
  wait_prompt_exit 0 "Ctrl-C in Normal mode quits like q"
  expect_restored "Ctrl-C"
  stop_pane
fi

if want crash; then
  echo; echo "## crash"
  start_pane crash 100 24
  run_cmd "NODE_OPTIONS='--import $ROOT/test/smoke/crash-preload.mjs' RD_SMOKE_CRASH_MS=1500 node bin/rd.js open $DOC; echo EXIT=\$?"
  expect "rev 1/1" "crash: review is open"
  wait_prompt_exit 1 "an uncaught exception exits with code 1"
  expect "smoke: simulated crash" "the error is printed on the restored screen"
  expect_restored "crash"
  expect_gone "rev 1/1" "no stale frame is left on the normal screen"
  stop_pane
fi

# ================================================================================================================
# 6. Resize: layout follows the window, and a round trip leaves no rendering drift
# ================================================================================================================
if want resize; then
  echo; echo "## resize"
  start_pane resize 160 45
  run_cmd "node bin/rd.js open $PLAN; echo EXIT=\$?"
  expect "rev 1/1" "plan opens"
  keys jj
  expect "L3/" "cursor moved"
  cap >"$OUT/resize-before.txt"
  tm resize-window -t "$S" -x 90 -y 28
  sleep 0.6
  expect "NORMAL" "still running after resizing to 90x28"
  cap | grep -q '┬' && fail "narrow layout expected below 110 columns" || pass "layout switched to the narrow variant (no side panel)"
  save resize-narrow
  tm resize-window -t "$S" -x 160 -y 45
  sleep 0.6
  cap >"$OUT/resize-after.txt"
  if diff -q "$OUT/resize-before.txt" "$OUT/resize-after.txt" >/dev/null; then pass "round trip back to 160x45 reproduces the identical screen"; else fail "screen differs after resize round trip"; diff "$OUT/resize-before.txt" "$OUT/resize-after.txt" | head -10; fi
  keys q
  wait_prompt_exit 0 "q quits"
  stop_pane
fi

# ================================================================================================================
# 7. Misc: non-TTY, bad arguments, rd close, $EDITOR hand-over and the mouse toggle
# ================================================================================================================
if want misc; then
  echo; echo "## misc"
  OUTTXT=$(echo | node bin/rd.js open "$DOC" 2>&1); CODE=$?
  check_eq "non-interactive stdin is refused with exit 1" "$CODE" "1"
  case $OUTTXT in *"interactive terminal"*) pass "…and says why" ;; *) fail "unexpected message: $OUTTXT" ;; esac
  node bin/rd.js open not-an-id 2>&1 | grep -q "invalid review id" && pass "bad review id is rejected" || fail "bad review id message"
  # M3: a path argument is looked up (active review, else the session that wrote it); no TUI is started when that fails
  node bin/rd.js open "$OUT/no-such-file.md" 2>&1 | grep -q "file not found" && pass "an unregistered path that does not exist says so" || fail "path message (missing file)"
  printf '# orphan\n' >"$OUT/orphan.md"
  CLAUDE_CONFIG_DIR="$OUT/claude-config" node bin/rd.js open "$OUT/orphan.md" 2>&1 | grep -q "no Claude Code session found.*--session" && pass "a path nobody wrote asks for --session" || fail "path message (no writer)"
  IDS2=$(seed); D2=$(idof "$IDS2" doc)
  check_eq "rd close closes a review" "$(node bin/rd.js close "$D2")" "closed $D2"

  cat >"$OUT/fake-editor.sh" <<'EOF'
#!/bin/sh
printf '%s\n' "edited-in-editor" >> "$1"
EOF
  chmod +x "$OUT/fake-editor.sh"
  IDS3=$(seed); D3=$(idof "$IDS3" doc)
  start_pane misc 160 45
  run_cmd "EDITOR='$OUT/fake-editor.sh' node bin/rd.js open $D3; echo EXIT=\$?"
  expect "rev 1/1" "review opens"
  keys c
  lit "before"
  sleep 0.3 # Ctrl+E in the same chunk as the text would be swallowed as part of a paste-like insert
  keys C-e
  expect "edited-in-editor" "Ctrl+E hands the text to \$EDITOR and takes it back"
  [ "$(term_flags)" = "1 1" ] && pass "mouse mode and alternate screen are back after the editor" || fail "terminal flags after editor: $(term_flags)"
  keys Escape
  sleep 0.2
  keys y
  expect "NORMAL" "Esc + y discards the comment"
  keys m
  sleep 0.3
  [ "$(tm display -p -t "$S" '#{mouse_any_flag}')" = "0" ] && pass "m turns mouse reporting off" || fail "m did not turn mouse off"
  expect "mouse off" "status bar shows that the mouse is off"
  keys m
  sleep 0.3
  [ "$(tm display -p -t "$S" '#{mouse_any_flag}')" = "1" ] && pass "m turns it back on" || fail "m did not turn mouse on"
  keys q
  wait_prompt_exit 0 "q quits"
  stop_pane
fi

# ================================================================================================================
# 8. Markdown half-rendered view (the default): rendering, character selection, M, source offsets in the store
# ================================================================================================================
if want md; then
  echo; echo "## Markdown rendered view (120x50)"
  printf '{"ui":{"markdown":"rendered"}}' >"$RD_HOME/config.json"
  start_pane md 120 50
  run_cmd "node bin/rd.js open $MD; echo EXIT=\$?"
  expect "rev 1/1" "document opens"
  expect "Setext heading" "setext heading text is shown"
  expect "═══════════" "the setext underline is drawn as a rule"
  expect "◦ Nested second level" "nested bullet with its markers hidden"
  expect "▪ Third level" "third level bullet"
  expect "│ 名称   │" "table: pipes drawn as borders, CJK cells padded by display width"
  expect "├────────┼" "table: delimiter row drawn as a rule"
  expect "▎ ▎ Nested quote" "quote markers"
  expect "这是加粗、斜体、粗斜体、删除线 和 行内代码" "inline markup rendered"
  expect_gone "## Paragraphs and inline" "heading marks are hidden"
  expect_gone "**加粗**" "emphasis markers are hidden"
  expect_gone "](https" "link targets are hidden"
  expect "md · L1/" "status bar says md"
  save md-01-rendered
  # character selection and a comment in the rendered view; the store gets SOURCE offsets
  keys j j j j j j j j j
  expect "L10/" "cursor on the paragraph line (line numbers are the source's)"
  keys l l v l
  expect "VISUAL" "v selects displayed characters"
  keys c
  expect "INPUT" "c opens the comment box"
  lit "What does bold mean here"
  sleep 0.3
  save md-02-comment
  keys Enter
  expect "t1 · L10 · open" "comment sent"
  sleep 0.5
  check_eq "store: the anchor is a source range, the quote has no markers" "$(threads_js "$MD" "JSON.stringify([t[0].anchor.startLine,t[0].anchor.startCol,t[0].anchor.endCol,t[0].anchor.quote])")" '[10,4,6,"加粗"]'
  save md-03-after
  # M shows the source, the cursor stays on the same character and line; M again renders
  keys M
  expect "src · L10/" "M switches to the source view"
  expect "## Paragraphs and inline" "source heading marks are back"
  expect "这是**加粗**、*斜体*" "source emphasis markers are back"
  save md-04-source
  keys M
  expect "md · L10/" "M switches back"
  expect_gone "## Paragraphs and inline" "rendered again"
  # a click on a displayed character
  cap >"$OUT/.c.txt"
  read -r CX CY < <(node test/smoke/cell.mjs "$OUT/.c.txt" "斜体")
  click "$CX" "$CY"
  keys v l
  keys c
  expect "INPUT" "c after a click opens the box"
  lit "click selection"
  sleep 0.3
  keys Enter
  sleep 0.5
  check_eq "store: click + v + l anchors the two characters under it, source columns" "$(threads_js "$MD" "JSON.stringify([t[1].anchor.startCol,t[1].anchor.endCol,t[1].anchor.quote])")" '[10,12,"斜体"]'
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "md"
  stop_pane
  # a plan is Markdown too; a non-Markdown file is not rendered
  start_pane md2 100 30
  run_cmd "node bin/rd.js open $PLAN; echo EXIT=\$?"
  expect "md · L1/" "plan reviews are rendered"
  expect_gone "# Plan: refactor the device table" "plan heading mark hidden"
  keys q
  wait_prompt_exit 0 "q quits"
  stop_pane
  printf '{"ui":{"markdown":"source"}}' >"$RD_HOME/config.json"
fi

# ================================================================================================================
# 9. Diff view (d): revisions, base stepping, read-only, Enter, wheel and click on a long diff, the narrow layout
# ================================================================================================================
if want diff; then
  echo; echo "## diff view (160x45, then 80x30)"
  start_pane diff 160 45
  run_cmd "node bin/rd.js open $DIFF; echo EXIT=\$?"
  expect "rev 3/3" "a document with three revisions opens"
  keys d
  expect "diff rev 2→3" "d opens the diff against the previous revision"
  expect "[d] back to text" "the header offers the way back"
  expect "DIFF" "the status bar badge says DIFF"
  expect "t1 · L4" "the thread panel stays on screen next to the diff"
  expect "+1 -3" "the header counts added and removed lines"
  cap | grep -qE '^ *5 +-│ The rollback plan relies on a feature flag\.' && pass "removed line: its old number and a '-' sign" || fail "removed line row not found"
  cap | grep -qE '^ +5 +\+│ The rollback plan relies on a feature flag and a canary\.' && pass "added line: its new number and a '+' sign" || fail "added line row not found"
  cap | grep -qE '^ *4 +4▌ │ Migrating the old store' && pass "an unchanged line shows both numbers; the thread marker is on its new line" || fail "context row with marker not found"
  cap | grep -q '## Risks' && pass "the source text is shown (Markdown marks stay)" || fail "source text missing"
  save diff-01-wide
  tm capture-pane -t "$S" -p -e >"$OUT/diff-01-wide.ansi"
  grep -q '48;5;' "$OUT/diff-01-wide.ansi" && pass "added and removed rows carry background colours" || fail "no background colour in the diff rows"
  keys '<'
  expect "diff rev 1→3" "< compares against an older base revision"
  expect "Migrating the old store is low risk" "…whose text is the removed side now"
  keys '<'
  expect "Already the oldest revision" "< at the oldest revision says so"
  keys '>'
  expect "diff rev 2→3" "> goes back to the newer base"
  keys c
  expect "The diff view is read-only" "writing keys only explain that the view is read-only"
  expect_gone "INPUT" "no comment box opens in the diff view"
  keys j
  expect "L5/9" "j moves to the added line (its new line number is shown)"
  keys Enter
  expect "NORMAL" "Enter returns to the normal view"
  expect "L5/9" "…with the cursor on that new line"
  save diff-02-after-enter
  keys d
  keys ']' 'c'
  expect "-L10" "]c jumps to the next block of changes (a removed line, shown as -L<old>)"
  keys q
  expect_gone "DIFF" "q leaves the diff"
  keys d
  expect "DIFF" "d opens it again"
  keys d
  expect_gone "DIFF" "d leaves the diff"
  keys d
  expect "DIFF" "…once more"
  keys Escape
  expect_gone "DIFF" "Esc leaves the diff"
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "diff"
  stop_pane

  # a long diff: virtual scrolling, wheel, click
  start_pane diffbig 160 40
  run_cmd "node bin/rd.js open $DIFFBIG; echo EXIT=\$?"
  expect "rev 2/2" "a 600 line document with two revisions opens"
  keys d
  expect "Line 3: the beginning was modified" "the first change is in view"
  expect_gone "Line 590: the end was modified" "the last change is not drawn yet"
  FIRST=$(cap | sed -n 3p)
  mouse_sgr 65 40 15 M; sleep 0.1; mouse_sgr 65 40 15 M; sleep 0.1; mouse_sgr 65 40 15 M; sleep 0.4
  [ "$(cap | sed -n 3p)" != "$FIRST" ] && pass "the wheel scrolls the diff" || fail "the wheel did not scroll the diff"
  keys G
  expect "Line 590: the end was modified" "G goes to the end of the diff"
  save diff-03-big-end
  cap >"$OUT/.c.txt"
  read -r CX CY < <(node test/smoke/cell.mjs "$OUT/.c.txt" "Line 590: the end was modified" --row-containing "+│")
  click "$CX" "$CY"
  expect "L590/600" "a click on an added row moves the cursor there"
  keys g
  keys ']' 'c'
  expect "-L3" "]c from the top goes to the first change"
  keys q q
  wait_prompt_exit 0 "q leaves the diff, q quits"
  expect_restored "diffbig"
  stop_pane

  # narrow: the drawer shows the thread of the row under the cursor
  start_pane diffn 80 30
  run_cmd "node bin/rd.js open $DIFF; echo EXIT=\$?"
  expect "rev 3/3" "opens in the narrow layout"
  keys d
  expect "diff rev 2→3" "d opens the diff"
  expect "Comments (2)" "the thread drawer stays below the diff"
  expect "no comment on the cursor line" "the cursor starts on a removed line, which has no thread"
  keys k
  expect "What makes the risk low" "k moves onto the line of t1: the drawer shows its thread"
  WIDTH=$(cap | node -e "const s=require('string-width').default??require('string-width');let m=0;for(const l of require('fs').readFileSync(0,'utf8').split('\n'))m=Math.max(m,s(l));console.log(m)")
  [ "$WIDTH" -le 80 ] && pass "no line wider than 80 columns (max $WIDTH)" || fail "line wider than 80 columns: $WIDTH"
  save diff-04-narrow
  keys '?'
  expect "HELP" "? shows the help"
  keys NPage
  expect "diff view" "…which scrolls (PageDown) to the diff keys in this small terminal"
  save diff-05-help
  keys x
  expect "DIFF" "any key closes the help and the diff view is still there"
  keys q q
  wait_prompt_exit 0 "q leaves the diff, q quits"
  stop_pane
fi

# ================================================================================================================
# 10. Channel C dialog with a fake claude: auto-open on send, [c] command, [l] leave, O, [h] headless resume
# ================================================================================================================
if want chanc; then
  echo; echo "## channel C dialog (fake claude, 120x40)"
  FAKE=$(node -e "import('./test/helpers/fake-claude.js').then((m) => console.log(m.installFakeClaude(process.argv[1]).bin))" "$OUT/fake")
  printf '{"ui":{"markdown":"source"},"delivery":{"claudeBin":"%s"}}' "$FAKE" >"$RD_HOME/config.json"
  start_pane chanc 120 40
  keys "export FAKE_CLAUDE_HOOKS='$ROOT/bin/rd.js' FAKE_CLAUDE_OUT='$OUT/fake-out.json' FAKE_CLAUDE_SLEEP_MS=2500; clear" Enter
  run_cmd "node bin/rd.js open $ENDED; echo EXIT=\$?"
  expect "rev 1/1" "a review of an ended session opens"
  expect "session ended" "the header shows the session state"
  expect_gone "O resume" "nothing is queued yet: no resume hint"
  keys j j j j
  keys c
  lit "Please add the basis for this"
  sleep 0.3
  keys Enter
  expect "session ended · feedback not delivered yet" "a send that lands on an ended session opens the dialog by itself"
  expect "[c] show resume command" "…offering [c]"
  expect "[h] resume in background and answer" "…[h]"
  expect "[l] leave for later" "…and [l]"
  expect "SESSION" "the status bar badge says SESSION"
  save chanc-01-dialog
  keys c
  expect "smoke-ended" "[c] shows the command that resumes the session (--resume <id>)"
  expect "/docs/proj" "…run in the session's directory"
  save chanc-02-command
  keys l
  expect "NORMAL" "[l] closes the dialog"
  expect "session ended · O resume" "the header now says how to get it back"
  check_eq "store: [l] leaves the feedback in the outbox" "$(RID=$ENDED node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.RD_HOME+'/reviews/'+process.env.RID+'/outbox.json','utf8')).length)")" "1"
  save chanc-03-header
  keys c
  lit "one more question"
  sleep 0.3
  keys Enter
  sleep 0.6
  expect_gone "feedback not delivered yet" "a second message joins the same batch: no second pop-up"
  keys O
  expect "2 comments queued" "O reopens the dialog"
  keys h
  expect "Session resumed in the background" "[h] starts the background resume"
  expect "resuming in background (pid" "the header follows it: running" 8
  save chanc-04-running
  expect "headless answer for t1" "the headless run answered: the answer appears in the thread card" 20
  expect "background resume finished" "the header says it finished" 10
  save chanc-05-finished
  check_eq "store: both threads got a Claude answer" "$(threads_js "$ENDED" "t.every((x) => x.messages.some((m) => m.author === 'claude'))")" "true"
  grep -q "headless-resume" "$RD_HOME/logs/headless-$ENDED.log" 2>/dev/null; [ -s "$RD_HOME/logs/headless-$ENDED.log" ] && pass "the run's log exists" || fail "no headless log"
  keys O
  expect "No feedback is waiting for delivery" "O with nothing queued explains itself"
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "chanc"
  stop_pane
  printf '{"ui":{"markdown":"source"}}' >"$RD_HOME/config.json"
fi

# ================================================================================================================
# 11. External modification: banner after 3 s, U adopts as a new revision, missing file
# ================================================================================================================
if want ext; then
  echo; echo "## external modification (120x35)"
  IDS_E=$(seed)
  EXT=$(idof "$IDS_E" doc)
  EXTFILE="$SEED_DOCS_DIR/week-45.md"
  start_pane ext 120 35
  run_cmd "node bin/rd.js open $EXT; echo EXIT=\$?"
  expect "rev 1/1" "the review opens"
  sleep 0.5
  expect_gone "modified outside" "an untouched file shows no banner"
  printf '\nA line added from outside.\n' >>"$EXTFILE"
  sleep 1.2
  expect_gone "file modified outside" "a difference is not reported before it has lasted 3 s"
  expect "file modified outside · U makes a new revision" "…and is reported after 3 s" 6
  expect "U adopt edit" "the status bar offers U"
  save ext-01-banner
  keys U
  expect "CONFIRM" "U asks for confirmation"
  expect "Make revision rev 2 from the current file" "…naming the revision it will create"
  keys n
  expect "NORMAL" "n cancels"
  check_eq "store: nothing was adopted" "$(meta_js "$EXT" "m.currentRevision")" "1"
  keys U
  keys y
  expect "New revision rev 2 created" "y adopts the file as a new revision"
  expect "rev 2/2" "the header shows the new revision"
  check_eq "store: revision 2 comes from the user (manual) and holds the external line" "$(meta_js "$EXT" "m.revisions[1].source")|$(RID=$EXT node -e "console.log(require('fs').readFileSync(process.env.RD_HOME+'/reviews/'+process.env.RID+'/revisions/002.md','utf8').includes('A line added from outside.'))")" "manual|true"
  expect_gone "file modified outside" "the banner is gone"
  keys d
  expect "diff rev 1→2" "d shows the external edit as a diff"
  expect "A line added from outside." "…with the added line"
  save ext-02-diff
  keys d
  rm -f "$EXTFILE"
  sleep 1.2
  expect_gone "file is missing" "a missing file is not reported before 3 s"
  expect "file is missing (showing the snapshot)" "…and is reported after 3 s" 6
  expect "Migrating the old store is low risk" "the snapshot is still shown"
  save ext-03-missing
  keys U
  expect "The file is missing, nothing to adopt" "U has nothing to adopt"
  keys q
  wait_prompt_exit 0 "q quits"
  stop_pane
fi

# ================================================================================================================
# 12. rd add / rd open <path> in a terminal with several candidate sessions: the candidate picker
# ================================================================================================================
if want pick; then
  echo; echo "## candidate picker (100x30)"
  PICKCFG="$OUT/claude-config-pick"
  W=$(node test/smoke/seed-writers.mjs "$PICKCFG" "$OUT/pick/one.md" "$OUT/pick/two.md" "$OUT/pick/three.md")
  NEWER=$(echo "$W" | sed -n 1p)
  OLDER=$(echo "$W" | sed -n 2p)
  start_pane pick 100 30
  keys "export CLAUDE_CONFIG_DIR='$PICKCFG'; clear" Enter
  run_cmd "node bin/rd.js add $OUT/pick/one.md; echo EXIT=\$?"
  expect "2 sessions wrote this file" "rd add in a terminal asks which session"
  expect "Write this week's store migration up as a report" "…listing the first prompts"
  expect "Summarise the migration for the team" "…of both candidates"
  expect "aaaaaaaa" "…and their session ids"
  save pick-01-list
  keys j
  sleep 0.2 # (the picker also copes with "j" and Enter arriving as one chunk; the pause just keeps the scenario deterministic)
  keys Enter
  expect "registered doc-" "Enter registers the document"
  expect "(session $OLDER)" "…bound to the session that was selected"
  wait_prompt_exit 0 "rd add exits with 0"
  expect_restored "pick"
  # cancelling registers nothing
  run_cmd "clear; node bin/rd.js add $OUT/pick/two.md; echo EXIT=\$?"
  expect "2 sessions wrote this file" "the picker again for another file"
  keys Escape
  wait_prompt_exit 1 "Esc cancels (exit 1)"
  expect_restored "pick cancel"
  # rd open <path>: the picker, then the TUI in the same terminal
  run_cmd "clear; node bin/rd.js open $OUT/pick/three.md; echo EXIT=\$?"
  expect "2 sessions wrote this file" "rd open <path> asks too"
  keys Enter
  expect "rev 1/1" "after the choice the review opens in the TUI"
  expect "Migration report" "…showing the document"
  check_eq "store: bound to the selected session" "$(node -e "const fs=require('fs');const d=process.env.RD_HOME+'/reviews';for(const n of fs.readdirSync(d)){const m=JSON.parse(fs.readFileSync(d+'/'+n+'/meta.json','utf8'));if((m.docPath||'').endsWith('three.md'))console.log(m.sessionId+'|'+m.writers.length)}")" "$NEWER|2"
  [ "$(term_flags)" = "1 1" ] && pass "the TUI has mouse reporting and the alternate screen after the picker" || fail "terminal flags after picker -> TUI: $(term_flags)"
  save pick-02-opened
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "pick open"
  stop_pane
fi

# ================================================================================================================
# 13. 80x24 (the acceptance size) and 60x20: every screen of the review fits and keeps its buttons
# ================================================================================================================
if want n80; then
  echo; echo "## narrow 80x24"
  # fresh reviews: the scenarios above approve / close the shared ones
  IDS_N=$(seed --diff --ended); DN=$(idof "$IDS_N" doc); DIFFN=$(idof "$IDS_N" diff); ENDEDN=$(idof "$IDS_N" ended)
  start_pane n80 80 24
  run_cmd "node bin/rd.js open $DN; echo EXIT=\$?"
  expect "rev 1/1" "doc opens at 80x24"
  expect "Comments (2)" "the drawer is there"
  expect_fits 80 24 "the review"
  save n80-01-open
  keys j j j j j j j j
  # At 80 columns the one-time "/review-reply" hint (a 7 s notice on an idle session) replaces the L9/27 position in the status
  # bar, so the position can take longer than the usual wait to show up.
  expect "L9/27" "j moves the cursor to line 9" 12
  expect "▌t1" "the drawer shows the thread of the cursor line"
  expect_fits 80 24 "the review with a thread in the drawer"
  # a long Chinese comment with a line break: wraps inside the box, buttons stay visible
  keys V j
  keys c
  expect "INPUT" "c opens the comment box"
  lit "这是一条很长的中文批注，用来测试输入框在八十列终端中的折行和光标位置是否正确，应该会折成两行或者更多行。"
  sleep 0.3
  keys M-Enter
  lit "Second paragraph with English words and 中文混排"
  expect "Second paragraph with English words" "text after Alt+Enter is on a new line"
  sleep 0.3
  expect_fits 80 24 "the comment box"
  BOX_W=$(cap | node -e "const s=require('string-width');const w=s.default??s;const L=require('fs').readFileSync(0,'utf8').split('\n').filter((l)=>/^[│╭╰]/.test(l));console.log(L.length>=5&&L.every((l)=>w(l)===80)?'ok':'bad:'+L.map((l)=>w(l)).join(','))")
  check_eq "every row of the box is exactly 80 columns wide" "$BOX_W" "ok"
  expect "send" "the send button is visible"
  expect "cancel" "the cancel button is visible"
  save n80-02-comment-box
  keys Escape
  expect "Discard this comment?" "Esc on a non-empty box asks"
  expect "y discard" "the confirmation keeps its buttons"
  keys y
  expect "VISUAL" "discarded: back in the selection the box was opened from"
  keys Escape
  expect "NORMAL" "Esc leaves the selection"
  sleep 0.2
  # help uses the whole area
  keys '?'
  expect "Ctrl-d / Ctrl-u" "help at 80x24"
  expect_fits 80 24 "help"
  expect_gone "Comments (2)" "help covers the drawer"
  save n80-03-help
  keys x
  expect "NORMAL" "any key closes help"
  # approve confirmation
  keys A
  expect "Approve and close this document review?" "approve asks"
  expect "y approve" "…with its buttons"
  keys n
  expect "NORMAL" "n cancels"
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "n80 doc"

  # diff view
  run_cmd "clear; node bin/rd.js open $DIFFN; echo EXIT=\$?"
  expect "rev 3/3" "diff doc opens"
  keys d
  expect "diff rev 2→3" "d shows the diff"
  expect_fits 80 24 "the diff view"
  save n80-04-diff
  keys d
  expect "NORMAL" "d returns from the diff"
  keys q
  wait_prompt_exit 0 "q quits"
  # the "session ended" dialog
  run_cmd "clear; node bin/rd.js open $ENDEDN; echo EXIT=\$?"
  expect "rev 1/1" "ended-session doc opens"
  keys c
  expect "INPUT" "c opens the box"
  lit "channel C dialog test"
  sleep 0.3
  keys Enter
  expect "feedback not delivered yet" "sending feedback for a dead session opens the dialog"
  expect "[c]" "option c"
  expect "[h]" "option h"
  expect "[l]" "option l"
  expect_fits 80 24 "the dialog"
  keys c
  expect "claude --resume" "c shows the command"
  expect "Esc close" "…and the way out stays visible"
  expect_fits 80 24 "the dialog with the command"
  save n80-05-dialog
  keys Escape
  expect "NORMAL" "Esc closes it"
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "n80 ended"
  stop_pane

  echo; echo "## narrow 60x20"
  start_pane n60 60 20
  run_cmd "node bin/rd.js open $DN; echo EXIT=\$?"
  expect "rev 1/1" "doc opens at 60x20"
  expect_fits 60 20 "the review"
  save n60-01-open
  keys j j j j j j j j
  keys V j
  keys c
  expect "INPUT" "the box opens"
  lit "六十列也要能写中文批注，折行与按钮都要正确"
  sleep 0.3
  expect_fits 60 20 "the comment box"
  expect "send" "send button"
  save n60-02-comment-box
  keys Escape
  expect "Discard this comment?" "discard question"
  keys y
  keys '?'
  expect "Ctrl-d / Ctrl-u" "help"
  expect_fits 60 20 "help"
  keys x
  keys A
  expect "y approve" "the approve question keeps its buttons at 60 columns"
  expect_fits 60 20 "the confirmation"
  keys n
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "n60"
  run_cmd "clear; node bin/rd.js; echo EXIT=\$?"
  expect "inbox" "the inbox at 60x20"
  expect_fits 60 20 "the inbox"
  expect "Enter open" "…with its main hints"
  save n60-03-inbox
  keys q
  wait_prompt_exit 0 "q quits the inbox"
  stop_pane
fi

# ================================================================================================================
# 14. $EDITOR: a real editor (vi) takes over the terminal for C / R / Ctrl+E and gives it back
# ================================================================================================================
if want editor; then
  echo; echo "## \$EDITOR (vi)"
  HAVE_VI=0
  if command -v vi >/dev/null; then
    HAVE_VI=1
    ED="vi -u NONE -N"
  else
    printf '#!/bin/sh\nprintf "%%s\\n" "Please explain the basis of this risk" >> "$1"\n' >"$OUT/ed2.sh"
    chmod +x "$OUT/ed2.sh"; ED="$OUT/ed2.sh"
  fi
  IDS_E=$(seed); DE=$(idof "$IDS_E" doc)
  start_pane editor 100 30
  run_cmd "EDITOR='$ED' node bin/rd.js open $DE; echo EXIT=\$?"
  expect "rev 1/1" "review opens"
  keys j j j j V j
  keys C
  sleep 1
  # vim shows "Press ENTER" first when the temp file path is long
  if cap | grep -qF "Press ENTER"; then keys Enter; sleep 0.4; fi
  if [ "$HAVE_VI" = 1 ]; then
    expect "# Review Desk · Comment L5-6" "C opens the editor on a file with a header"
    expect "Save and quit = send" "…explaining what saving does"
    expect "#   > This week the device table refactor" "…quoting the selected text"
    keys G o
    lit "Please explain the basis of this risk"
    keys Escape
    sleep 0.2
    lit ":wq"
    keys Enter
  fi
  expect "Please explain the basis of this risk" "the text written in the editor is sent as a comment" 8
  sleep 0.5
  check_eq "store: thread on lines 5-6 with the editor text, sent" "$(threads_js "$DE" "(()=>{const x=t[t.length-1];return [x.anchor.startLine,x.anchor.endLine,x.messages[0].text,x.messages[0].state].join('|')})()")" "5|6|Please explain the basis of this risk|sent"
  [ "$(term_flags)" = "1 1" ] && pass "mouse reporting and the alternate screen are back after the editor" || fail "terminal flags after editor: $(term_flags)"
  expect "NORMAL" "back in Normal mode"
  check_eq "the temp file is gone" "$(ls "$RD_HOME/tmp" 2>/dev/null | wc -l | tr -d ' ')" "0"
  if [ "$HAVE_VI" = 1 ]; then
    # leaving the editor without saving cancels; :cq (non-zero exit) is reported and sends nothing
    N0=$(threads_js "$DE" "t.length")
    keys j
    keys C
    sleep 1
    if cap | grep -qF "Press ENTER"; then keys Enter; sleep 0.4; fi
    lit ":q!"
    keys Enter
    expect "No changes in the editor, cancelled" "quitting vi without a change cancels"
    keys C
    sleep 1
    if cap | grep -qF "Press ENTER"; then keys Enter; sleep 0.4; fi
    lit ":cq"
    keys Enter
    expect "exited abnormally" "a non-zero exit is reported"
    expect "nothing was sent" "…and nothing is sent"
    check_eq "store: no thread was added" "$(threads_js "$DE" "t.length")" "$N0"
    # Ctrl+E inside the comment box: the box text goes to the editor and comes back
    sleep 0.3
    keys c
    lit "original box text"
    sleep 0.3
    keys C-e
    sleep 1
    if cap | grep -qF "Press ENTER"; then keys Enter; sleep 0.4; fi
    expect "# Review Desk · Comment" "Ctrl+E opens the editor with the box text"
    keys G o
    lit "appended in the editor"
    keys Escape
    sleep 0.2
    lit ":wq"
    keys Enter
    expect "appended in the editor" "the edited text is back in the box" 8
    expect "INPUT" "…which is still open"
    expect "original box text" "…with the original text kept"
    keys Escape
    sleep 0.2
    keys y
    check_eq "the temp directory is empty again" "$(ls "$RD_HOME/tmp" 2>/dev/null | wc -l | tr -d ' ')" "0"
  fi
  keys q
  wait_prompt_exit 0 "q quits"
  expect_restored "editor"
  stop_pane
fi

# ================================================================================================================
# 15. rd doctor / rd uninstall / rd gc against a throw-away CLAUDE_CONFIG_DIR (no terminal needed)
# ================================================================================================================
if want cli; then
  echo; echo "## doctor / uninstall / gc"
  CLAUDE_CONFIG_DIR=$(mktemp -d); export CLAUDE_CONFIG_DIR
  CLI_HOME=$(mktemp -d)
  rd_cli() { RD_HOME="$CLI_HOME" node bin/rd.js "$@"; }
  json_of() { node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(eval(process.argv[1]))" "$1"; }
  printf '{\n  "model": "opus",\n  "permissions": {\n    "allow": [\n      "Bash(ls:*)"\n    ]\n  }\n}\n' >"$CLAUDE_CONFIG_DIR/settings.json"
  BEFORE=$(cat "$CLAUDE_CONFIG_DIR/settings.json")
  rd_cli doctor --json >"$OUT/doctor-before.json"; CODE=$?
  check_eq "doctor before install: exit code 1" "$CODE" "1"
  check_eq "doctor before install: rd is not installed" "$(json_of "j.checks.find((c)=>c.id==='installed').status" <"$OUT/doctor-before.json")" "fail"
  rd_cli install --yes >/dev/null; CODE=$?
  check_eq "rd install --yes exits 0" "$CODE" "0"
  rd_cli doctor --json >"$OUT/doctor-after.json"; CODE=$?
  check_eq "doctor after install: exit code 0" "$CODE" "0"
  check_eq "doctor after install: hooks, timeout, wake-up watcher, permissions, /review-reply are fine" "$(json_of "['hooks','plan-timeout','watch-hooks','permissions','slash-command'].map((id)=>j.checks.find((c)=>c.id===id).status).join(',')" <"$OUT/doctor-after.json")" "ok,ok,ok,ok,ok"
  rd_cli doctor | sed 's/\x1b\[[0-9;]*m//g' >"$OUT/doctor-after.txt"
  grep -q "✓ hooks: all 6 events registered" "$OUT/doctor-after.txt" && pass "doctor prints a readable checklist (✓ hooks: all 6 events registered)" || fail "doctor text output"
  rd_cli uninstall --dry-run >"$OUT/uninstall-dry.txt"
  grep -q "rd uninstall --dry-run" "$OUT/uninstall-dry.txt" && grep -q "after uninstall" "$OUT/uninstall-dry.txt" && pass "uninstall --dry-run shows the removals and a diff" || fail "uninstall --dry-run output"
  rd_cli uninstall --yes >/dev/null; CODE=$?
  check_eq "rd uninstall --yes exits 0" "$CODE" "0"
  check_eq "settings.json is byte-for-byte what it was before install" "$(cat "$CLAUDE_CONFIG_DIR/settings.json")" "$BEFORE"
  check_eq "/review-reply is removed" "$(ls "$CLAUDE_CONFIG_DIR/commands" 2>/dev/null | wc -l | tr -d ' ')" "0"
  rd_cli doctor --json >"$OUT/doctor-gone.json"; CODE=$?
  check_eq "doctor after uninstall: exit code 1 again" "$CODE" "1"
  check_eq "uninstall twice is a no-op" "$(rd_cli uninstall --yes)" "Nothing to remove from $CLAUDE_CONFIG_DIR/settings.json."
  # project-level install
  PROJ=$(mktemp -d); mkdir -p "$PROJ/.claude"
  (cd "$PROJ" && RD_HOME="$CLI_HOME" node "$ROOT/bin/rd.js" install --yes --config-dir ./.claude >/dev/null)
  [ -f "$PROJ/.claude/commands/review-reply.md" ] && pass "install --config-dir ./.claude writes the project's .claude" || fail "project-level install"
  (cd "$PROJ" && RD_HOME="$CLI_HOME" node "$ROOT/bin/rd.js" doctor --json) >"$OUT/doctor-proj.json"
  check_eq "doctor in the project sees its settings" "$(json_of "j.checks.filter((c)=>c.group.startsWith('Claude Code project')&&c.id==='hooks').map((c)=>c.status).join(',')" <"$OUT/doctor-proj.json")" "ok"
  (cd "$PROJ" && RD_HOME="$CLI_HOME" node "$ROOT/bin/rd.js" uninstall --yes --config-dir ./.claude >/dev/null)
  check_eq "project-level uninstall leaves no hooks behind" "$(node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('$PROJ/.claude/settings.json','utf8'))))")" "{}"
  # gc
  GC_IDS=$(RD_HOME="$CLI_HOME" node test/smoke/seed.mjs)
  GC_DOC=$(idof "$GC_IDS" doc)
  RD_HOME="$CLI_HOME" node bin/rd.js close "$GC_DOC" >/dev/null
  RD_HOME="$CLI_HOME" node -e "const fs=require('fs');const f=process.env.RD_HOME+'/reviews/$GC_DOC/meta.json';const m=JSON.parse(fs.readFileSync(f));m.updatedAt=new Date(Date.now()-45*864e5).toISOString();fs.writeFileSync(f,JSON.stringify(m))"
  check_eq "gc --dry-run lists the old closed review and deletes nothing" "$(rd_cli gc --dry-run | grep -c "$GC_DOC")|$([ -d "$CLI_HOME/reviews/$GC_DOC" ] && echo kept)" "1|kept"
  CODE=$(rd_cli gc </dev/null >/dev/null 2>"$OUT/gc-noyes.txt"; echo $?)
  check_eq "gc without a terminal and without --yes refuses" "$CODE" "1"
  grep -q -- "--yes" "$OUT/gc-noyes.txt" && pass "…and says to pass --yes" || fail "gc refusal message"
  rd_cli gc --yes >/dev/null
  [ ! -d "$CLI_HOME/reviews/$GC_DOC" ] && pass "gc --yes deleted it" || fail "gc --yes did not delete the review"
  unset CLAUDE_CONFIG_DIR
  rm -rf "$PROJ" "$CLI_HOME"
fi

echo
echo "smoke: $((CHECKS - FAILS))/$CHECKS checks passed (captures in $OUT)"
[ "$FAILS" -eq 0 ]
