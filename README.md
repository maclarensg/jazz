# opencode-jazz

Kanban board + cron scheduler for OpenCode V2 — one plugin package, three
decoupled modules (board, cron, link), served from the OpenCode backend.

- Design: [`docs/design/design.md`](docs/design/design.md)
- Task plan: [`docs/design/plan.md`](docs/design/plan.md)
- Target runtime: `opencode2` v2.0.9 (OpenCode V2 plugin API)

## Status

Implemented and verified: board (tools + RPC + TUI), cron scheduler
(catch-up + leader lease), link automation (card-bound sessions).
Integration suite: 13 tests against a real `opencode2 serve`.

## Deploy (shared background service — default)

```bash
scripts/deploy-symlink.sh
```

Symlinks this repo into `~/.config/opencode/plugins/jazz`. Activates at the
next OpenCode server start — from inside a session, restart the service
EXTERNALLY (`opencode service restart`); restarting from inside kills the
session.

## Deploy (dedicated 24/7 server — optional)

See [`docs/deploy/opencode-jazz.service`](docs/deploy/opencode-jazz.service).
Run ONE server, not both topologies at once.

## Using it

Agents get tools: `kanban_create_card`, `kanban_move_card`, `kanban_list_cards`,
`kanban_remove_card`, `kanban_work` (start a session working a card).

Scripts/clients get the `jazz` RPC over HTTP (`{"input": ...}` body shape):

```
board.get · card.create · card.move · card.remove · card.work
cron.upsert · cron.list · cron.remove · cron.runNow · cron.runs
link.get · link.list
```

Events: `jazz.card.moved`, `jazz.cron.fired`, `jazz.cron.failed`.

The TUI: `ctrl+j` or `/board` — lane columns, h/l move, n new, x remove,
tab to the cron section, r run-now.

## Cron jobs

Jobs are `{name, cronExpr, prompt, agent?, enabled}` — generic prompt cron.
A job fires into a fresh session; the scheduler knows nothing about cards.
Scheduled card work is composition: the job's prompt tells the agent to pull
a card and call `kanban_work`.

Plugin options (opencode.jsonc):

```jsonc
{
  "plugins": [{ "package": "jazz", "options": { "catchup": "fire-missed" } }]
}
```

- `catchup: "fire-missed"` (default) — jobs missed while the server was down
  fire once at startup.
- `catchup: "skip-missed"` — skip, just reschedule.

## Permissions

Scheduled runs are headless. Pre-authorize the agent that jobs use, or they
stall on permission prompts nobody will answer.

## Ground truth notes

- [`docs/notes/serve-auth.md`](docs/notes/serve-auth.md) — HTTP auth (Basic,
  `opencode:<password>`), plugin scan contract (root `index.*`), project-local
  scan absent on v2.0.9
- [`docs/notes/session-events.md`](docs/notes/session-events.md) — lifecycle
  event names/payloads, live-verified
- [`docs/notes/cron-debug.md`](docs/notes/cron-debug.md) — the harness
  SIGKILL saga and the re-entrant mutex, both real bugs, both fixed
  structurally
- [`docs/notes/tui-checklist.md`](docs/notes/tui-checklist.md) — TUI
  verification via tmux; component-ownership rules for keymap/router
