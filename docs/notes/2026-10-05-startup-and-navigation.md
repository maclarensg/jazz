# Startup and inbox navigation corrections

## Missing lanes on a fresh board

A fresh board must expose all nine canonical lanes, not an empty lane map.
The watchdog change at `62a1e09` introduced duplicate `cronService` and
`instanceID` declarations inside plugin setup. OpenCode rejected the server
plugin before it registered `jazz`; the dashboard's refresh then failed with
`rpc.unavailable` and left its board signal unset.

The repair removes only the later duplicate declarations, preserving the
watchdog's earlier initialization. The new entrypoint unit test imports the
actual root `index.ts`, rather than only exercising helper modules. It was
observed failing with both duplicate-symbol errors before the repair. A new
real-server integration assertion checks the pristine board and empty cron
list before creating a card.

Verification:

- Original shared-service location: plugin active; all five dashboard RPCs
  succeeded; board returned nine empty lanes and zero cards.
- Main's real shared-service TUI at 120 columns rendered all nine lane
  headers and `(empty)` placeholders, plus the honest empty cron message.
- Independent isolated QA: board, inbox and review integration suites
  **19/19**; one additional fresh-state/nonce probe **1/1**.
- Independent QA observed all nine headers at 120 and 80 columns. At 80
  columns the `(empty)` placeholder clips, but headers remain readable.

Plugin loading is separate from persisted-data recovery. No previous cards
or cron jobs were recreated by this repair.

## Inbox-to-cron shortcut collision

The inbox used `c` to clear a notification and disabled `jazz.cron` there,
while the shared footer advertised `c cron`. This made navigation misleading
and capable of removing an inbox item instead of switching views.

Gavin selected consistent pane navigation and separate removal shortcuts:

| Key | Action |
| --- | --- |
| `i` | Inbox |
| `c` | Cron, including from inbox |
| `k` | Kanban |
| `d` | Dashboard |
| `x` in inbox | Clear selected notification |
| `X` in inbox | Clear all, retaining the existing confirmation dialog |

This supersedes the inbox `c`/`C` bindings described in the historical v3.1
checklist. Kanban `x` removal and detail `X` cancellation remain view-scoped;
the existing modal-input guard still disables dashboard shortcuts during
dialogs.

The declaration-level regression checks actual TUI command expressions.
Before the fix it failed because cron was disabled in inbox and the clear
binding was `c` rather than `x`. Afterwards, **175 unit tests** and
typechecking passed. Main verified actual shared-service TUI navigation
`i → c → k → i → d` and the corrected inbox hints without sending removal
keys against production data.

Independent follow-up QA passed one real-TUI driven-system test with two
nonce notifications in a private store. Inbox `c` switched to cron without
changing either notification; `x` removed exactly the selected notification
and left both underlying cards intact. `X` opened the confirmation dialog,
and cancelling retained the remaining notification. The updated stage and
repository TUI hashes matched; all owned private processes were cleaned up.
Affirmative `X` submission was not driven in this follow-up; confirmation
opening and cancellation were exercised.
