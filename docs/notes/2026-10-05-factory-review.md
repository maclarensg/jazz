# Jazz factory and NeoLilith agent-system review

Date: 2026-10-05. Reviewed source baseline:
`8bfa9fa87cf4c6e4ae62b6a530ef87c7e7ec1f40`.

This review captures Gavin's intended factory in
[`../design/factory-orchestrator.md`](../design/factory-orchestrator.md).
It does not implement that factory, alter NeoLilith's soul, or claim
end-to-end conformance from static analysis. No Jazz cards/jobs were created,
no scheduled job was fired, and no Jazz worker/reviewer was launched for the
audit. Native read-only audit subagents were used separately.

## Agreed direction and policy choices

- Cron remains generic scheduled work; it does not interpret card lanes.
- Jazz owns intake, card state, priority admission, dispatch, actual execution
  capacity, retry accounting, and review-cycle bookkeeping.
- NeoLilith triages and assigns profiles; specialists execute/handoff; a fresh
  NeoLilith thread independently reviews each review cycle once.
- Gavin alone makes the final review verdict or requests rework. A reviewer
  finding unfinished work recommends rework without moving the card.
- The initial three-attempt choice was superseded during accounting clarification
  by Gavin's final **maximum five work rounds**: initial workflow plus up to four
  failure-rework rounds, with backoff. Successful specialist handoffs stay in
  the same round; failure-driven reassignment cannot reset the card-wide ceiling.
  Exhaustion goes to **blocked**, with an explicit request for Gavin to change
  scope or authorize further budget.
- Gavin requested **automatic CPU/RAM-aware concurrency**, rather than a fixed
  four-slot pool. Provider limits and workload resource measurements also
  constrain admission; concrete thresholds require validation, not guesswork.

During clarification, Gavin proposed unlimited card-wide handoffs with a fresh
three-round allowance on each assignment. NeoLilith challenged unrestricted
failure-driven resets because they could create endless rework by alternating
agents. Gavin then set the maximum to five rounds. The target separates genuine
specialist continuation from failure rework and retains the final finite ceiling.

## Live read-only observations

The shared service returned version **2.0.9**, PID **21719**. Jazz RPC reads
returned:

| Read | Observed result |
|---|---|
| `board.get` | All nine lanes present; `cards: {}` and every lane empty |
| `cron.list` | `jobs: []` |
| `link.list` | `links: []` |
| `routing.log` | `decisions: []` |
| `profiles.stats` | `total: 250`, `native: 12` |
| `/api/agent` at Jazz location | 26 runtime agent IDs; exact `neolilith` exists in `primary` mode |

The 26 runtime IDs include NeoLilith, 18 maintained specialist roles, and seven
other built-ins. Registry entries and executable runtime agents are different
inventories. The current 12-entry native registry does not enumerate all 18
specialist soul roles. This observation does not prove persona bodies,
permissions, models, or dispatch fallback behavior conform.

### Machine resource snapshot

Read-only `/proc`, `lscpu`, CPU affinity, and actual server-cgroup ancestor reads
showed:

- CPU: **12th Gen Intel(R) Core(TM) i5-1235U**, **12 logical CPUs**;
  affinity permitted all 12.
- `/proc/meminfo`: `MemTotal: 16058112 kB` (**15.31 GiB** usable RAM).
- `MemAvailable` is volatile; the first snapshot was `6195140 kB`, and a later
  conversion reported **5.87 GiB** available. These are snapshots, not a cap.
- Swap: `SwapTotal: 32115008 kB`; swap is not a substitute for safe RAM admission.
- Server-cgroup ancestors with CPU quota exposed `cpu.max: max 100000`;
  exposed `memory.max` and `memory.high` values were `max`.

This establishes that resources can be detected. It does **not** establish a
safe agent count, measured per-profile demand, or current provider capacity.
Interactive sessions and non-Jazz applications also consume host resources.

### Runtime contract inspected, not execution-stop proof

The running server's `/openapi.json` was saved read-only at
`/tmp/opencode/jazz-factory-review-openapi.json` (SHA-256
`f558052b69bed427959774a44f973778cb382db25d5e1c94d349f053db6ddc3c`).

- `session.create` exposes optional caller-supplied `id` and `metadata` fields.
  Duplicate-create/idempotency semantics still need real-system validation.
- `experimental.session.wait` describes waiting for the **agent loop to become
  idle**, not proof that every subprocess/background operation has stopped.
- `session.active` describes **foreground drains owned by this OpenCode
  process**; absence is not universal proof of no background/external work.
- `session.interrupt` reports interruption of execution owned by this process
  or an idle no-op. Cancellation cooperation and descendant cleanup need tests.

The V2 plugin guide also distinguishes `session.prompt` admission from execution
completion and tells tool executors to cooperate with cancellation signals.
References: [V2 plugins](https://opencode.ai/v2/docs/build/plugins),
[V2 API](https://opencode.ai/v2/docs/api). These published interfaces do not
replace conformance checks against the installed 2.0.9 runtime.

## Mechanisms reproduced using current pure modules

The diagnostic script imported transpiled copies of the real `board.ts`,
`link.ts`, and `dispatch.ts` without modifying source. It applied their actual
functions in the order used by current work/handoff/event paths. It did not run
the deployed event pump or real agent sessions, so these are **mechanism
reproductions**, not end-to-end race tests.

Scratch evidence:
`/tmp/opencode/jazz-factory-review.j8OdHLYc/diagnostic.mjs` and
`diagnostic-output.txt`. Output SHA-256:
`7b23c780f016ca83fa11a48dd29a95bd7d97a46f2bb26f0e98fb13a9f6a4c20d`.
These paths are temporary session artifacts, not recoverable from a clean
checkout. The self-contained recipe below preserves the mechanisms without
requiring those files.

| Probe | Exact observed mechanism |
|---|---|
| Four complete no-submit cycles | Every cycle saw `streakBeforeExit: 0` and ended `laneAfterExit: "ready"`; normal move/assignment history resets the purported consecutive-exit guard |
| Old A failure after handoff to B | Applying the current outcome plan closed session B's assignment as failed and moved the card to failed; the plan has no execution identity fence |
| Review move while old runtime remains unchecked | With `maxInFlight: 1`, moving the running card to review closed its assignment and selected the queued card; no runtime stop was checked |
| Generic final move by worker actor | `moveCard(..., "done", ..., {actor: "worker"})` succeeded and recorded that actor |

Relevant source: `src/link.ts:57–82,107–121`,
`src/board.ts:192–228,336–380`, `src/dispatch.ts:46–68`, and the event-pump
application path `src/index.ts:489–513`. The direct move probe demonstrates the
absence of a guard in board logic; static inspection of generic tool/RPC paths
establishes their exposure. An authenticated end-to-end abuse test was not run.

### Durable reproduction recipe

From the Jazz checkout after installing its normal development dependencies,
run the following with Node.js. It transpiles the three current pure modules
in memory; it writes no files and touches no service, stored card, or cron job.
Expected results describe baseline `8bfa9fa`, not the proposed factory; future
implementation may deliberately change them.

```bash
node --input-type=module <<'JS'
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const ts = createRequire(`${process.cwd()}/package.json`)('typescript');
async function load(name) {
  const source = await fs.readFile(`src/${name}.ts`, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  }});
  return import(`data:text/javascript,${encodeURIComponent(outputText)}`);
}
const b = await load('board'), l = await load('link'), d = await load('dispatch');
let state = b.createCard(b.createBoard(), { title: 'probe', lane: 'ready' }, () => 'p').board;
const cycles = [];
for (let i = 1; i <= 4; i++) {
  state = b.moveCard(state, 'p', 'in_progress');
  state = b.startAssignment(state, 'p', 'swe', { sessionID: `run-${i}` });
  const streak = l.noSubmitStreak(state.cards.p);
  const plan = l.planOutcome(state.cards.p, 'succeeded');
  if (plan.close) state = b.endAssignment(state, 'p', plan.close.outcome, { detail: plan.close.detail });
  if (plan.comment) state = b.addComment(state, 'p', { author: 'system', body: plan.comment }, () => `c-${i}`).board;
  if (plan.target) state = b.moveCard(state, 'p', plan.target);
  cycles.push([streak, state.cards.p.lane]);
}
console.log('no-submit cycles', JSON.stringify(cycles));
state = b.moveCard(state, 'p', 'in_progress');
state = b.startAssignment(state, 'p', 'swe', { sessionID: 'A' });
state = b.endAssignment(state, 'p', 'handoff');
state = b.moveCard(state, 'p', 'ready');
state = b.assignProfile(state, 'p', 'qa');
assert.equal(state.cards.p.profile, 'qa');
assert.equal(state.cards.p.history.at(-1).detail, 'qa');
state = b.moveCard(state, 'p', 'in_progress');
state = b.startAssignment(state, 'p', 'qa', { sessionID: 'B' });
const stale = l.planOutcome(state.cards.p, 'failed');
if (stale.close) state = b.endAssignment(state, 'p', stale.close.outcome, { detail: stale.close.detail });
if (stale.target) state = b.moveCard(state, 'p', stale.target);
console.log('stale A closes', state.cards.p.assignments.at(-1).sessionID,
  state.cards.p.assignments.at(-1).outcome);
let capacity = b.createCard(b.createBoard(), { title: 'running', lane: 'in_progress' }, () => 'running').board;
capacity = b.startAssignment(capacity, 'running', 'swe', { sessionID: 'not-stop-checked' });
capacity = b.createCard(capacity, { title: 'queued', lane: 'ready' }, () => 'queued').board;
const cfg = { ...d.DEFAULT_DISPATCH, maxInFlight: 1 };
console.log('selection before move', JSON.stringify(d.dispatchableCards(capacity, d.createDispatchState(), cfg, new Date()).map(c => c.id)));
capacity = b.moveCard(capacity, 'running', 'review');
console.log('selection after review move', JSON.stringify(d.dispatchableCards(capacity, d.createDispatchState(), cfg, new Date()).map(c => c.id)));
console.log('submit then fail', JSON.stringify(l.planOutcome(capacity.cards.running, 'failed')));
capacity = b.moveCard(capacity, 'queued', 'done', undefined, { actor: 'worker' });
console.log('worker generic move', capacity.cards.queued.lane);
state = b.moveCard(state, 'p', 'blocked');
console.log('blocked then success', l.transitionLane(state.cards.p, 'succeeded'));
JS
```

Expected baseline output:

```text
no-submit cycles [[0,"ready"],[0,"ready"],[0,"ready"],[0,"ready"]]
stale A closes B failed
selection before move []
selection after review move ["queued"]
submit then fail {"target":null,"close":null,"comment":null}
worker generic move done
blocked then success ready
```

The last two lifecycle probes were added after independent review: current
review-lane protection hides a later linked failure, and current blocked state
can return to ready on success. The target settlement arbitration and lane
authority replace these mechanisms; the recipe itself is not a conformance
test of that future implementation.

## Existing NeoLilith system: reuse contracts, not a second factory

Read-only inspection of the NeoLilith checkout found:

- `docs/design/neolilith-orchestration.md` and maintained orchestration role:
  recall/acceptance, red-before-build, bounded specialist assignments,
  integration, real QA, independent review, documentation, and curated memory.
  Worker exit success is not completion; Laya is advisory; runtime/model defaults
  and actual permission enforcement remain authoritative.
- `core/runtime/fan.py`: fresh isolated subprocess/conversation dispatch with a
  per-batch `ThreadPoolExecutor`, default four workers and depth guard. This is
  not a persistent global execution pool or a cross-invocation capacity lease.
- `core/runtime/loop.py`, `executor.py`, `capabilities.py`, and
  `core/brain/run_journal.py`: an independent legacy card engine with contract,
  capability, dependency/write-conflict, retry, and recovery-journal concepts.
  Its code can auto-complete its own cards when a returned envelope says
  `verified`; that is incompatible with Jazz's human-only outer verdict.

No legacy local-brain data was read or written, and the separate loop was not
started. These are code/document findings, not claims about a currently deployed
legacy loop. Jazz must be the single card authority for this factory; the legacy
loop must not compete for the same work. Soul orchestration remains soul-owned;
Jazz's design does not rewrite it.

## Verification boundary

The architect and code-exploration audits agree that automatic triage,
backlog-to-ready admission, actual-session capacity, failed rework, and one
NeoLilith reviewer per cycle are not present end-to-end. Existing green unit
tests cover parts of the legacy behavior, including early assignment closure
and retry-streak reset; they do not establish the target invariants.

Required future running-system variants include stale events after handoff,
blocked preservation, all spawn-path capacity enforcement, descendant/stop
reconciliation, repeated full-cycle retry exhaustion, reviewer crash uncertainty,
human authorization across generic mutations, simultaneous leaders, and restart
at every reserve/create/bind/stop boundary. The target contract contains the
implementation sequence and acceptance matrix; no factory implementation is
declared done by this review.

### Documentation closure evidence

- Main observed the missing canonical README link as a failing documentation
  check before wiring supersession and the new contract.
- Independent review initially recommended rework because a pending disposition
  could conflict with a later execution failure. The contract now defines
  atomic admission/sealing/settlement, genuine-failure precedence, and verified
  intentional stop acknowledgments; A30–A32 exercise those future invariants.
  Follow-up independent review accepted the contract with no normative blocker.
- The reviewer identified an incorrect argument shape in the diagnostic recipe.
  Main corrected it to `assignProfile(board, id, 'qa')`, added profile/history
  assertions, and reran both the durable recipe and original scratch probe.
  The durable expected output matched exactly. This correction did not change
  the reproduced findings, but prevents a malformed intermediate profile.
- Final documentation checks covered **six Markdown files**, **17 resolving
  local links**, no trailing whitespace, the five-round policy, and **32
  acceptance cases**. `git diff --check` passed.
- Main's unit regression passed **175 tests in 19 files**; typechecking passed.
  The independent reviewer separately passed **175 tests in 19 files** and
  typechecking during its first pass. These validate unchanged legacy source,
  not the target factory. No target lifecycle integration/QA execution was run
  because this was a documentation-only review.
- Source, tests, scripts, dependencies, configuration, and NeoLilith profile
  definitions remain unchanged from the reviewed source baseline. No Jazz
  cards/jobs were created or fired. No commit or push was performed for these
  documentation changes.
