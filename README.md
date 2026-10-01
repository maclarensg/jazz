# opencode-jazz

Kanban board + cron scheduler + subagent orchestrator for OpenCode V2 — one
plugin package, six decoupled modules (board, cron, link, inbox, profiles,
routing), served from the OpenCode backend. Gavin's review lane is the verdict
gate; Laya routes cards to 250 imported+soul profiles.

- Design v2: [`docs/design/v2-orchestrator.md`](docs/design/v2-orchestrator.md) (v1: [`design.md`](docs/design/design.md))
- Target runtime: `opencode2` v2.0.9 (OpenCode V2 plugin API)

## Status (v2, 2026-10-02)

Implemented and verified: 9-lane board with rich cards (priority, details,
comments, assignment chain, capped history), inbox notifications, 250-profile
registry (import pipeline + soul roles), Laya routing log + candidate
prefilter, handoff loop with exit-semantics guards, review gate
(accept/cancel/requeue), 3-pane dashboard TUI with i/c/k full views.
Unit 97/97; integration 22 tests against real `opencode2 serve`
(model-dependent tests require a healthy model pool — see Known gaps).

## The 9 lanes

`triage → (backlog) → ready → in_progress → blocked/failed → review → done | cancelled`

- Intake lands in **triage**; a triage agent routes it (Laya) → profile set → **ready**
- `kanban_work` starts a profile-persona session → **in_progress**
- Worker finishes: `kanban_submit_review` → **review** · `kanban_handoff` → next profile, back to **ready**
- Session exits without submitting → **ready**; twice in a row or session failure → **failed**
- **review** and **failed** are Gavin's: `review.decide` accept → **done**, cancel → **cancelled**, requeue → **triage**

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

Agents get `kanban_*` tools:

```
create_card · intake (files to triage) · move_card · list_cards · remove_card
assign (Laya routing output, records decision) · routing_candidates (top-16 prefilter)
work (profile-persona session) · comment · submit_review · handoff · block
```

Scripts/clients get the `jazz` RPC over HTTP (`{"input": ...}` body shape):

```
board.get · card.create/move/remove/comment · card.work · link.get/list
inbox.list/ack/ackAll · review.decide (accept|cancel|requeue) · routing.log
profiles.list/stats · cron.upsert/list/remove/runNow/runs
```

TUI (`ctrl+j` or `/board`): 3-pane dashboard; `i` inbox, `c` cron, `k` kanban
full views; card detail with history/comments/assignments; on review (or
failed) lanes the card detail carries the verdict keys (a accept · x cancel ·
r requeue) and `C` comments.

## Profile registry

250 profiles: 238 curated from public collections (quality-gated: description
20–200 chars stating when to use, body ≥ 20 lines; balanced across 12
canonical categories) + 12 NeoLilith soul roles (native). Refresh:

```bash
scripts/import-profiles.sh          # curated 240 + soul roles
scripts/import-profiles.sh --all    # full corpus, cap 1000
```

Laya routing (2-stage, ≤16 options each): stage 1 category, stage 2
`routing_candidates` keyword prefilter → choice. The triage agent runs
`core.jev_laya` from the soul repo (`uv run python -m core.jev_laya --spec -`)
and reports via `kanban_assign`. Every decision lands in `jazz/routing`;
review verdicts stamp outcomes — the calibration loop.

## Tests

```bash
npm test                        # 97 unit (incl. counted registry assertions)
npm run test:integration        # real opencode2 serve (see Known gaps)
JAZZ_TEST_MODEL=zai-coding-plan/glm-5.3-flash npm run test:integration  # model override
```

## Known gaps (2026-10-02)

1. **Model-pool dependency** — `link.integration` (v2 exit semantics) and
   `session.probe` need live model credits. The Z.AI plan's session pool was
   exhausted late 2026-10-01 (50.7M tokens/24h); the v2 link flow's green
   evidence is the 00:10Z run (9/9) before exhaustion. Re-run after the 5h
   window resets. `JAZZ_TEST_MODEL` overrides the staged config's model, but
   flash alone did not complete worker sessions (preamble-heavy prompts).
2. **TUI interactive pass** — dashboard/kanban/detail/verdict-gating verified
   in tmux; inbox ack keys and cron e/r/N keys not driven (RPC paths
   integration-verified). See `docs/notes/tui-checklist-v2.md`.
3. **Native personas** — soul roles flagged `native: true`; imported profiles
   are prompt-composed. Materializing curated imports as `.opencode/agent/`
   definitions is future work (hybrid personas, design §5).


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
