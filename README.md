# opencode-jazz

Kanban board + generic cron scheduler + profile-worker dispatch for OpenCode V2 —
one plugin package, six decoupled modules (board, cron, link, inbox, profiles,
routing), served from the OpenCode backend. The intended factory keeps Gavin's
final verdict separate from agent execution and NeoLilith's evidence review.

- **Current target contract:** [`docs/design/factory-orchestrator.md`](docs/design/factory-orchestrator.md)
- Historical designs: [`v2-orchestrator.md`](docs/design/v2-orchestrator.md), [`design.md`](docs/design/design.md)
- Target runtime: `opencode2` v2.0.9 (OpenCode V2 plugin API)

## Status (2026-10-05): components exist; the target factory is not complete

Shipped components include the 9-lane board, rich cards, inbox, 250-entry
profile registry, routing log/candidate prefilter, fresh worker sessions,
ready-card dispatch, handoff tools, verdict RPC, and dashboard TUI. The
startup/navigation repair was verified separately; its exact checks and limits
are in [`docs/notes/2026-10-05-startup-and-navigation.md`](docs/notes/2026-10-05-startup-and-navigation.md).

The factory review found **no built-in automatic NeoLilith triage, backlog
admission, bounded failed rework, or once-per-cycle NeoLilith reviewer**.
Current dispatch capacity counts open assignments, not confirmed running
executions. Generic move/create surfaces do not enforce a human-only final
verdict. The registry's 12 native entries also differ from the live runtime's
available soul roles; registry membership is not proof of an executable agent.
See the target contract's evidence ledger and acceptance matrix before treating
this as an end-to-end autonomous factory.

### Experimental execution foundation (nonexecuting)

This checkout adds a pure execution-state reducer, a strict one-envelope store
contract, and an **opt-in, read-only foundation branch**. It is not a deployed
execution controller. Omitted `factory` options preserve the legacy behavior
described below, including its known authorization and stop-accounting gaps.

The foundation branch (`factory: { mode: "foundation" }` in the plugin setup
options) returns before legacy dispatcher/cron/event-pump initialization. It
denies **all** mutations and execution requests, including intake, comments,
verdicts, requeues, archive/removal, cron firing and inbox changes. There is no
public claim, stop-receipt, settlement or budget-grant API. `factory.status`
reports missing ownership, managed-child-stop and human-authority prerequisites;
retained held executions remain `unknown` on diagnostic recovery. Unknown or
corrupt inventory is explicitly unavailable, not an empty pool.

**Do not turn this on in the daily service or use it as a hot-reload security
boundary.** The verified route is the fresh isolated test deployment below,
which injects these setup options; configuration-loader activation and TUI
presentation have not been validated. Existing legacy state is refused, not
migrated. `namespaceDirectory`, if supplied, is only a diagnostic hint—not
storage isolation, a lock, or authority. Other plugins and same-UID writers are
outside this branch's protection.

```bash
npm test
npm run typecheck
# Inference-free, unique /tmp/opencode namespaces; no provider/auth config copied:
./node_modules/.bin/vitest run \
  test/integration/foundation.integration.test.ts \
  test/integration/foundation-adversarial.integration.test.ts \
  test/integration/runtime-preflight.integration.test.ts \
  --fileParallelism false
```

The internal reducer's stop/ownership fixtures are hypothetical adapter inputs,
not proof of real execution cleanup or authenticated human authority. Effectful
launch remains disabled until those contracts exist. See
[`2026-10-05-foundation-preflight.md`](docs/notes/2026-10-05-foundation-preflight.md)
for observed runtime hazards, verification boundaries and the next prerequisites.

## Target lifecycle (agreed direction; not all implemented)

```text
intake → triage (NeoLilith) → assigned backlog
       → resource-aware admission → ready → specialist execution
execution settles → failed / blocked / review / handoff back to backlog
failed → safe automatic rework (5 work rounds maximum); exhausted → blocked
review → one fresh NeoLilith assessment → Gavin's done / cancelled / rework
```

CPU affinity/cgroup limits, available RAM, workload measurements, and provider
limits guide admission; hardware does not directly translate into an agent
count. The pool is execution capacity with fresh sessions, not recycled
conversations. Capacity is released only after execution-stop reconciliation.
Dependencies wait in backlog; **blocked** states the specific human decision
or action needed. The reviewer recommends Done, Cancelled, or rework and
**does not move the card**.

The five rounds mean the initial workflow plus up to four failure-rework rounds.
Successful specialist handoffs continue the current round; failure-driven agent
swaps do not reset the card-wide ceiling.

### Current tools (legacy execution semantics)

- Intake defaults to **triage**; routing is caller-driven, and `kanban_assign`
  records a profile without moving the card.
- `kanban_work` creates a session and moves to **in_progress**.
- `kanban_submit_review` moves to **review** immediately; `kanban_handoff`
  closes the assignment and moves to **ready** before the old session stops.
- A successful exit without submission returns to **ready**. The advertised
  second-exit failure guard resets during ordinary redispatch history; do not
  rely on it as a retry budget. Failed sessions move to **failed**, with no
  built-in automatic failed-lane rework.
- `review.decide` currently accepts/cancels/requeues from review, or cancels/
  requeues from failed. Its `gavin` actor label is not an authorization boundary.

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

## Troubleshooting: missing lanes on an empty board

A healthy fresh board returns all nine lanes, even with no cards. If lane
headers disappear, check the backend before recreating cards or cron jobs:

```bash
opencode2 api get /api/plugin
opencode2 api post /api/rpc/jazz/board.get --data '{"input":{}}'
npm test
npm run typecheck
```

`rpc.unavailable` means Jazz has not registered its backend; it does **not**
mean the board is empty. Inspect `~/.local/share/opencode/log/opencode.log`
for `failed to load plugin`. On 2026-10-05, duplicate `cronService` and
`instanceID` declarations introduced by the watchdog change prevented the
entire backend from compiling. The entrypoint import test now covers that
failure. Fixing plugin loading does not recover previously lost persisted
cards or cron jobs.

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
inbox.list/ack/ackAll/clear/clearAll · review.decide (accept|cancel|requeue) · routing.log
board.archiveLane (done|cancelled → archive store) · archive.get
profiles.list/stats · cron.upsert/list/remove/runNow/runs
```

Editor tools (in any session): `kanban.*` (12 tools — intake, assign, work,
handoff, block, comment, submit_review, routing_candidates, move/list/remove),
`cron.*` (list_jobs, upsert_job, remove_job, run_now, runs), `inbox.*` (list,
ack, clear, clear_all).

## Dispatcher

The current dispatcher pulls dispatchable **ready** cards into worker sessions
automatically — no cron prompt needed. It is enabled by default and runs inside
the 15s cron tick under the existing leader lease. Ready cards with no open
assignment are ordered by priority then creation time, with a 60s per-card
cooldown and default `maxInFlight: 3`.

This is **assignment-count limiting, not a running-session pool**: submission,
block, and handoff can close assignments before sessions stop. Direct work
requests bypass the planner's capacity check, and cron sessions are not counted.
The existing lease is not an atomic/fenced cross-instance reservation. There is
no backlog-to-ready admission step. These are implementation gaps, not the
resource-aware target policy. Dispatch errors add a system comment; the current
no-submit history guard does not provide a reliable bounded rework loop.

Configure via plugin options `{ dispatch: { enabled, cooldownMs, maxInFlight } }`;
`JAZZ_DISPATCH=0` disables it (the integration harness opts out by default so
tests that move cards through ready don't race a dispatcher).

**Headless workers need pre-granted permissions.** A dispatched or cron-fired
session has no human to approve asks — and the ask that bites hardest is
invisible: sessions root at the service's project directory, so any `cd` into
a sibling project raises `external_directory` (base policy: ask) *before*
shell rules are even consulted, and headless that means an eternal freeze
that looks like a hang. Pre-allow `external_directory` for the workspace, and
give worker profiles V2 `permissions` arrays — note a `shell "*": deny` tail
hides the shell tool entirely, so prefer narrow allows and accept the base
fallback. V1-style `permission:`/`bash:` maps in agent frontmatter are
silently inert in V2.

TUI (`ctrl+j` or `/board`): 3-pane dashboard; `i` inbox, `c` cron, `k` kanban
full views; kanban navigation is arrow-only (`←`/`→` lanes, `↑`/`↓` cards,
selected lane highlighted); `p` posts a comment on the selected card (works
from the board and the detail view; `C` still comments from detail), `H`/`L`
move the selected card between lanes, `A` archives every card in the selected
done/cancelled lane into the archive store (`archive.get`; count shown in the
kanban title bar), `n` new, `x` remove; `i`/`c`/`k`/`d` consistently switch
between inbox/cron/kanban/dashboard. Inbox `x` clears the selected
notification and `X` clears all (removal from the list — `m`/`M` still mark
read without deleting); card detail with history/comments/assignments; on
review (or failed) lanes the detail shows a verdict pane — `a` mark done,
`X` cancel, `R` requeue to triage (rework: post a comment first) — deciding
routes through `review.decide` and returns to the board.

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
npm test                        # unit suite; use this run's output for counts
npm run test:integration        # real opencode2 serve (see Known gaps)
JAZZ_TEST_MODEL=zai-coding-plan/glm-5.3-flash npm run test:integration  # model override
```

## Historical verification gaps (2026-10-02)

These are historical test reports, not a current quota/health snapshot. The
2026-10-05 factory gaps and required untested variants are tracked in the
[current target contract](docs/design/factory-orchestrator.md).

1. **Model-pool dependency** — `link.integration` (v2 exit semantics) and
   `session.probe` need live model credits. The Z.AI plan's session pool was
   exhausted late 2026-10-01 (50.7M tokens/24h); the v2 link flow's green
   evidence is the 00:10Z run (9/9) before exhaustion. Re-run after the 5h
   window resets. `JAZZ_TEST_MODEL` overrides the staged config's model, but
   flash alone did not complete worker sessions (preamble-heavy prompts).
2. **TUI interactive pass** — dashboard/kanban/detail/verdict-gating verified
   in tmux; inbox ack keys and cron e/r/N keys not driven (RPC paths
   integration-verified). See `docs/notes/tui-checklist-v2.md` and
   [`docs/notes/tui-checklist-v3.md`](docs/notes/tui-checklist-v3.md) (v3:
   arrow-only navigation, full-screen board, lane-title fix, uppercase-bind
   fix, scratch-board technique).
3. **Native personas** — soul roles flagged `native: true`; imported profiles
   are prompt-composed. Materializing curated imports as `.opencode/agent/`
   definitions is future work (hybrid personas, design §5).


## Cron jobs

Jobs are `{name, cronExpr, prompt, agent?, enabled, allowNotify?}` — generic
prompt cron. A job fires into a fresh session; the scheduler knows nothing
about card lanes. Scheduled card work is explicit composition: a prompt may
create/request card work. Under the target contract, every resulting execution
uses the shared admission controller; cron cannot bypass its resource limits.
Fire/admission success is not proof that the scheduled task finished successfully.

`allowNotify` (default `true`) mutes the inbox notification on fired/caught_up
— set it to `false` on high-frequency jobs so they don't spam the inbox.
Failed fires always notify, even when muted. TUI: `n` in the cron view toggles
it; the row shows `muted` when off.

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
