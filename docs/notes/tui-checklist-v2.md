# TUI v2 checklist — verified 2026-10-02 via tmux against a real standalone TUI

Environment: `opencode2 --standalone` in tmux (200x50), isolated
XDG_CONFIG_HOME (staged plugin), shared production board data — navigation
verified read-only against the real board.

| Check | Result |
|---|---|
| Plugin loads; "Open jazz dashboard" in palette (ctrl+j) | ✅ (palette entry confirmed; raw C-j from tmux send-keys did not register — palette path used) |
| Dashboard: 3 panes (inbox · cron · board summary) | ✅ |
| Board summary lists all 9 lanes with counts + top card | ✅ |
| Footer: unread count + registry size (250) | ✅ |
| `k` kanban full view: 9 columns, focus marker, per-lane counts | ✅ |
| `h`/`l` on an empty selected lane shifts focus (no card moved) | ✅ (added during this pass — v1 could not reach lanes from an empty lane) |
| Card detail (`return`): title, priority badge, profile, assignments, comments, history pane | ✅ |
| History shows live moves + `backfilled from v1` migration entry on the pre-v2 card | ✅ (production board migrated in place) |
| Verdict keys gated: non-review/failed lane shows "verdict keys apply from review…" | ✅ |
| `i` inbox / `c` cron full views render | ✅ (render verified; interactive ack/run keys not driven — RPC paths covered by integration) |
| Card create dialog with priority (n) | not driven this pass (RPC path integration-verified; v1 dialog path unchanged) |
| Review decide a/x/r from TUI | not driven this pass (review.decide verified 6/6 via integration on real serve) |

## Incident during verification

A batched `l l l l l` against the production board raced the refresh and
moved one real card backlog→ready; reverted immediately via the production
RPC (history records both moves — e5e29f89). Lesson recorded: drive the TUI
against a scratch board for mutation checks.

## Note on standalone topology

`--standalone` shares the production data dir even with isolated
XDG_CONFIG_HOME — the TUI renders the REAL board. Fine for read-only checks;
use the integration harness for mutation tests.
