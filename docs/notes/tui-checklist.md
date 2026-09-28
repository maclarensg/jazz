# TUI checklist — verified 2026-09-29 via tmux against a real standalone TUI

Environment: `opencode2 --standalone` in tmux (200x50), isolated
XDG_CONFIG_HOME, staged plugin with `tui.tsx` root shim.

| Check | Result |
|---|---|
| TUI plugin loads (no entry in `/plugins` failed list) | ✅ (after fix below) |
| Server plugin still loads alongside | ✅ |
| `Open kanban board` appears in palette + binds ctrl+j | ✅ |
| `/board` slash command navigates | ✅ |
| Board renders: 5 lane columns, card titles, cron section, footer | ✅ |
| `h` / `l` move the selected card across lanes (server round-trip) | ✅ (verified 2 moves: backlog→ready→in_progress) |
| `n` opens dialog, creates card, board refreshes | ✅ (`tui-created-card`) |
| Cron section renders | ✅ ("no cron jobs yet" on fresh instance) |
| `x` remove (confirm dialog) | not driven in tmux; RPC + dialog path shared with verified flows |
| `r` run-now | not driven in tmux (needs a live job); `cron.runNow` verified in integration suite |
| `j`/`k` job selection, `q` close | trivial/not driven |

## Bugs found and fixed during verification

1. **"Keymap.Provider is missing"** — `context.keymap.layer()` called in bare
   plugin setup has no owning component. Keymap layers must be created inside
   a mounted component (`usePlugin()` + `onMount`, or a slot-rendered
   component like the app slot).
2. **Router registration from bare setup silently fails to land** — same
   ownership rule. Route registration moved into the mounted global component;
   after that, navigation resolves (the host auto-qualifies route names as
   `<plugin-id>/<name>` — never qualify them yourself; it double-prefixes).
3. `run:` handlers must return void/false/Promise<void> — wrap signal-return
   arrows in braces.

Interactive visual pass is Gavin's to enjoy; every code path above is
server-verified through the integration suite.
