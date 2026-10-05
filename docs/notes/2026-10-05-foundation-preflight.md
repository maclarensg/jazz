# Jazz execution foundation — isolated preflight and nonexecuting checkpoint

Date: 2026-10-05. Published design baseline:
`2ca426c3f9ec7536d193e3928eb85c967398bb9c`.

Gavin selected **Publish + build**, then **Fail closed** for verdicts, requeues
and budget grants until human authority is established. The six reviewed design
documents were committed/pushed as `2ca426c`. This subsequent implementation is
a bounded checkpoint, **not completion of the execution controller or factory**.
Tracking card `6381fec6` remains open for the larger foundation acceptance.

## Observable delivered behavior

- A pure immutable execution-state reducer records claims, session correlation,
  first-valid dispositions, terminal seals, hypothetical internal stop proofs,
  settlement, deferred review intent and five card-wide work rounds. Successful
  specialist stages share their round; reassignment does not reset the ceiling.
- The internal store validates a single `factory/state/v1` JSON envelope and
  serializes its own mutation queue. A trusted ownership adapter is required
  before **any** write; no such producer is wired into the running foundation.
  Ambiguous saves/ownership loss freeze writes rather than retrying blindly.
- The opt-in foundation branch substitutes diagnostic/read handlers and denials
  before any legacy watchdog, event pump, worker, cron tick or dispatcher setup.
  Public intake/comment/lifecycle/cron/inbox mutations and execution all fail
  closed. There is no public reducer, receipt, ownership or budget-grant API.
- `factory.status` exposes missing prerequisites and retained unknown leases.
  Read-only recovery preserves the original durable envelope, round budget and
  session identity; it **does not persist recovery or prove runtime settlement**.
- Legacy state is refused, not adopted/dual-written. Unknown schema, malformed
  state or counter reset makes `leaseInventoryKnown: false`; inventory is not
  presented as empty. Legacy mode remains the default and is unchanged.

## What the installed runtime actually demonstrated

The initial main-owned probe used unique scratch storage under
`/tmp/opencode/jazz-foundation-preflight.rkJooZmq`. Its successful run made
**24 HTTP requests across two owned OpenCode 2.0.9 server epochs**, with no
prompt/model API call. The installed repository SDK packages were 2.0.18;
runtime behavior was checked against the isolated server, not inferred from
those newer declarations.

| Surface | Observed result | Consequence / limit |
|---|---|---|
| RPC handler context | Exact keys `error`, `signal`; version `2.0.9` | No authenticated human subject reaches this handler. Role/actor labels, a shared service credential or a TUI dialog are not Gavin proof. |
| Caller-supplied session ID | Sequential replay and four concurrent same-ID creates returned the same session | Useful correlation primitive; must check returned binding/policy, not assume a new create took effect. |
| Conflicting same-ID payload | HTTP 200 with the original title/metadata | It does not reject payload conflicts. Never treat success status as matching intent. |
| Metadata-only duplicate create | Two distinct sessions with matching metadata | Metadata is not a uniqueness constraint. |
| Graceful restart | Original session lookup and exact plugin-storage nonce survived | Lookup/acknowledged storage survived this graceful restart, not arbitrary crash/power loss; create replay after restart was not exercised. |
| Direct owned shell child | `active` returned `{}`; `wait` returned 204; `interrupt` returned `{"interrupted":false}` while the child was alive | Foreground-idle APIs are not a descendant-stop inventory or release receipt. |
| Writes after that interrupt | Marker grew **15 bytes** in the observation window; shell returned 204 after its bounded natural completion | The owned child continued effects. This direct-shell case does not characterize every agent-loop interrupt. |

The original stored nonce was `84cab226971eb6244cec8080`. Owned server PIDs
274949/274995 and child PID 274971 were confirmed absent afterward. Raw results,
OpenAPI and redacted logs remain in that scratch directory; they are historical
artifacts, not the durable reproduction route.

Read-only inspection of a backup of that owned stopped-server database found
the plugin nonce in the SQLite `kv` table. The key was plugin-scoped globally,
not an isolated per-project board. The table's primary key and one graceful
round-trip do **not** prove a public CAS/transaction API or exclusive controller.
The plugin storage API exposes get/set/remove/scan, not CAS or transactions.

A separate owned `flock` probe rejected a second cooperating process with exit
75 while held and admitted a nonce-emitting process after release. This proves
that host primitive only. No lock producer, takeover fencing, backend durability
contract, hostile same-UID protection or descendant-stop barrier was built.

## Behavior-first construction and adversarial review

Before implementation, an actual copied Jazz entrypoint on an owned isolated
server received the future foundation setup option. A terminal card create
returned HTTP 200, producing `235f3416` in `done`, where the behavioral check
required `400 / foundation_denied`. This was the meaningful running-system red
check. The extra actor input was stripped by the existing creation schema; this
is **not** evidence that an authenticated actor was spoofed.

Missing-module unit reds were recorded separately and are not described as
running-system conformance. Reducer implementation subsequently exposed genuine
behavior failures before becoming green. Independent review then refuted green
tests with seven concrete variants; each was reproduced and regression-tested:

1. Reusing retired epochs A→B→A resurrected stale stop proof. Retired epochs are
   now retained and cannot be reused.
2. Optional `undefined` receipt fields broke JSON-normalized replay identity.
   Canonical object fingerprints now ignore undefined-valued properties.
3. Sparse evidence arrays occupied the first-valid disposition slot despite
   containing no evidence. Dense position validation rejects them and sparse
   write-ID arrays.
4. Store validation discarded legitimate late interruption faults after review.
   Immutable settlement prefix counts now distinguish initial inputs from late
   terminal/failure evidence; late faults persist and pause admission.
5. Whitespace-only failure detail produced an unpersistable failure record.
   The raw observation remains; failure evidence gets a nonblank fallback.
6. A corrupted successful review with independent failure in its original stop
   receipt passed validation. Successful review/handoff settlement cannot now
   contain original genuine-failure inputs.
7. A late live-child receipt could lose its fault/pause and pass inspection.
   Settlement also freezes the stop-verification prefix; any later verification
   requires the retained reconciliation fault, even without new failure strings.

The read-only security audit accepted the controlled public-entrypoint lockdown,
not authenticated human actions or runtime confinement. Independent QA repeated
the initial four actual-server cases successfully, then stopped when a scratch
artifact read was denied; no alternate access was used. The first runtime worker
likewise stopped at a denied scratch-file write and launched no server. Main
used its own already-approved scratch scope without relaxing worker permissions.
A store worker returned a runtime `Agent not found` error after leaving files;
main reviewed those artifacts, reproduced their integration failures and owns
their integration—no successful worker exit is claimed.

## Durable runnable verification

From the checkout, with dependencies installed and `opencode2` available:

```bash
npm test
npm run typecheck
./node_modules/.bin/vitest run \
  test/integration/foundation.integration.test.ts \
  test/integration/foundation-adversarial.integration.test.ts \
  test/integration/runtime-preflight.integration.test.ts \
  --fileParallelism false
git diff --check
```

Unlike the legacy integration staging recipe, these tests do not copy provider
or authentication configuration and do not require model credits. They stage
the actual current source in fresh `/tmp/opencode/jazz-foundation-it-*`
namespaces, isolate all XDG paths, verify the owned database/PID target, retain
redacted logs, signal the owned process group, await server exit and verify its
PID is absent. This does not prove that every process-group member stopped.
The bounded shell child is nonce-identified
and checked absent after natural completion.

The test entrypoint injects factory setup options; activation through the
ordinary config loader has **not** been validated. The copied test entrypoint
seeds synthetic retained state during setup, before component counters. Its
private fixture RPCs inspect counters/state and invoke captured registered tool
executors. Production code has no seed/receipt endpoint. Consequently:

- `writes=0` means **zero foundation-component writes after fixture seeding**,
  not that the whole server or test preparation never writes.
- Registered executor denial is actual plugin/runtime integration, **not** an
  agent-prompt/permission-sandbox test.
- Synthetic stop receipts and held sessions are internal fixtures, **not**
  evidence that a real worker stopped or that ownership was acquired.
- Installed-runtime creation/direct-shell probes are explicitly separate from
  Jazz factory execution; they create only inference-free isolated test sessions.

Main's final integrated run passed **315 unit tests across 23 files**, typechecking,
and **10 real-runtime integration tests across three files**. It covered:

| Actual-runtime suite | Cases |
|---|---:|
| Foundation: denial, retained-state restart, corruption, legacy comparison | 4 |
| Adversarial: concurrent review/create denial, round reset, legacy board/cron refusal | 4 |
| Installed creation/metadata and continuing direct-shell child probes | 2 |

These counts describe that run; use fresh command output for future claims.
Independent QA accepted the ten actual-runtime cases on its own fresh run and
verified **13 owned server PIDs** stopped plus the bounded shell child exited.
That QA run preceded the final stop-verification-prefix correction; main reran
all ten cases after that correction. Security accepted the read-only public
lockdown through source review, not an independently rerun runtime test.
Final independent code review accepted the scoped reducer/store and read-only
branch after closing all seven reproduced findings. Its final focused run passed
**123 tests** (76 reducer and 47 store); it did not rerun runtime integration or
claim exhaustive receipt-permutation coverage. Documentation review's seeding
and cleanup wording corrections are incorporated above.
No complete legacy model-dependent integration suite or foundation TUI pass was
performed. No production service/configuration was restarted or altered by the
preflight/test deployment, and no Jazz factory worker/reviewer was dispatched.

## Required next gates — full foundation acceptance remains open

1. Establish a real exclusive persistence owner, stable database/namespace
   identity, durable fencing and crash-window reconciliation. A local Promise
   queue or a configurable directory name is insufficient.
2. Build/verify an execution adapter that tracks managed descendants/effects,
   correlates intentional settlement stops and retains uncertain leases.
   Idle/wait/interrupt alone are demonstrably insufficient for the shell case.
3. Establish a separately trusted human-verdict authority channel and enforced
   isolation. Until then, verdict/requeue/grant remain unavailable in foundation.
4. Validate effective role/model/permission mappings, finite runtime bounds,
   shared cron/resource admission, actual worker/reviewer lifecycles, restart
   creation reconciliation and disjoint canonical write ownership.
5. Only then build triage/backlog admission, safe five-round rework, once-per-cycle
   reviewer spawning and adaptive capacity calibration; exercise the canonical
   [factory acceptance matrix](../design/factory-orchestrator.md).

Unexercised variants include abrupt running-worker/child restart, post-restart
create replay, two executing controllers, power loss, filesystem aliases,
no-effect launch rollback, real agent permissions, real human authentication,
config-loader activation, production migration/hot reload and the foundation UI.
Neither this checkpoint nor a green legacy suite closes those gaps.
