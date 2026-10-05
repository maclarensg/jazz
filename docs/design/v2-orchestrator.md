# opencode-jazz v2 — dashboard, orchestration loop, profile router

**Status**: historical v2 proposal and implementation-divergence record
**Target runtime**: OpenCode V2, local binary `opencode2` v2.0.9 (deployed: shared service, symlink)
**Date**: 2026-10-01
**Original relationship to v1**: extends the module boundaries and replaces
v1's session-success-to-Done behavior with a review-first target.

**Current authority (2026-10-05):** [factory-orchestrator.md](factory-orchestrator.md)
supersedes this document's lifecycle, triage trigger/destination, failed-lane
policy, handoff scheduling, capacity accounting, review automation, and verdict
authorization semantics. Layout/profile history and implementation divergences
below remain useful background, not current normative rules or conformance.

---

## 1. What v2 adds

1. **Dashboard TUI** — three panes (Inbox · Cron · Kanban) with `i` / `c` / `k`
   full-view expansion.
2. **Inbox** — notification stream sourced from board and cron events.
3. **9-lane board** — triage / backlog / ready / in_progress / blocked /
   **failed** / review / done / cancelled. All completed work lands in
   **review**; only Gavin's verdict moves it to done or cancelled.
4. **Rich cards** — title, priority, details, comments, append-only history log,
   assignment chain.
5. **Profile registry** — 200+ normalized subagent profiles imported from public
   collections + NeoLilith soul roles.
6. **Laya routing** — 2-stage classifier (domain → profile, each ≤16 options,
   matching `core.jev_laya`'s choice policy) assigns the best profile per card.
7. **Handoff loop** — cards switch profiles (SWE → QA → …) until someone calls
   `submit_review`; then the card waits for Gavin in review.
8. **SOUL wiring** — roles sync, Laya subprocess, Farsight card-context for
   handoff continuity, review outcomes → brain episodes (routing calibration).

## 2. Card lifecycle — the 9 lanes

Lane order: `triage · backlog · ready · in_progress · blocked · failed ·
review · done · cancelled`

```
             ┌──────────────── intake ────────────────┐
             │ TUI `n` · cron fire · agent tool · RPC │
             └──────────────────┬─────────────────────┘
                                ▼
   ┌──────────┐    park (low prio)      ┌──────────┐  Laya 2-stage route:
   │ BACKLOG  │◀────────────────────────│  TRIAGE  │  profile + priority
   └────┬─────┘─── promote ────────────▶└────┬─────┘  (or park / needs-human)
        └────────────▶ TRIAGE                │
                                             ▼
                                       ┌──────────┐
              requeue ◀────────────────│   READY  │  worker claims:
              (auto re-route)          └────┬─────┘  kanban_work(cardID)
         ┌──────────────┐                  ▼
         │   BLOCKED    │◀── stuck: needs  ┌──────────────┐
         │              │    input or dep  │ IN_PROGRESS  │──┐ handoff done? no:
         └──────┬───────┘                  │ SWE→QA→SEC→… │◄─┘ Laya picks next
                │ unblock                  └─┬─────────┬──┘
                └──────▶ TRIAGE              │         │ submit_review
                                          failed      ▼
                     session failed ·      │    ┌──────────┐
                     guard caps hit ·      │    │  REVIEW  │ Gavin: a / x / r
                     2× no-submit exit     │    └────┬─────┘
                                         ▼         │
                                 ┌──────────┐      ├─ a ▶ DONE
                                 │  FAILED  │      ├─ r ▶ TRIAGE
                                 │  machine │      └─ x ▶ CANCELLED
                                 │  gave up │   from FAILED (Gavin only):
                                 └──┬────┬──┘   r ▶ TRIAGE · x ▶ CANCELLED
                              r ────┘    └──── x
```

**Lane invariants**

- Terminal lanes: `done`, `cancelled`. Nothing leaves them (except explicit
  manual move).
- `blocked` = recoverable stall: the worker flagged it (`kanban_block`) or a
  dependency/input is missing. Recoverable: unblock → triage.
- `failed` = the automation gave up: session `execution.failed`, handoff cap
  (6) hit, repeat-profile veto violated, or 2 consecutive worker exits without
  `submit_review`. Only Gavin exits this lane: `r` → triage, `x` → cancelled.
  Emits a p0 inbox notification.
- `review` is Gavin's queue. Agents cannot move a card out of review — only
  `kanban_decide` (TUI action or RPC, actor recorded as gavin) does.
- Every re-entry to `triage` is a **requeue** and appends history + a routing
  re-run (previous assignment is kept in the assignment chain, not erased).
- Every lane transition appends a `HistoryEntry` and (for review/failed/
  blocked/terminal/cron events) an inbox notification.

**Session-exit semantics change from v1** (load-bearing):

| v1 | v2 |
|---|---|
| session succeeded → card `done` | succeeded **without** `submit_review` → card back to `ready`, comment "worker exited without submitting"; 2nd consecutive → `failed` |
| session failed → `blocked` | session failed → **`failed`** (new lane) |
| — | handoff-cap / repeat-profile veto violation → `failed` |
| — | worker calls `kanban_block(reason)` → `blocked` (stuck, recoverable) |
| — | `kanban_submit_review` → `review` (the only agent path into review) |

Rationale: a worker's exit code is not a verdict (orchestration rule: worker
success ≠ Done). "Done" is Gavin's verdict, in review. And failure ≠ stuck:
`blocked` says "I need something", `failed` says "the machine is done trying" —
Gavin added the failed lane precisely so real failures stop hiding among stalls.

## 3. Card model v2

```ts
export interface Comment { id: string; author: string; body: string; ts: string }

export type HistoryKind =
  | "created" | "moved" | "assigned" | "handoff" | "comment"
  | "review" | "routed" | "cron" | "exit" | "note"

export interface HistoryEntry {
  ts: string
  kind: HistoryKind
  actor: string            // profile id, "gavin", "cron:<job>", "system"
  from?: string            // lane
  to?: string              // lane
  detail?: string
}

export interface Assignment {
  profile: string          // registry id
  sessionID?: string
  startedAt: string
  endedAt?: string
  outcome?: "handoff" | "submitted" | "exited" | "failed"
}

export interface Card {
  id: string
  title: string
  details?: string
  priority: 0 | 1 | 2 | 3          // p0 critical … p3 whenever; default 2
  lane: string
  profile?: string                 // current registry id
  assignments: Assignment[]
  comments: Comment[]
  history: HistoryEntry[]          // append-only, capped at 200 entries
  source: "manual" | "cron" | "session" | "requeue"
  created: string
  updated: string
}
```

Migration: v1 boards load with additive remap — keep existing lanes/cards, add
missing lanes (`triage`, `review`, `cancelled`, `backlog`), old `done` cards
stay done. Unit-tested with a captured v1 board fixture.

## 4. Inbox

```ts
export interface Notification {
  id: string
  ts: string
  source: "card" | "cron"
  kind: string            // card: entered_review | blocked | failed | done | cancelled | requeued
                          // cron: fired | failed | caught_up
                          //   fired/caught_up respect the job's allowNotify flag
                          //   (cronNotifyKind); failed fires always notify
  message: string
  cardID?: string
  jobID?: string
  read: boolean
}
```

- Storage: `inbox/notifications`, ring capped at 500.
- Emitted by: board transitions (review/failed/blocked/terminal/requeue), cron
  (fire/fail/catch-up), review decisions.
- Agent-facing: **not** a tool — inbox is the human surface. Agents write
  comments on cards instead.
- TUI full view: unread bold, `enter` jumps to card detail or cron log,
  `m` mark read, `M` mark all.

## 5. Profile registry — the 200+

**Sources researched (2026-10-01):**

| Source | Count | Notes |
|---|---|---|
| `nedzreclassified/massive-agent-repo-1003` | 1005 | Aggregation of 10 collections, deduped by name, per-file license retained, ATTRIBUTION.md, catalog grouped into 28 categories |
| `davepoon/claude-code-subagents-collection` | 538 | Largest single source (inside the 1003 agg) |
| `VoltAgent/awesome-claude-code-subagents` | 158+ | 10 categories, MIT, 24k stars, install script + catalog skill |
| `0xfurai/claude-code-subagents` | 131 | Uniform format, MIT |
| `ampedweb/awesome-subagents` (philipobenito) | 131+ | **Has `generate.sh` converting Claude → OpenCode format** (`~/.config/opencode/agents/`, `.opencode/agents/`) — proves the conversion is mechanical |
| `wshobson/agents` | 103 | Production-grade specialists |
| SOUL `profile/agents/*.md` | 12 | NeoLilith's own roles — first-class entries |

**Recommendation**: import from the 1003 aggregation + VoltAgent, normalize,
dedupe, and curate down to **~200–250** (quality bar: description states WHEN
to use the agent; instruction > 20 lines; no tool hallucinations). Full 1005
stays available by re-running the importer without the curation flag.

**Normalization** — `scripts/import-profiles.sh` (+ `scripts/normalize.mjs`):

```
profiles/
  <category>/<slug>.md      # original markdown, frontmatter preserved
registry.json               # the classifier's corpus
```

```json
{ "id": "backend-engineer", "name": "Backend Engineer",
  "category": "engineering", "tags": ["api", "typescript"],
  "description": "Builds server-side features end to end…",
  "source": "voltagent", "license": "MIT",
  "native": true, "path": "profiles/engineering/backend-engineer.md" }
```

Registry constraints (enforced by test):
- id unique, `[a-z0-9-]+`; description 20–200 chars (routing corpus quality).
- ≤ 16 profiles per category (see §6 — the Laya choice limit).
- Soul roles imported with `"source": "soul"` via `scripts/sync-soul-roles.sh`
  reading `profile/agents/*.md` from the NeoLilith checkout.

**Persona mechanism** (both, decided per profile):
- **Native**: materialized as an OpenCode agent definition in the worker
  project's `.opencode/agent/` → `ctx.session.create({ agent: id })` gets
  real per-agent tools/permissions. Project-local scoping keeps 200+ agents
  out of Gavin's global picker.
- **Prompt-composed** (default): role text is composed into the session prompt
  (fan_out precedent — proven on opencode2). No permission side effects.

## 6. Laya routing — 2-stage choice

`core.jev_laya` (SOUL) — official local CPU classifier, ≤16 options per choice
by application policy. 200+ profiles cannot be one question; a 16×16 tree can:

```
card (title + details + comments tail)
  │
  ▼ stage 1: choice over categories (≤16)          e.g. engineering | qa |
  │   options = registry categories + "needs-human"| docs | data | security | …
  ▼ stage 2: choice within category (≤16)          e.g. backend-engineer |
  │   options = profiles in category + "none-fit"  frontend | swe-general | …
  ▼
kanban_assign(cardID, profile, reason, priority?)
```

- Spec is numbers-and-short-strings only (Laya state budget), e.g.
  `card: fix flaky cron integration test. comments: 2. cat=engineering`.
- `"needs-human"` / `"none-fit"` → comment on card + inbox notification, card
  stays in triage. Never force a bad match.
- Every call logged to `jazz/routing`:
  `{cardID, stage, picked, probabilities, confidence, ts, outcome}`
- **Calibration loop**: review decisions (accept-first-pass / requeue / cancel)
  update the routing entry's `outcome`. The soul brain episode feed reads this
  periodically — routing quality becomes measurable, not vibes.
- Invoked **by a triage agent session** (subprocess from soul root:
  `uv run python -m core.jev_laya --spec -`), NOT by the TS server — jazz stays
  pure TS; intelligence composes via agents, as in v1.

**Trigger**: v1 = a 1-minute `triage-sweep` cron job (zero new server machinery;
agents compose, modules stay decoupled). v2 (later) = event-spawn on card
create. Sweep is leader-leased already (cron's existing lease).

**Handoff routing**: `kanban_handoff(cardID, "auto" | profileID, note)`. "auto"
runs the same 2-stage Laya call with the question "what does this card need
next?" over the *remaining pipeline* for its category. Deterministic default
pipelines per category (engineering: swe → qa → sec-review; docs: writer →
editor) so "auto" is pipeline-ordered, Laya-confirmed.

**Loop guards**: max 6 handoffs per card; same-profile-twice-in-a-row requires
`force: true` + reason; guard violations → `failed` + p0 inbox notification.

## 7. Handoff loop end to end

```
TRIAGE ──Laya──▶ assign profile ──▶ READY
READY  ──kanban_work──▶ session#1 (SWE profile, prompt = role + card context
                        + farsight card:<id> ref)        card → IN_PROGRESS
session#1 ──kanban_handoff(auto,"tests failing on CI")──▶ Assignment[outcome=handoff]
                        Laya picks QA ──▶ session#2 (QA profile)  card stays IN_PROGRESS
session#2 ──kanban_submit_review(summary)──▶ card → REVIEW + inbox notification
REVIEW ──Gavin: a──▶ DONE        (episode → brain: routing outcome=accepted)
       ──Gavin: r──▶ TRIAGE      (re-route; outcome=requeued)
       ──Gavin: x──▶ CANCELLED
```

**Context continuity across handoffs** (the FS10 wiring): each worker session
is prompted to append a handoff note to Farsight under key `card:<id>` — next
worker reads it + card history tail. Sessions die; card context doesn't.
Convention only, zero code coupling to farsight — same pattern as fan_out roles.

## 8. TUI v2

```
┌─── jazz (ctrl+j) ─────────────────────────────────────────────────┐
│ ┌─ Inbox (3) ──────┐ ┌─ Cron ────────┐ ┌─ Board: triage 2 · …   │
│ │ ● card ab12 →REVIEW│ │ triage-sweep │ │ ┌────┐┌────┐┌────┐ …  │
│ │ ● cron build failed│ │ */1  next 2m │ │ │ab12││…   ││    │    │
│ │ ○ card cd34 done   │ │ report 6h    │ │ └────┘└────┘└────┘    │
│ └───────────────────┘ └───────────────┘ └────────────────────────┘
│  i inbox · c cron · k kanban · (full view) · d dashboard          │
└───────────────────────────────────────────────────────────────────┘
```

- `i` / `c` / `k` → full views; `d` or `esc` → dashboard. Tab/arrows switch
  panes on dashboard. Keymap registered inside mounted components only
  (v1 lesson — tui-checklist.md).
- **Kanban full**: 9 columns (`h/l` scrolls through triage…cancelled), `j/k` card, `enter` card
  detail, `n` create (title + priority + details), `x` cancel from review.
- **Card detail**: title, priority badge, details, assignment chain, comments
  (`c` compose), history log (live), and in review lane: `a` accept / `x`
  cancel / `r` requeue — footer actions calling `review.decide` RPC.
- **Cron full**: jobs table (expr, next, last, enabled), `e` toggle, `r`
  run-now, `n` create, `enter` run log (ring).
- All state via RPC subclient + `jazz.*` events (v1 pattern), never direct
  storage.

## 9. New / changed tools & RPC

**Tools (agents)** — existing `kanban_*` v1 kept:
`kanban_work(cardID, {note?})` now resolves card.profile automatically;
new: `kanban_assign`, `kanban_handoff(cardID, to|"auto", note, force?)`,
`kanban_submit_review(cardID, summary)`, `kanban_comment(cardID, body)`,
`kanban_block(cardID, reason)`, `kanban_intake({title, details?, priority?,
source})` (cron/agent intake path — creates in triage).

**RPC** — new: `inbox.{list,ack,ackAll}`, `card.detail(cardID)`,
`review.decide(cardID, accept|cancel|requeue, note?)`, `profiles.{list,search}`,
`routing.log(cardID?)`, `registry.stats()`.

**Storage keys added**: `inbox/notifications`, `jazz/routing`, `jazz/profiles`
(registry cache; registry.json is source of truth on disk).

## 10. SOUL wiring graph

```
┌─────────────────────── SOUL (~/Workspace/NeoLilith, git) ───────────────────────┐
│  profile/agents/*.md (12 roles) ──sync──▶ jazz registry (source: soul)          │
│  core.jev_laya (classifier) ◀──subprocess spec JSON── triage/handoff agents     │
│  orchestrate policy (AGENTS.md): worker exit ≠ Done ⇒ review lane is the        │
│      human verdict gate; bounded handoff depth ⇒ max 6 hops                     │
│  brain durable/episodes ◀── review outcomes + routing log (calibration)         │
│  Farsight shared memory (FS10) — card:<id> handoff continuity, all runtimes     │
└─────────────────────────────────────────────────────────────────────────────────┘
              │ roles                     │ Laya subprocess
              ▼                           ▼
┌───────────────────── JAZZ (plugin: board·cron·link·inbox·profiles·routing) ─────┐
│  9 lanes · rich cards · notifications · registry (200+) · routing log           │
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               │ ctx.session.create(agent?, prompt)
                               ▼
┌───────────────────── opencode2 shared background service ───────────────────────┐
│  triage-sweep cron ▶ triage agent ▶ Laya ▶ kanban_assign                        │
│  worker sessions (profile personas) ▶ kanban_work / handoff / submit_review     │
│  each session ↔ farsight card:<id> context                                      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 11. Module map delta

```
src/
├── board.ts        # + priority/details/comments/history/assignments, 9 lanes, migration
├── inbox.ts        # NEW: notifications ring, event subscription, emit rules
├── profiles.ts     # NEW: registry load/search/validate (pure)
├── routing.ts      # NEW: routing log (pure), spec builders for Laya (pure)
├── link.ts         # exit-semantics change: succeeded≠done; failed≠blocked; repeat exits→failed
├── tools.ts        # + assign/handoff/submit_review/comment/block/intake
├── rpc.ts          # + inbox./card.detail/review./profiles./routing.
├── tui.tsx         # 3-pane dashboard, i/c/k full views, card detail, review keys
scripts/
├── import-profiles.sh + normalize.mjs   # download → normalize → dedupe → curate
└── sync-soul-roles.sh                   # profile/agents/*.md → registry (source: soul)
```

## 12. Verification strategy (unchanged bar: nothing guessable counts)

- **Unit**: card v2 mutations + migration fixture; inbox ring + emit rules;
  registry validation (16/category cap, unique ids, description bounds);
  routing-log updates; handoff guards (7th hop rejected, repeat-profile veto).
- **Integration (real `opencode2 serve`)**: inbox RPC round-trip with nonce;
  registry stats reflect disk; `kanban_handoff` auto with a stub-Laya profile
  pipeline; full loop triage→review→decide on a real board via HTTP;
  session-succeeded-without-review returns card to ready (2× consecutive → failed).
  Laya-dependent tests skip loudly (not silently) when the soul env is absent.
- **TUI**: tmux checklist — i/c/k switching, card detail render, review
  a/x/r against real service.
- **Profile import**: counted assertions (≥200 registered, 0 dupes, licenses
  recorded) — script prints exact numbers, doc copies them verbatim.

## 13. Known risks / open verifications

1. **Laya latency on CPU** per card (~seconds) — fine: triage is async via
   sweep; never on the TUI critical path.
2. **`ctx.session.create` agent param** — cron already passes `agent?`; verify
   per-profile native agents resolve from worker project dir at runtime.
3. **Profile quality variance** — curation gate + "none-fit" escape hatch;
   bad routes surface as requeues, which feed calibration.
4. **License hygiene** — per-file license retained in registry; ATTRIBUTION
   carried from the 1003 repo. Private homelab use; no redistribution.
5. **inbox growth** — ring cap 500, oldest dropped, tested.
6. **Two servers** — cron leader lease already covers the sweep; verify the
   same lease guards review notifications (it guards cron only — inbox emits
   from board mutations, single-writer serialized, no double emit).

## 14. Milestones (each: red → green → commit)

1. Card model v2 + 9 lanes + migration + unit tests
2. Inbox module + RPC + unit/integration
3. Registry + import pipeline + soul-role sync + counted assertions
4. TUI dashboard v2 (3 panes, i/c/k, card detail, review keys)
5. Triage sweep + Laya 2-stage routing + `kanban_assign` + routing log
6. Handoff loop + guards + exit-semantics change + integration
7. Review flow (a/x/r) + outcome calibration feed + docs/runbook
8. Brain decision record + close (episode: what diverged)

## 15. Implementation divergences (recorded 2026-10-02)

The shipped product differs from the signed-off text in four places, each
with its why:

1. **Stage-2 routing is prefilter + choice, not ≤16-per-category.** §5 set a
   registry constraint of ≤16 profiles per category; real collections are
   engineering-heavy and balancing would need synthetic category names
   (`engineering-2`), which pollutes stage-1 options. Instead the registry
   keeps 12 canonical categories and `topCandidates()` keyword-scores the
   registry against the card text (score>0 only, cap 16) — deterministic,
   testable, and no synthetic buckets. The 16×16 property still holds at the
   choice boundary.
2. **Handoff lands the card in `ready`, not `in_progress`.** §7 implied the
   card stays in_progress through handoffs. Moving to ready makes the next
   worker a normal dispatch (sweep/`kanban_work`), reuses every existing
   guard, and makes "in_progress with no live session" impossible.
3. **`review.decide` also serves the failed lane** (x/r only) — §2's
   "only Gavin exits failed" needed a concrete mechanism; the same RPC is it.
4. **Model-dependent integration tests are quota-sensitive.** The Z.AI plan's
   session pool exhausted during delivery (50.7M tokens/24h); `link.integration`
   v2 and `session.probe` require live credits. Green evidence for the v2 link
   flow: the 00:10Z 2026-10-02 run (9/9) before exhaustion. `JAZZ_TEST_MODEL`
   in the harness patches the staged config's model for reruns; note that
   flash alone did not complete worker sessions under the v2 preamble.

Verification totals at delivery: 97/97 unit, integration 20/22 green with the
2 model-pool tests blocked (passed in pre-exhaustion runs; see README gaps).
TUI v2 verified in tmux: dashboard/kanban/detail render, focus navigation,
migration backfill visible, verdict gating — `docs/notes/tui-checklist-v2.md`.
