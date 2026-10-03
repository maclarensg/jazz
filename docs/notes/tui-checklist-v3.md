# TUI v3 kanban pass — verified 2026-10-02 via tmux against a real standalone TUI

Trigger: Gavin's feedback — board too plain, must fill the screen, lane titles
must be visible, lane navigation arrow-only with a highlighted selected lane.

## What changed (src/tui.tsx)

- **Fill screen**: root Dashboard box gets `height: "100%"` (the missing piece —
  `flexGrow` alone did nothing because the router host gives the page root no
  definite height). Lane columns use `flexGrow: 1, flexBasis: 0` → exactly equal
  columns, no trailing gap (old `floor(100/9)%` left one).
- **Lane titles**: opentui *drops* a box `title` entirely when it doesn't fit
  (empirically: 150 cols → 5 of 9 titles gone; 120 cols → all gone). Titles now
  render as a header line inside each column (`TRI·2`, `INPR·1`, ≤4-char keys),
  `wrapMode="none"` so they never wrap. The full selected lane name lives in the
  root title bar (`jazz — kanban ▸ in_progress (2) · 6 cards total`) — always
  full-width, always visible.
- **Arrow-only navigation**: `←`/`→` select lane, `↑`/`↓` select card
  (also inbox/cron lists). Selection is pure state — no RPC, so navigation can
  never mutate a board (the e5e29f89 race class). Card moves moved to
  `shift+h`/`shift+l`.
- **Highlight**: selected lane = green (#7ee787) border + header; unselected =
  dim #30363d border. Verified in ANSI capture (RGB 126;231;135 vs 48;54;61).
- Card lines: priority colors kept, `!` prefix for p0/p1, `*` for assigned
  profile, ellipsized titles (16), `wrapMode="none"`.

## Bug found & fixed: uppercase binds never fired

opencode's bind parser expects `shift+<lowercase>` (binary strings show
`shift+tab`, `shift+left`). Bare `"H"` never matches a shifted key event — so
**every uppercase bind in the v2 keymap was dead on arrival** (`K` prev card,
`X` cancel, `R` requeue, `C` comment, `M` ack-all, `N` new job). All converted
to `shift+` form. The v2 checklist's "inbox ack / cron keys not driven" hid
this. Verified live: `shift+l`/`shift+h` move a card round-trip with selection
following; `shift+n` opens the cron-job dialog.

## Verification matrix (scratch board, tmux)

| Check | Result |
|---|---|
| 120 cols: all 9 lane headers visible | ✅ `TRI·2 … CNCL·0` one line each |
| 80 cols: all 9 lane headers visible | ✅ (card titles hard-clip at 6-char columns — inherent) |
| 200 cols: equal columns, no gap, ellipsized titles | ✅ |
| Columns fill terminal height | ✅ (root `height:"100%"`) |
| `←`/`→` move lane selection, highlight follows | ✅ ANSI-verified green border+header |
| `↑`/`↓` card selection within lane | ✅ `▸` marker moves |
| `shift+l` / `shift+h` move card, selection follows | ✅ triage→backlog→triage round-trip, history records both |
| `shift+n` cron dialog opens | ✅ |
| Detail view / dashboard / inbox / cron regressions | ✅ |
| Production board untouched | ✅ read-only DB check: still 1 card (e5e29f89) |
| Unit / integration suites | ✅ 97/97, 22/22 (model tests green again — quota window reset) |

## Scratch-board technique (new, replaces "mutation tests impossible" note)

`opencode2 --standalone` shares `~/.local/share/opencode/opencode.db` — that is
why v2 concluded standalone always sees production data. Isolate
**`XDG_DATA_HOME`** as well and the standalone gets a fresh DB:

    XDG_CONFIG_HOME=/tmp/opencode/jazz-it/xdg \
    XDG_DATA_HOME=/tmp/opencode/jazz-scratch \
    opencode2 --standalone

Seed cards by writing `plugin:<utf-16be-hex("opencode-jazz")>:board/state`
into `<XDG_DATA_HOME>/opencode/opencode.db` table `kv` (note: utf-16**be** —
the LE encoding writes a key nothing reads). Board shape = `{cards, lanes}`;
`validateBoard` requires id/title/lane/created/updated, migration backfills
the rest.

Caveats: burst `tmux send-keys` strings race the TUI (dropped/duplicated
chars in dialogs and palette filter — type per-char with delays); the command
palette only lists `palette: true` commands, so keymap-only commands can't be
palette-driven.

---

# v3.1 — inbox clear + lane archive (2026-10-02, same day)

Gavin's ask: (1) `c` / `C` clear one / clear all in the inbox; (2) done and
cancelled lanes get an archive that stashes their cards separately.

## What changed

- **Inbox clear** — new RPC `inbox.clear`/`inbox.clearAll` (+ pure
  `removeNotification`/`clearNotifications`), returning `{cleared, unread}`.
  Clear REMOVES from the list; `m`/`M` ack (mark read) unchanged. `c` is
  cron-switch everywhere except inside the inbox view, where it clears the
  selected notification; `C` (shift+c) clears all behind a confirm dialog.
- **Archive** — `board.archiveLane` (lane must be done|cancelled → else
  `not_archivable`; unknown lane → `unknown_lane`) stashes every card into a
  separate `board/archive` kv doc `{order, cards}` with `archivedAt` stamped
  per card, history entry `archived from <lane>`, newest-500 cap
  (`ARCHIVE_CAP`), board+archive written under the board service's one
  serialized step. `archive.get` lists the archive; one inbox notification per
  archive action. TUI: `A` (shift+a) on a done/cancelled lane, confirm dialog,
  toast with counts; kanban title bar shows `· N archived`.
- Archive loads are defensive: a corrupted archive doc loads as empty — the
  stash must never brick the board (storage.test.ts).

## Live verification (scratch board, tmux)

| Check | Result |
|---|---|
| `c` in inbox clears selected; view stays inbox (no cron switch) | ✅ toast `cleared: archived`, list shifts |
| `C` clears all behind confirm | ✅ toast `cleared 3 notifications`, inbox (0) |
| `shift+l` ×2: review → done → cancelled | ✅ selection follows |
| `A` on cancelled: confirm → lane empties, toast `archived 1 cards (archive: 1)` | ✅ |
| kv ground truth: board/archive `{order:[dn1]}`, archivedAt, history `archived from cancelled`; board cancelled `[]`, dn1 gone from cards | ✅ |
| Kanban title: `jazz — kanban ▸ cancelled (0) · 5 cards total · 1 archived` | ✅ |
| Suites: unit 112/112 (+15), integration 26/26 (+4), typecheck clean | ✅ |
| Production untouched (read-only DB compare) | ✅ |

Known artifact (pre-existing, opencode dialog input): under tmux driving, a
single Enter sometimes leaks through a confirm/prompt dialog to the base
keymap (opens card detail) instead of submitting; a repeated Enter confirms.
Observed on both the new dialogs and the v2 new-card dialog. Interactive use
should be unaffected; flagged for an upstream look if it reproduces by hand.

## v3.2 — dispatcher (2026-10-02, afternoon)

| Check | Result |
|---|---|
| Planner unit tests red→green (lane pick, open-assignment skip, cooldown, maxInFlight union semantics, priority/age order, disabled, empty lane) | ✅ 8/8 — caught the cap-counts-all-open-assignments design gap before wiring |
| `JAZZ_DISPATCH=0` env kill-switch; harness opts every integration server out by default, dispatcher test opts in | ✅ |
| Dispatcher integration (real serve, real session): ready card picked up ≤ tick+slack, assignment recorded | ✅ 16.7s |
| Full unit 120/120, typecheck clean | ✅ |
| Integration full run first attempt: link test timed out under file parallelism (two model-heavy suites spawning GLM sessions concurrently; stream stalled past 120s wall). Isolated rerun: 3/3 in 6s → code fine, runner the problem | `--fileParallelism false` on test:integration → 27/27 serial |
| **Production live smoke**: card `2ed0788b` created → ready at 15:45:15Z; dispatcher picked it up ≤10s (in_progress, profile `worker`, assignment 15:45:25Z); worker ran, `submit_review` by t+25s with report comment; full autonomous loop dispatch→work→review with zero human input | ✅ |
| Post-smoke board state: review holds `2ed0788b` (Gavin's `x`) + `e3d66282` (BUY_T2 verdict); ready empty; no unintended dispatches (triage/review not dispatchable) | ✅ |

Lesson: model-heavy integration files must run with `--fileParallelism false`
— parallel real-LLM sessions contend for the provider pool and stall, which
masquerades as a code regression. Runner fix, not retry-on-flake.

## v3.3 — `p` comment + review verdict pane (2026-10-03)

| Check | Result |
|---|---|
| `p` on selected card in board view → comment dialog targeting the SELECTED card ("Comment on t2") | ✅ |
| Posted comment lands in kv (`t2 ← gavin: "fuzz"`) and board refreshes | ✅ |
| `p` in card detail opens the same dialog (`shift+c` alias kept) | ✅ |
| Review-lane card detail renders amber verdict pane: `a mark done · X cancel (→ cancelled) · R requeue to triage (rework — post a comment first: p)` | ✅ (multiple captures) |
| `R` from pane-visible detail: rv1 review→triage, toast `rv1 → triage`, kv history `review→triage` | ✅ |
| `a` accept: rv1 review→done, kv history + inbox notification (fired during an Enter-leak; same decide() path) | ✅ |
| `X` cancel: same decide() path as R/a; interactive drive defeated by the documented tmux keypress/dialog races — one deliberate press in production TUI closes it | ⏳ code-path shared, not keyed |
| typecheck clean, unit 120/120 | ✅ |

New scratch-environment lessons (cost real time — record them):
1. **`ctrl+j` is undeliverable through `tmux send-keys`** — C-j IS byte 0x0a
   (Enter) on a legacy terminal; only the kitty keyboard protocol
   distinguishes them and send-keys can't emit it. Enter the board via the
   `/board` slash command inside a session instead.
2. **The CLI-side plugin does NOT auto-load from the plugins dir scan** the
   way the server side does. Scratch config needs
   `~cli.json → {"plugins": ["<abs path to staged plugin>"]}` — without it
   the slash palette says "No matching commands" even though the server log
   shows the plugin loading. With it, `/board` works.
3. Launch standalone TUIs from a NEUTRAL cwd (`cd /tmp/opencode`), or the
   project config/plugins of wherever you were leak in.
4. Keymap layers stay live under prompt dialogs: typed text containing
   bound letters (e.g. `n`) fires those binds mid-dialog. Type bind-free
   text when driving dialogs (e.g. `fuzz`).
5. List-view lane moves log actor `system`, not `gavin` (moveSelected passes
   no actor) — pre-existing; distinguishable from dispatcher moves only by
   the assignments field.
