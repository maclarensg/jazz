# opencode-jazz — design

**Status**: historical v1 design; original proposal status retained in git history
**Target runtime**: OpenCode V2, local binary `opencode2` v2.0.9
**Date**: 2026-09-28

**Current authority (2026-10-05):** [factory-orchestrator.md](factory-orchestrator.md)
supersedes this document's card lanes, automatic completion/failure moves,
assignment/session ownership, and scheduling/recovery semantics. Generic
cron/board separation and package boundaries remain architectural background.
The v1 plan records its original agreement; this file is not the current
execution contract or evidence that the target factory is implemented.

## What it is

An OpenCode V2 plugin package that adds two capabilities to the backend:

1. **Kanban board** — durable card/lane state, agent-facing tools, custom RPC
   for external clients, and a TUI board view.
2. **Cron scheduler** — generic scheduled jobs: `prompt + schedule → fresh
   session`. The scheduler knows nothing about cards.

Plus the composition that makes it more than the sum: sessions can be bound
to cards, and session lifecycle events move cards. The closed loop, with the
scheduler kept deliberately dumb.

## Approaches considered

| | Approach | Verdict |
|---|---|---|
| A | **Single package, two exports** — `.` (server plugin) + `./tui` (CLI plugin), one deploy | **Chosen** |
| B | Two packages — server in `opencode.json` plugins, TUI in `cli.json` | Cleaner separation, doubles packaging/maintenance for V1; splitting later is mechanical (exports are already separate files) |
| C | Fork opencode core, build kanban+cron natively | Rejected: V2's plugin API (tools, RPC, storage, events, sessions, timers-in-setup) covers every need; a fork is a permanent maintenance tax and upstream drift |

## The load-bearing decision: decoupled modules, one narrow link

Gavin's scope call ("full vision") + semantics call ("generic prompt cron
only") resolve into this:

```
┌─────────┐  fires    ┌──────────┐
│  cron   │──────────▶│ session  │   cron: {name, cron, prompt, agent?}
└─────────┘           └────┬─────┘   knows NOTHING about cards
                           │ lifecycle events
┌─────────┐  moves    ┌────▼─────┐
│  board  │◀──────────│   link   │   link: sessionID → cardID
└─────────┘           └──────────┘   knows NOTHING about cron
```

- **cron** — a job is `{id, name, cronExpr, prompt, agent?, model?, enabled,
  lastRun, nextRun}`. Fires into a fresh session via
  `ctx.session.create` + `ctx.session.prompt`. Full stop.
- **board** — cards `{id, title, lane, order, created, updated}`, lanes
  default `backlog / ready / in_progress / review / done` (plugin options).
- **link** — the only coupling point. A `kanban_work(cardID, prompt)` tool
  creates a session bound to a card → card moves to `in_progress`; on session
  completion/failure events the card moves to `done`/`blocked` and the link
  is dropped.
- **Composition**: scheduled card work happens when a cron job's *prompt*
  tells the agent to pull a card and call `kanban_work`. The scheduler never
  learns about cards; agents compose the two.

## Module map (single package)

```
opencode-jazz/
├── src/
│   ├── index.ts        # server plugin: setup, wiring, options
│   ├── board.ts        # pure board logic (mutations over state, no I/O)
│   ├── cron.ts         # cron math + tick loop + fire logic
│   ├── link.ts         # session↔card registry + transition rules (pure)
│   ├── storage.ts      # ctx.storage wrappers, key layout
│   ├── rpc.ts          # Rpc.define: methods + events
│   ├── tools.ts        # kanban_* tool definitions
│   └── tui.tsx         # CLI plugin export (./tui): board route, /board
├── test/
│   ├── board.test.ts   # unit: pure logic
│   ├── cron.test.ts    # unit: next-run math, catch-up decisions
│   ├── link.test.ts    # unit: transition rules
│   └── integration/    # boots real `opencode2 serve`, asserts over HTTP
└── docs/design/design.md
```

**Stack**: TypeScript ESM, no bundler (opencode loads `.ts`/`.tsx` sources
directly — docs examples, and local precedent in `~/.config/opencode/plugins/`).
Deps: `@opencode/plugin`, `croner` (cron parsing), `zod` (schema validation,
matches farsight-v2's local convention). TUI peers: `@opentui/core`,
`@opentui/solid`, `solid-js`.

**Persistence** — `ctx.storage` only, no own DB file:

| Key | Content |
|---|---|
| `board/state` | whole board doc (homelab scale: whole-doc rewrite per mutation is fine) |
| `cron/jobs` | job list |
| `cron/runs` | ring buffer, capped at 100 |
| `link/session/<sessionID>` | `{cardID, startedAt}` |

Server is single-process; mutations serialize through one module instance.

**Cron execution model** — 15s tick loop checking `nextRun <= now`
(drift-proof, simpler than per-job timers); `croner` computes next-run.
Catch-up on startup: jobs whose `nextRun` passed while down fire once
(configurable: `fire-missed` default | `skip-missed`). Run log: capped ring
buffer, visible via RPC.

## V1 TUI (real, minimal)

- Route `jazz`: lane columns, cards; `h/l` move card between lanes, `n` new
  card dialog.
- Cron section in same route: jobs, next fire time, `r` run-now.
- Slash command `/board` + palette entry; live updates via
  `events.on("jazz.card.moved")`.
- State via RPC subclient (`context.client.rpc(Jazz)`), not direct storage.

## Verification strategy

The API is server-side TypeScript, so the split is:

- **Unit (vitest)** — pure logic: cron next-run math, catch-up decisioning,
  board mutations, link transition rules. Red→green per module.
- **Integration (real system)** — script boots `opencode2 serve` in a scratch
  project with the plugin loaded from this repo, then asserts over HTTP:
  - RPC round-trip with an unpredictable nonce card title (nothing guessable
    counts as proof),
  - a `* * * * *` job fires and creates a **real session** (verified via API),
  - `kanban_work` moves a card to `in_progress`; completion moves it to `done`.
- **TUI** — launched against the real serve instance; manual checklist.

## Known risks / open verifications

1. **Session lifecycle event names** — the exact server event shapes
   (completed/error/idle) must be verified against `/openapi.json` of the
   running v2.0.9 server at implementation time, not assumed from docs prose.
   First task of the link module.
2. **Scheduler double-instance** — plugins load globally; a dev `serve`
   instance alongside the daily shared service would mean two schedulers.
   Mitigation: leader lease in `ctx.storage` (heartbeat + expiry); a second
   instance stands down. Variant to test: start two servers pointed at the
   same brain, exactly one fires.
3. **Permission walls** — scheduled headless runs stall on prompts.
   Pre-authorized agent/scope rules are a deployment concern, documented in
   the runbook.

## Deployment

- **Dev/test**: plugin loaded from this repo into a scratch project's
  `opencode.jsonc` → `opencode2 serve` → integration suite.
- **Daily use**: symlink `~/.config/opencode/plugins/jazz → this repo`
  (matches existing local convention) — loads into the shared background
  service Gavin already runs.
- **24/7 later**: `opencode2 serve` under a systemd user unit, all clients
  `--server http://127.0.0.1:4096`. Catch-up logic covers restarts.

## Milestones (each: red → green → commit)

1. Scaffold + pure `board.ts` module + unit tests
2. Server plugin wiring: tools + RPC + storage — integration test vs real
   serve (nonce round-trip)
3. Cron module: math + tick + fire→real session + catch-up + leader lease
4. Link automation: `kanban_work` + lifecycle events → card moves
   (integration)
5. TUI: board route + `/board` + move/create + cron panel
6. Deployment: symlink + README runbook (permissions, topology)
7. Brain decision record + close
