# Jazz factory orchestrator — lifecycle, execution admission, and human verdict

**Status**: Target direction from Gavin 2026-10-05; lifecycle decisions agreed; implementation incomplete; resource thresholds/actual end-to-end semantics pending validation.

**Authority**: Jazz owns the target card lifecycle and scheduling authority. NeoLilith's constitution, identity, orchestration protocol, and role/model policy remain soul-owned. This document does not modify them.

**Evidence boundary**: This is normative target design, not a declaration of current conformance. Section 12 distinguishes repository inspection from observations supplied by the main assessment session. No live executions or implementation verification were performed to author this document.

**Subsequent foundation checkpoint**: Isolated runtime preflight and a
nonexecuting source foundation now exist; their evidence and limits are in
[2026-10-05-foundation-preflight.md](../notes/2026-10-05-foundation-preflight.md).
The pure reducer/store contract and read-only safety gates do not establish
effectful-controller or factory conformance. Gavin selected fail-closed
verdict/requeue/grant behavior while a trusted human channel is unavailable.
The default legacy mode is unchanged, not retroactively secured.

## 1. Decisions, classification, and supersession

The agreed direction is:

- Cron remains generic scheduled tasks: schedule and prompt produce a fresh session, not implicit card transitions.
- Gavin or NeoLilith creates unit-of-work cards in triage. Triage automatically requests NeoLilith to determine profiles and scope; completed triage lands in backlog.
- A capacity-aware priority scheduler promotes eligible backlog cards to ready. A dispatcher reserves execution capacity and runs the assigned profile in a fresh isolated session.
- Complex cards can have specialist stages and explicit nonterminal handoffs.
- Workers settle in failed, blocked, or review; handoff is continuation, not completion. Capacity is released only when execution truly stops.
- Failure recovery permits **five work rounds maximum per card: the initial workflow plus up to four failure-rework rounds, with backoff**. Gavin's final five-round choice supersedes the earlier three-attempt choice and unlimited reset proposal. Exhaustion enters **blocked**, requiring Gavin to authorize additional budget or change scope.
- Blocked always identifies a decision/action automation cannot perform. Machine-resolvable dependency waiting stays backlog.
- Each review cycle requests one fresh NeoLilith profile thread to independently assess evidence once. It comments recommend done, cancel, or rework, or reports a fault. It never moves the card out of review.
- Gavin alone makes final review-to-done/cancelled moves or explicitly requeues. Gavin may decide while independent review is pending, with a warning; there is no compulsory AI approval gate.
- Capacity is automatically detected/adapted using this machine's effective CPU/RAM, workload resource class, and provider quota/rate/concurrency constraints. Logical CPU count is not an agent count.

Classification against existing design:

| Classification | Mapping |
|---|---|
| COVERED | Generic cron/board separation in `design.md`, load-bearing decision; worker success is not Done and Gavin's verdict gate in `v2-orchestrator.md` §2; durable card context across fresh sessions in §7. |
| CHALLENGE | v1 success-to-done; v2 Gavin-only exit from failed; cron sweep as primary triage trigger; direct triage-to-ready; dependency/input equals blocked; the two contradictory handoff routes in v2 §7/§15; terminal manual reopening; apparent capacity release through assignment closure. |
| COMPLEMENT | Explicit execution leases, adaptive shared admission, pending-disposition stop barrier, durable attempt budgets/backoff, independent once-per-cycle review, authorization/fencing, and evidence-aware restart reconciliation. |

For conflicts, the agreed decisions above govern the target instead of `design.md` link semantics and `v2-orchestrator.md` §§2, 6, 7, 9, 10, 12, and 15. Unchanged board/cron/TUI/profile concepts remain usable. `plan.md` is a historical implementation plan, not approval of this document's unresolved resource policies. Proposed defaults below are labeled and must not be presented as Gavin-approved numeric policy. Supersession headers and README link here; the review evidence is in [2026-10-05-factory-review.md](../notes/2026-10-05-factory-review.md).

## 2. Architecture and ownership

```text
Gavin / NeoLilith intake ──> Jazz authoritative card/evidence state
                                   │
                  triage intent ──>│<── profile resolution / Laya advice
                                   │
                         backlog admission scheduler
                                   │
                         ready dispatcher ──> execution adapter
                                   │                │
                 durable intents / leases           └─ fresh profile sessions
                                   │                         │
                     reconciler <── verified stop/receipts ───┘
                                   │
                    review cycle ──> one fresh NeoLilith reviewer
                                   │                   │
                         Gavin verdict <── recommendation/fault

Generic cron ──> generic run intent ──> shared admission / execution adapter
                (no knowledge of card lanes)
```

| Responsibility | Owner and constraint |
|---|---|
| Card truth, state transitions, attempt/review identities, evidence references | Jazz durable state; never a parallel markdown board for the same work. |
| Scope and final judgment | Gavin; NeoLilith may propose/create work but cannot issue Gavin's verdict. |
| Triage, rework plan, specialist coordination, evidence synthesis | NeoLilith owns the automation outcome; a specialist's success is insufficient to complete the card. |
| Routing | NeoLilith chooses; Laya is advisory, not an approval authority. |
| Admission, priority ordering, capacity reservations | Jazz deterministic controller; all spawning entry points use it. |
| Specialist work | Assigned role with its own preserved model/runtime/permissions policy. |
| Actual stop, lease settlement, restart recovery | Jazz execution adapter and reconciler, using validated runtime semantics. |
| Independent review | Exact NeoLilith primary profile in a fresh isolated session, not the preceding worker's conversation. |
| Final done/cancelled; explicit review requeue; more exhausted budget | Authenticated Gavin action. |
| Constitution/orchestration protocol and soul roles | NeoLilith source of truth; Jazz imports/references versioned definitions without rewriting identity. |

### Two existing card engines are not one engine

Main's code inspection found a separate NeoLilith `core/runtime/loop.py` with its own durable markdown board, dependency/write-conflict checks, contract/capability gates, fenced journals/receipts, and a default `max_attempts` of three. Its verified envelope can auto-mark its own work done (`loop.py:723–734`). These are code findings, **not** live engine conformance or Jazz semantics.

Jazz must not schedule the same unit of work through that independent loop and its own board. Borrow contract, fencing, conflict, and receipt concepts through a documented execution adapter; do not import a second scheduler or second card truth. An adapter must disable/bypass legacy board ownership for Jazz work and return evidence/results to Jazz. If it cannot establish that boundary, it is not an admissible executor for Jazz cards.

NeoLilith `core/runtime/fan.py` has a per-batch `ThreadPoolExecutor` defaulting to four, fresh standalone subprocesses, and depth one, according to main's inspection. It is **not** a durable global pool. Any adapted fan-out must acquire an individual Jazz lease and disjoint ownership for each child execution; batch-local bounds cannot replace global admission. No nested execution may escape accounting. Sequential specialist stages are the proposed baseline.

NeoLilith's internal completion checks and Jazz's outer human verdict are distinct: a verified inner envelope is evidence eligible for review, never authorization for Jazz done.

## 3. Card graph and transition authority

Canonical lanes remain `triage / backlog / ready / in_progress / blocked / failed / review / done / cancelled`. Execution substates are not additional board lanes.

```text
intake ──> TRIAGE ── scoped/profile resolved ──> BACKLOG
              │                                   │
              └─ explicit human need ──> BLOCKED   │ eligible + admission
                                                  ▼
                                                READY
                                                  │ reserved fresh execution
                                                  ▼
                                             IN_PROGRESS
                                      running → stopping/settling
                                                  │ confirmed actual stop
                   ┌──────────────────────┬───────┼──────────────────┐
                   ▼                      ▼       ▼                  ▼
                 FAILED                BLOCKED  REVIEW             BACKLOG
                   │                             │                 handoff
        safe budget + backoff                    │                 continuation
             ┌─────┴──────┐                      │
             ▼            ▼                      ├─ Gavin accept ──> DONE
          TRIAGE       BACKLOG                   ├─ Gavin cancel ──> CANCELLED
        needs reroute  same valid scope           └─ Gavin requeue ──> TRIAGE
                   │
        no attempts left ──> BLOCKED
                      authorize budget/change scope: Gavin ──> TRIAGE
```

| From / trigger | To | Required authority and behavior |
|---|---|---|
| Intake | triage | Gavin/NeoLilith creation records source, scope/revision, priority, and triage intent. |
| Triage completed | backlog | NeoLilith establishes acceptance behaviors, next role, dependencies/resource class, and work ownership. Triage execution itself must settle safely. |
| Unresolved explicit human action | blocked | Record exactly what Gavin must decide/do and why permitted automation cannot; no auto-approval. |
| Backlog admitted | ready | Scheduler checks dependency readiness, persistent backoff, budget, role capability, resource availability, and write conflicts; records an admission entitlement. |
| Ready dispatched | in_progress | Dispatcher atomically claims the card and converts the entitlement to an execution lease before creating a session. |
| Worker disposition requested | in_progress, stopping/settling | Record pending failed/block/review/handoff disposition and evidence; stop new work by the predecessor. No successor/reviewer begins yet. |
| Confirmed stop, genuine failure/no valid disposition | failed | Apply §5 settlement arbitration and record failure classification. Genuine failure overrides a pending review/handoff; successful exit without disposition is a protocol failure, not completion. An independently required human action may instead require blocked. |
| Failed, safe rework eligible | triage or backlog | Automatic bounded recovery with persistent backoff and a reasoned plan; routing changes do not reset budgets. |
| Failed, budget exhausted | blocked | Controller records that Gavin must authorize more budget or change scope; no sixth automatic work round. |
| Confirmed stop, human block | blocked | Release only reconciled execution ownership; record required human action. |
| Confirmed stop, valid review submission without genuine failure | review | Apply §5 arbitration, freeze evidence identity, create a new review cycle and exactly one logical reviewer intent. |
| Confirmed stop, valid handoff without genuine failure | backlog | Apply §5 arbitration, persist successor role/routing request and evidence; continuation uses ordinary admission, not a direct successor spawn. |
| Review recommendation/fault/session exit | review unchanged | Reviewer may comment only within its evidence-assessment capability; no automatic requeue/final move. |
| Review decision | done/cancelled/triage | Gavin-only authenticated operation against the current review cycle; triage means rework, not a final verdict. |
| Blocked resolution | triage | Gavin supplies the decision/action or budget grant; persist authorization before restarting. |
| Done/cancelled | unchanged | Immutable verdict. New work is a linked new card, not manual reopening of the original verdict. |

A machine-resolvable dependency leaves a card in backlog with a visible waiting reason and wake condition. A stale capability catalog or uncertain runtime state pauses admission with a visible operational reason; it must not generate endless agent triage. If human intervention is necessary, describe that intervention explicitly.

## 4. Five-round budget, rework, and specialist handoffs

### Agreed failure path

```text
work round 1: initial workflow, possibly multiple specialist handoffs
  → failure and confirmed stop → failed → safe plan + backoff → round 2
rounds 2–4: failure rework, each with its own specialist continuation
  → failure and confirmed stop → failed → safe plan + backoff → next round
round 5 fails and stops
  → failed → blocked: Gavin must authorize more budget or change scope
```

Recovery is not unconditional replay. Before another round, establish that execution stopped, prior side effects are known, a safe retry is justified, and acceptance/scope remain valid. Unknown external effects require human resolution instead of blind replay, even with budget remaining. Permission approval, destructive actions, out-of-scope changes, or a required human decision can block before the fifth round.

Persist card-wide rounds consumed, budget grants, round/stage/execution identity and outcome, failure class, rework plan, `nextEligibleAt`, and cumulative elapsed/resource consumption. Narrative history, profile changes, reassignment, handoffs, review requeues, comments, controller restart, and archive operations cannot reset the card-wide ceiling. A scope change records a new revision plus Gavin's budget authorization where needed, not a silent reset.

**Round accounting:** the initial dispatched workflow opens round 1. A successful specialist handoff continues the same round; sessions, roles, and stages retain separate identities and resource leases. A failed execution/protocol outcome requiring automatic rework opens the next round only after safe settlement and admission. Switching agents after failure does not reset the round counter or buy another five rounds. No fixed card-wide specialist-session/handoff count is imposed by this policy. Stages must correspond to actual remaining acceptance work, not duplicate assignments used to bypass failure accounting. Triage and outer review are separately bounded control work, not work rounds. A failed pre-execution reservation consumes no new round only with proof no execution/effects began; ambiguous launch retains its reservation and accounting until reconciled.

Backoff is mandatory for automatic rework; its function, durations, maximum delay, and provider-retry behavior require validation/configuration. Rate-limit errors must honor verified provider constraints. There is no approved numeric backoff, wall-time, or token limit in this document. Execution/control resource budgets must be finite, durable, and visible before the affected automated path is enabled. Legitimate sequential specialist handoffs have no fixed count ceiling; nested parallel depth remains separately bounded. No-progress handoffs are protocol faults, not a route to unlimited failure rework.

A handoff names the next need, role or routing request, completed work, evidence, remaining acceptance behaviors, risks, and write ownership. It grants neither completion nor fresh budget. A loop/guard fault consumes/settles the matching execution according to the attempt policy, then uses failed recovery or an explicit human block; no `force` option may bypass budget or safety.

## 5. Execution records, stop barrier, and capacity release

The durable conceptual records are:

- **Card revision/work contract:** acceptance behaviors, scope, dependencies, priority, resource class, write set, and evidence references.
- **Admission entitlement:** owner/card identity, resource/provider reservation, controller epoch, and conversion/release state; ready is not free unaccounted queueing.
- **Execution intent/lease:** immutable execution and round/stage identities, session/process correlation, role/model policy fingerprint, resources, ownership fence, timestamps, and status.
- **Pending disposition:** failed/block/review/handoff request with evidence, author capability, and request identity.
- **Work-round ledger:** persistent card-wide round consumption, execution-attempt records, failure classification, backoff, grants, and exhaustion action.
- **Review cycle:** immutable evidence snapshot identity, one reviewer intent, physical-session correlation or uncertainty, assessment/fault, and Gavin decision.
- **Verdict:** authenticated Gavin identity, card/review/evidence identities, decision, time, and warning override acknowledgment when applicable.

Record shapes/storage choices are implementation work; the observable identities and preservation obligations are normative. Existing `ctx.storage` may be retained only if the required atomicity, durability, and fencing semantics can be established. A process-local promise chain alone does not establish multi-controller safety.

Lease states distinguish reserved, creating/starting, running, stop-requested, settling, unknown/quarantined, and released. All unreleased states retain their reservation. Logical assignment closure is independent of actual execution termination.

The controller applies a pending disposition after stop is confirmed for the matching execution and its managed child work. Submission, handoff, block, prompt acceptance, RPC timeout, interrupt request/response, heartbeat expiration, and assignment `endedAt` are **not proof of stop**. Wall-time/resource exhaustion requests stop and records the request; a stop failure remains occupied/quarantined and visible.

A terminal event is sufficient only under a verified adapter contract covering execution and managed side effects. Detached tools/build processes and nested agents cannot outlive the accounted boundary without their own tracked ownership. Release is idempotent and cannot free a different/newer execution's lease. Late events may append old execution evidence but cannot close or move a successor.

### Settlement arbitration

Disposition admission, the terminal-observation seal, and final settlement share one atomic, execution-fenced state machine. Wall-clock timestamps, arrival order outside that serialized boundary, and caller-supplied actor labels are not authority.

1. **First valid disposition wins admission, not the eventual verdict.** Accept one failed/block/review/handoff request while the matching execution is unsealed and permitted to submit. Persist its operation ID, contract/evidence identity, payload, and pending state before acknowledging it. Repeating the identical operation is idempotent, including after sealing; a different/conflicting request is rejected and attributed. A worker cannot replace a submitted disposition to conceal a subsequent failure. This is not a lane transition or capacity release.
2. **Seal on the first admitted terminal observation.** In the same fenced boundary, persist terminal evidence and seal disposition admission for that execution. A new disposition arriving after that seal is late evidence only, even if actual-stop reconciliation is still pending. It cannot resurrect a no-disposition execution or change a settled lane. If ordering/correlation cannot be established, retain uncertainty and ownership rather than assuming a disposition was admitted before the seal.
3. **Separate intentional settlement-stop from genuine failure.** After a valid disposition is durably admitted, the controller may issue a correlated stop request explicitly marked `settle_disposition`. An interrupted outcome is a normal stop acknowledgment only when the verified adapter identifies that request as its cause, confirms actual stop/managed-child settlement, and establishes no independent execution, protocol, cleanup, or side-effect failure. A plain `interrupted` event is insufficient. Budget exhaustion, unexpected interruption, cancellation by another source, and execution errors are genuine failures; unknown causes remain uncertain, not presumed benign. An authenticated human verdict/cancellation follows its own immutable authority path and cannot be converted into a worker verdict.
4. **Resolve after the stop barrier, using all known matching evidence.** Genuine failure takes precedence over pending review/handoff: record failure and settle to failed for safe bounded rework, unless an unresolved mandatory human action requires blocked. Do not create a review cycle or successful successor from the invalidated success disposition. A valid human block remains blocked with both its action requirement and any failure evidence retained. A failed disposition settles failed even if runtime exit was nominally successful. Otherwise, natural success or a proved intentional settlement-stop applies the admitted review/handoff/block disposition. Successful exit without a valid disposition is a protocol failure. Unknown stop/effect state remains settling/quarantined until reconciled; no capacity release occurs.
5. **Commit once.** Persist the matching execution settlement, round outcome, resulting lane/continuation or reviewer intent, and ownership-release decision atomically or through a proved recoverable transaction protocol. A genuine failure closes the current work round; another safe automatic rework consumes the next of the five rounds. A successful handoff plus proved intentional stop stays in its current round. Late evidence is retained against its own execution identity; it cannot silently reopen a successor or human verdict. New evidence that exposes a prior settlement mistake raises a visible reconciliation fault and human decision rather than rewriting history.

This is the target arbitration policy, not evidence that installed OpenCode supplies the required causal stop receipts or that current Jazz already serializes these boundaries. An adapter unable to distinguish expected stop from genuine failure must surface uncertainty; it cannot hide failure behind a pending success disposition.

## 6. Automatically detected/adaptive shared resource admission

### Inputs and current observations

Main reported this machine as i5-1235U, 12 logical CPUs with affinity 12, `MemTotal=16058112 kB` (approximately 15.31 GiB), and fluctuating `MemAvailable` around 5.9 GiB in its snapshot. Server cgroup ancestors showed CPU quota `max` and memory `max/high` values `max`. These are observations, not safe capacity thresholds. Unlimited cgroup values do not imply unlimited physical resources. Transient pressure readings cannot establish stable caps.

The controller must detect effective CPU constraints (affinity, cgroup quotas, relevant topology), host/cgroup memory limits and headroom, and observed workload footprints. It also accounts for provider/model concurrency, quota/rate/token budgets, service limits, and other managed consumers. Different workload classes have different resource vectors: a remote-model reasoning session, local classifier, build/test subprocess, and memory-heavy tool task are not equivalent agent slots.

Admission requires every applicable resource constraint to fit. Neither twelve logical CPUs nor total/free RAM maps directly to twelve agents or any other undocumented count. Detecting local hardware alone does not establish provider allowance. Unknown/stale constraints use a documented validated conservative envelope; without such an envelope, pause affected new admissions and surface what evidence is missing.

### Shared classes and reservations

**Proposed allocation policy:** one shared automated resource ledger, with protected capacity/headroom for control work and separately budgeted execution admissions:

- **Control:** triage, bounded rework planning, independent review. These still consume local/provider resources and have finite runtime/resource budgets.
- **Execution:** specialist work and generic cron tasks, classified by their actual resource demands. A cron request may request an appropriate generic class but never gains card-lane authority.
- **Reconciliation/stop control:** must remain operational when execution admissions are saturated; it must not depend on another effect-capable worker slot to observe or stop existing work.

Reserved control capacity prevents workers from starving review/triage; it does not guarantee an immediate spawn when a hard provider/host limit is exhausted. Allocation sizes, whether unused protected capacity can be borrowed, and fairness parameters are unresolved policy. All tool/RPC/cron/adapter entry points use the same reservations. External/unmanaged load informs headroom, but is not invented as a Jazz-owned lease.

### Adaptation and priority

Publish the current admission envelope, measurement freshness, resource estimates, active/uncertain leases, ready entitlements, limiting constraints, and reason for each defer decision. Use calibrated observations and bounded adjustment with hysteresis/stability rules; exact thresholds and sampling intervals require evidence rather than guessed constants.

When the envelope falls below current occupancy, **do not revoke live execution leases or kill threads merely because capacity fell**. Defer new admissions until confirmed releases/headroom restore fit. Undispatched entitlements may be revalidated and returned to backlog safely; running work retains its lease. Independently configured safety/runtime limits can request stop, but still require actual-stop confirmation before release.

**Proposed scheduling default:** dependency-ready, safe, budget-eligible cards ordered by priority, with deterministic age/identity tie-breaking and documented aging to avoid starvation. Aging formula/interaction with critical work is not yet approved. Waiting dependencies, cooling-down reworks, unresolved role capability, and write conflicts are excluded with visible reasons. Promote only within resource entitlements; dispatch consumes/converts them atomically, never double-counting them as both ready and free capacity.

## 7. Fresh sessions, profile resolution, and soul synchronization

The pool is **leases/admission capacity**, never a cache of reusable agent conversations. Every card execution, handoff successor, triage invocation, and review cycle uses a fresh isolated session/process. No conversation history is reused across cards. Context is bounded, explicit, and provenance-bearing: card contract, relevant evidence, handoff notes, and permitted recall. Long chat histories are not the durable work model.

Main observed 250 registry profiles, of which 12 are marked native, but 26 runtime agent IDs in both Jazz and NeoLilith locations, including exact primary `neolilith` and 18 specialist soul agents. Catalog entries, native flags, and executable runtime agents are distinct sets; these counts are not worker capacity. The imported soul corpus is stale relative to the observed runtime set.

Synchronize soul definitions from the NeoLilith source of truth with version/content provenance; validate role IDs, instructions, declared capability/permissions, model policy, and runtime resolvability. Report added/removed/drifted roles instead of pretending all 250 profiles are native. Do not edit soul identity to match Jazz's stale cache.

Triage and independent review must resolve the exact NeoLilith primary role under its default/declared runtime policy. Unresolvable required native roles fail closed with a visible fault. Prompt-composed imported personas are allowed only under a declared capability contract; their text is not native tool permission enforcement. A fallback may not silently replace a required role, model, or safety policy. Record requested and effective role/model/runtime and any permitted fallback.

Main's Foresight recall found only the cutover seed and no relevant old decisions. This establishes neither full historical knowledge nor completed memory migration. Recall is evidence with provenance, not instruction authority. NeoLilith's protocol still requires behavior-first recall, red/build/integration/real QA, independent review, docs, and memory where applicable; missing evidence is reported, never fabricated.

## 8. One independent review per cycle and immutable human verdict

A review cycle begins only after the submitted worker execution has settled. Freeze the reviewed scope/revision, attempts, artifact/commit identities, acceptance behaviors, test/QA results, known gaps, and evidence provenance. A one-paragraph success claim alone is insufficient evidence. Worker-internal QA/review does not replace this outer independent assessment.

For each cycle, persist **exactly one logical review intent**. The intent requests one fresh NeoLilith profile thread that assesses the evidence once and comments a recommendation: done, cancel, or rework when unfinished; alternatively a specific review fault/uncertainty. It does not fix the implementation, auto-approve, repeatedly poll/re-review comments, start another reviewer, or leave review. Extra comments/duplicate events do not create a new cycle. Necessary bounded evidence checks occur within that single assessment, not a self-requeue loop.

Logical once-only intent is not unconditional physical exactly-once session creation. Physical once-only spawning after a crash is conditional on a verified runtime idempotency key or reliable intent-to-session reconciliation. If the controller crashes after creation but before recording the ID and cannot identify the created session, mark spawn uncertain, retain/quarantine the reservation, and **do not create a second reviewer** for that cycle. A failed reviewer similarly reports a fault without an automatic replacement. Gavin may resolve the uncertainty/rework explicitly; a new cycle is never silently created to evade the one-review rule.

Reviewer completion does not release its capacity until execution truly stops; the card remains review. Unfinished work produces recommend rework, not review-to-triage. Only Gavin requeues, and requeue cannot silently replenish exhausted worker budget.

Gavin may accept/cancel/requeue while the assessment is queued, pending, faulted, or incomplete. Show the warning and record his explicit acknowledgment. This is not an AI approval gate. Revoke obsolete reviewer mutation capabilities/request stop if running, retain its lease until confirmed stopped, and mark late output obsolete relative to the decision. A reviewer fault cannot reverse or block a human verdict indefinitely.

A final verdict is immutable. Lifecycle events, stale recommendations, generic moves, retries, archive operations, and restart cannot reopen done/cancelled or replace the recorded decision. Subsequent work is a linked new card with its own authorization. The authorization mechanism remains to be validated: a payload actor string `gavin`, a shared service credential, or a session claiming to be Gavin is not sufficient proof of human authority.

## 9. Restart, idempotency, fencing, and side-effect safety

1. Persist intents before external creation/effects. Give card revision, triage cycle, worker attempt/stage, execution, handoff, cron occurrence, review cycle, and controller epoch distinct identities.
2. Before enabling admission on startup, reconcile unreleased intents/leases against the runtime. Adopt matching live executions under valid ownership; confirm stopped executions; quarantine unknown creation/stop state. An empty in-memory link map is not proof of no workers.
3. Use a verified exclusive mutation/admission boundary and fencing epoch. Leadership expiry is not execution termination. A stale controller must be unable to dispatch, apply dispositions, or reclaim newer leases. If storage cannot support this, constrain topology and enforce single ownership rather than claiming distributed safety.
4. Duplicate requests/events yield one logical reservation, attempt consumption, disposition, review intent, and release. Stale events operate on their own generation only. Unknown events do not acquire authority over current card state.
5. Cover crash windows between reserve/create/bind/prompt/stop/release and board/evidence writes. Runtime idempotency/reconciliation is a prerequisite for safe replay; uncertainty never authorizes duplicate effectful execution.
6. Persist backoff, resource/elapsed budgets, grants, and essential evidence/verdict records independently of capped narrative history or archive rings. Retention/deletion policy is unresolved; no automated destructive purge follows from current caps.
7. Bound cron overlap/catch-up and give each occurrence a durable identity. `fired` means dispatch/acceptance, **not task success**. Record actual execution result separately. A fire-call timeout can leave a live execution and must not free its lease or blindly refire it.
8. Do not replay unclear external effects. Require evidence of idempotency or explicit human reconciliation for irreversible/ambiguous actions.

## 10. Capability, write ownership, and human safety gates

Every worker mutation is scoped to its execution/card revision and allowed operation. Verify ownership against the lease/fence, not just the card's current profile label. Reviewer capabilities allow relevant evidence inspection and attributed comments, not work/final transitions. Arbitrary generic move/remove/archive operations cannot bypass these gates.

Acquire disjoint write ownership before admission for shared projects/files and release it only after execution/effects settle. Separate conversations are not separate checkouts. Parallel work needs explicit disjoint ownership and bounded child leases; otherwise defer the conflict. Sequential handoff does not overlap predecessor/successor writers.

No automation grants permissions to itself, expands approved scope, approves destructive actions, changes role/model policy to evade a fault, or treats untrusted card text/recall as authorization. A permission wall records the required human decision. Permission/capability validation happens before dispatch where possible; runtime surprises settle safely without an endless headless loop.

## 11. Observable surfaces

API/TUI must show lane plus execution substate, pending disposition, unresolved execution/stop status, current role and effective runtime, attempts consumed/remaining and grants, backoff deadline, dependency/write waits, capacity constraints, evidence/review identity, reviewer pending/result/fault, and immutable human verdict. Agent attribution comes from execution identity, not a caller-supplied label.

Notifications distinguish task accepted/fired from executed success/failure, worker failure from human block, retry scheduled from budget exhausted, and review recommendation from human verdict. A fault/uncertainty requiring intervention must not be muted as a routine fire notification. Generic administrative/card operations obey the same authority and preservation constraints as the specialized lifecycle API.

## 12. Evidence and gap ledger (2026-10-05 assessment)

### Repository inspection: source behavior, not live proof

Line references identify the inspected source snapshot and may move as implementation changes.

| Inspected path/section | What it establishes and target gap |
|---|---|
| `docs/design/design.md:28–54`; v2 §2/§7/§15 | Generic cron separation remains applicable; old completion, failed exit, and conflicting handoff policies are superseded here. |
| `src/dispatch.ts:24–35,49–68` | Current static default is three concurrent open-assignment cards and 60-second cooldown; planner selects ready by priority/age, not adaptive backlog admission or actual execution leases. These are CURRENT defaults, not newly approved capacity/backoff values. |
| `src/index.ts:332–361` | `work()` checks a snapshot, moves, creates, then starts assignment. It does not establish an atomic shared card/resource reservation before creation; direct work uses this path too. |
| `src/index.ts:393–438`; `src/board.ts:186,218–226` | Submit/handoff/block and generic lane moves can close assignment rows without confirming session stop. Handoff goes ready immediately. Assignment closure cannot prove capacity release. |
| `src/link.ts:57–82`; `test/unit/link-v2.test.ts:51–59` | Trailing-history no-submit streak stops at assignment/move entries; test explicitly expects assignment to reset it. The advertised consecutive-exit guard is not established across normal redispatch; target uses explicit durable counters. |
| `src/link.ts:138–148`; `src/dispatch.ts:31–39` | Links and dispatch working state are ephemeral; target restart adoption/reconciliation is not demonstrated. |
| `src/session-budget.ts:10–14,39–51`; `src/index.ts:22–34` | Watchdog excludes card workers, and records kill attempts even when interruption rejects. Existing ten-minute cron bounds and six-hop constant are CURRENT only. Retry count does not bound one running worker; request-stop is not stopped. |
| `src/index.ts:282–301,489–513,777–813`; `src/board.ts:192–228` | Verdict handler labels actor Gavin; generic moves remain available; event pump applies plans against the current card. Static inspection does not establish human authorization, all-path verdict protection, or matching-attempt late-event fencing. |
| `src/index.ts:550–561`; `src/service.ts:50–69` | Leader read/write and process-local serialized mutations are useful, but do not prove transactional cross-controller reservations/fencing. |
| `src/cron-fire.ts:55–72,121–140` | Fire record follows prompt acceptance; timeout explicitly permits a straggler. Actual task success and stop confirmation are separate obligations. |
| `src/agent-resolve.ts:19–26`; `src/index.ts:349–358` | Native resolution can fall back to default runtime. Target must distinguish an allowed composed persona from an inadmissible missing required NeoLilith role. |
| `src/board.ts:95,252`; `docs/notes/session-events.md` | Capped history/archive and historical v1 event-to-lane notes cannot be treated as the authoritative durable ledger or current stop/transition contract. |

### Observations supplied by main (not independently reproduced here)

- Live API snapshot: all nine board lanes with empty card state, cron jobs `[]`, links `[]`, routing decisions `[]`. It establishes current emptiness/availability, not a successful orchestration cycle, restart safety, or historical data recovery.
- Registry/runtime and host observations are recorded in §§6–7; they do not prove persona/model dispatch, safe capacity, or resource-control conformance.
- NeoLilith legacy loop/fan findings in §2 are code-only. Main reported no explicit role/model dispatch in the loop executor; a Jazz adapter therefore needs a proved role/model contract, not presumed compatibility.
- Main read NeoLilith's orchestration document; soul constitution/orchestration remains soul-owned. Foresight recall is limited as described in §7, not a migration/completeness claim.
- Main subsequently reproduced four pure-module mechanisms (full-cycle no-submit budget reset, stale A event closing B, assignment-based capacity release without stop, and worker-actor final move). The scratch evidence and installed runtime API boundary are recorded in [the review note](../notes/2026-10-05-factory-review.md). These probes did not execute real agent sessions or prove end-to-end event races.

Still unverified: current runtime terminal/interrupt semantics and child cleanup; create idempotency/correlation and replay; human-only authorization; atomic/fenced persistence; provider quota/limit discovery; calibrated resource classes/headroom; declared role/model enforcement; and end-to-end Jazz conformance. Historical README/design green counts are reported prior evidence, not new validation.

## 13. Acceptance matrix — observable invariants

These are requirements for future red/integration/real-QA verification, not tests run by this document's author. Use nonces and correlated execution identities; inspect actual execution/leases, not only board labels.

| ID | Scenario | Observable acceptance behavior |
|---|---|---|
| A01 | Generic cron fires | Fresh isolated task session, no implicit card transition; accepted/fired and actual outcome are distinguishable. |
| A02 | Intake event repeats / restart | One logical triage intent for the same revision/cycle; bounded NeoLilith triage; completed routing lands backlog, not directly ready. |
| A03 | Dependencies unresolved | Card remains backlog with wake condition; machine waiting is not blocked. |
| A04 | Admission / competing work entry points | Only dependency/budget/resource/write-eligible work receives entitlements; tool/RPC/cron/dispatcher races cannot over-reserve or create duplicate card executions. |
| A05 | Unequal workload classes/provider limits | Admission respects every applicable local/provider constraint; changing logical CPU count alone cannot create a matching number of agents. |
| A06 | Telemetry stale/unknown; cap falls | Validated fallback or visible pause; defer new work, retain live leases, no kill/revocation solely because envelope shrank. |
| A07 | Worker saturation with control pending | Documented protected allocation/fairness allows control progress within hard constraints; reconciliation/stop remains available. |
| A08 | Submit/block/handoff while predecessor alive | Pending disposition and stopping state visible; reservation/write ownership remain held; no successor/reviewer starts until stop proved. |
| A09 | Interrupt rejects/returns; fire times out | Request/fault recorded; unresolved execution stays occupied/quarantined; no premature release or blind refire. |
| A10 | Confirmed handoff | Predecessor evidence/ownership settled, successor queued backlog with no budget reset, then fresh correctly profiled session through admission. |
| A11 | Five failed work rounds | Initial plus up to four safe backoff reworks; persistent fifth-round failure enters blocked naming Gavin's budget/scope decision; no sixth automatic round, including after agent swaps. |
| A12 | Restart/profile change/requeue/history truncation | Attempt consumption, grants, deadlines, elapsed/resource totals survive; no hidden budget reset. |
| A13 | Unknown external effects or permission wall | No blind replay/auto-approval; explicit required human decision, even if permits remain. |
| A14 | Successful worker exit without disposition | Protocol failure and attempt settlement, never done or unbounded ready cycling. |
| A15 | Review entry/event duplicates/comments | Exactly one logical review intent; one fresh NeoLilith session when create is safely correlatable; evidence assessment once, recommendation/fault only. |
| A16 | Reviewer finds unfinished work | Recommend rework in comment; lane remains review; only Gavin requeues. |
| A17 | Crash after reviewer creation, ID unknown | Spawn marked uncertain and reservation reconciled/quarantined; no second reviewer for that cycle. |
| A18 | Reviewer fails/exits | Visible fault/result; no automatic replacement; capacity released only after actual stop; card remains review. |
| A19 | Gavin decides while reviewer pending | Warning and explicit acknowledgment recorded; human decision applied; obsolete live reviewer retains lease until stopped. |
| A20 | Agent spoofed Gavin/generic move/delete/archive | Denied verdict/state bypass; authentic human authority required; terminal decision/evidence not erased. |
| A21 | Late event/recommendation after successor/verdict | Only own old execution evidence/lease can settle; successor and immutable verdict unchanged. |
| A22 | Crash at reserve/create/bind/prompt/stop/release | Reconcile the same durable intent before admission; no duplicate effectful execution or capacity reclamation from lease expiry alone. |
| A23 | Two controllers/stale epoch | Exclusive fenced admission; stale writer cannot spawn, apply newer dispositions, or release newer leases. |
| A24 | Concurrent overlapping writes | Conflicting work deferred/rejected; disjoint owners proceed; predecessor/successor writers do not overlap. |
| A25 | Stale registry/missing role/model mismatch | Drift visible; exact required NeoLilith resolution or fail-closed fault; no silent required-role/model substitution. |
| A26 | Legacy NeoLilith loop and Jazz target same work | Duplicate authority rejected; adapted results become Jazz evidence, never a legacy auto-done Jazz verdict. |
| A27 | New card/session context | No cross-card conversation reuse; bounded explicit evidence/recall with provenance; no invented historical memory. |
| A28 | Terminal new-work request | Linked new card created through authorized intake; original verdict remains immutable. |
| A29 | Successful multi-specialist workflow | Specialist sessions/handoffs continue one round with individual leases and stage evidence; they do not consume failure-rework rounds solely by changing roles. |
| A30 | Submit review, then genuine execution failure before stop | Failure evidence overrides the pending success disposition; no review cycle/reviewer is created; safe failed recovery or explicit human block retains all evidence. |
| A31 | Handoff, then interrupted outcome | Only a proved correlated `settle_disposition` stop with no independent failure applies the handoff within its current round; unexplained/budget interruption cannot be treated as success. |
| A32 | Duplicate/conflicting/late disposition races terminal seal | Identical operation replays idempotently; conflicting requests are rejected; new post-seal requests are late evidence only; one fenced settlement/round outcome is committed. |

## 14. Implementation sequencing and open policies

This is a design sequence, not implementation authorization or code changes.

1. Publish the five-round versus specialist-stage accounting and authority/supersession mapping. Keep automated paths disabled where required runtime/resource prerequisites are unknown.
2. Verify runtime stop/child-work contract, session creation reconciliation/idempotency, actor authorization, provider discovery, role/model dispatch, and storage fencing. Record evidence and unsupported capabilities explicitly.
3. Establish durable identities, contracts, intent/lease/attempt/review/verdict ledger and human capability gates before adding automatic spawning.
4. Establish restart reconciliation, atomic reservation, actual-stop settlement, stale-event fencing, and disjoint write ownership; test crash windows before unattended execution.
5. Synchronize versioned soul profiles and validate required NeoLilith/specialist runtime mappings without changing soul identity. Define any legacy executor adapter without a second board/scheduler.
6. Calibrate workload classes and adaptive shared resource envelope/control reservations; test admission/defer behavior and fallbacks. Do not derive guessed caps from the host snapshot.
7. Add automatic triage, backlog admission/ready dispatch, specialist handoff, and five-round safe rework/backoff. Then add once-per-cycle review and warning-aware Gavin-only verdict/requeue.
8. Integrate generic cron into shared admission/outcome accounting; complete API/TUI observability and adversarial matrix. Follow behavior-first red, build, integration, real QA, independent review, docs/memory evidence before claiming delivery.

Open policies genuinely requiring confirmation/validation:

- Explicit budget-grant mechanics on human requeue/scope change. Five total work rounds and successful handoffs remaining in the current round are the captured policy (§4), not an unresolved numeric choice.
- Backoff parameters; finite per-execution/control/cron wall-time and resource budgets; nested depth limits and bounded creation/reconciliation fault handling. There is no fixed sequential handoff count; current constants are not target approval.
- Resource-class footprints/headroom, provider constraints, adjustment/hysteresis/sampling rules, protected control allocation/borrowing, and safe stale-telemetry envelope. Automatic detection/adaptation is the agreed direction; these values need measurement, not guessed CPU-to-agent ratios.
- Scheduling aging/fairness policy and interaction with critical work/dependencies.
- Runtime physical once-only capabilities, terminal/child cleanup semantics, authenticated human operation, and persistence/fencing topology. Where unavailable, fail closed rather than weaken the invariant silently.
- Essential evidence/verdict retention and authorized archive/delete rules; no current ring cap authorizes destructive purge.

No compulsory AI verdict gate, automatic human approval, reopened terminal verdict, second scheduler/card truth, or memory migration claim is introduced by this document.
