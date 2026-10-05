import { describe, expect, it } from "vitest"
import { createBoard, createCard, DEFAULT_LANES, moveCard, type BoardState } from "../../src/board"
import { applyExecutionCommand, createExecutionState, type ExecutionCommand, type ExecutionState } from "../../src/execution-state"
import { createExecutionStore, EXECUTION_STATE_KEY, ExecutionStoreError, type ExecutionEnvelope } from "../../src/execution-store"
import type { JsonStorage } from "../../src/storage"

// Hypothetical trusted ownership/stop adapters only. No production producer,
// public RPC backdoor, actual session, inference, or running conformance proof.
const EPOCH = "fixture-controller-A"
const NEXT = "fixture-controller-B"
const AT = "2026-10-05T10:00:00.000Z"
const LATER = "2026-10-05T10:01:00.000Z"
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function boardFixture(): BoardState {
  let board = createBoard()
  for (const id of ["card-A", "card-B"]) board = createCard(board, { title: `nonce:${id}`, lane: "ready" }, () => id).board
  for (const card of Object.values(board.cards)) {
    card.created = AT; card.updated = AT
    for (const entry of card.history) entry.ts = AT
  }
  return board
}
function claim(overrides: Partial<Extract<ExecutionCommand, { type: "claim" }>> = {}): Extract<ExecutionCommand, { type: "claim" }> {
  return { type: "claim", controllerEpoch: EPOCH, at: AT, operationID: "claim-A", executionID: "exec-A",
    cardID: "card-A", revisionID: "rev-A", roundID: "round-A", stageID: "stage-A", profile: "swe",
    policyFingerprint: "fixture-policy-nonce", writes: ["jazz:src/a.ts"], ...overrides }
}
function ownerFixture() {
  let live = true
  return { lose: () => { live = false }, capability: { assertWritable: async () => { if (!live) throw new Error("fixture ownership lost") } } }
}
function storageFixture(initial?: unknown) {
  const values = new Map<string, unknown>()
  if (initial !== undefined) values.set(EXECUTION_STATE_KEY, copy(initial))
  const gets: string[] = []
  const sets: { key: string; value: unknown }[] = []
  const storage: JsonStorage = {
    get: async (key) => { gets.push(key); return values.get(key) },
    set: async (key, value) => { sets.push({ key, value: copy(value) }); values.set(key, copy(value)) },
    remove: async () => { throw new Error("store must never remove") },
  }
  return { storage, values, gets, sets }
}
function envelope(state: ExecutionState, commitSequence = 7): ExecutionEnvelope {
  return { schemaVersion: 1, commitSequence, state: copy(state) }
}
function held(bound = false): ExecutionState {
  let state = applyExecutionCommand(createExecutionState(boardFixture(), EPOCH), claim())
  if (bound) state = applyExecutionCommand(state, { type: "bind_session", controllerEpoch: EPOCH, at: AT,
    executionID: "exec-A", sessionID: "session-A" })
  return state
}
function reviewed(): ExecutionState {
  let state = held(true)
  for (const command of [
    { type: "request_disposition", controllerEpoch: EPOCH, at: AT, operationID: "disposition-A", executionID: "exec-A",
      sessionID: "session-A", disposition: { kind: "review", evidence: { id: "evidence-A", revisionID: "rev-A",
        references: ["nonce:artifact"], acceptance: ["fixture behavior"], testResults: ["unit-only"], knownGaps: ["no runtime proof"], provenance: ["fixture"] } } },
    { type: "observe_terminal", controllerEpoch: EPOCH, at: AT, executionID: "exec-A", sessionID: "session-A",
      observationID: "terminal-A", outcome: "succeeded", detail: "fixture exit" },
    { type: "verify_stop", controllerEpoch: EPOCH, at: AT, executionID: "exec-A", receipt: { executionID: "exec-A",
      sessionID: "session-A", process: "stopped", children: "stopped", effects: "known", cause: "natural", independentFailure: "none" } },
    { type: "settle", controllerEpoch: EPOCH, at: AT, executionID: "exec-A" },
  ] satisfies ExecutionCommand[]) state = applyExecutionCommand(state, command)
  return state
}
async function denied(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(ExecutionStoreError)
  await expect(promise).rejects.toMatchObject({ code })
}

describe("execution store: read-only actual-runtime boundary", () => {
  it("absent inspection returns the canonical empty nine-lane state without any write", async () => {
    const fixture = storageFixture()
    const result = await createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH }).inspect()
    expect(result.source).toBe("empty")
    expect(result.envelope).toBeUndefined()
    expect(result.view).toEqual(createExecutionState(createBoard(), EPOCH))
    expect(Object.keys(result.view.board.lanes)).toEqual([...DEFAULT_LANES])
    expect(result.faults).toContain("ownership-unavailable")
    expect(fixture.gets).toEqual([EXECUTION_STATE_KEY])
    expect(fixture.sets).toHaveLength(0)
  })

  it("owner absent denies initialization, mutation and explicit recovery, with zero sets", async () => {
    const fixture = storageFixture(envelope(held()))
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: NEXT })
    await denied(store.initialize(boardFixture()), "ownership-unavailable")
    await denied(store.apply(claim()), "ownership-unavailable")
    await denied(store.apply({ type: "recover", controllerEpoch: EPOCH, nextEpoch: NEXT, at: AT }), "ownership-unavailable")
    expect(fixture.gets).toHaveLength(0)
    expect(fixture.sets).toHaveLength(0)
    expect(fixture.values.get(EXECUTION_STATE_KEY)).toEqual(envelope(held()))
  })

  it("caller booleans and actor labels are not an ownership capability", async () => {
    const fixture = storageFixture()
    const options = { storage: fixture.storage, controllerEpoch: EPOCH, verified: true, human: true, owner: true,
      actor: "gavin", ownership: { verified: true } }
    const store = createExecutionStore(options as unknown as Parameters<typeof createExecutionStore>[0])
    await denied(store.initialize(boardFixture()), "ownership-unavailable")
    expect(fixture.sets).toHaveLength(0)
  })

  it("never reads, adopts or modifies nonempty legacy board/state", async () => {
    const fixture = storageFixture()
    fixture.values.set("board/state", boardFixture())
    const before = copy(fixture.values.get("board/state"))
    const result = await createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH }).inspect()
    expect(result.source).toBe("empty")
    expect(result.view.board.cards).toEqual({})
    expect(fixture.gets).toEqual([EXECUTION_STATE_KEY])
    expect(fixture.values.get("board/state")).toEqual(before)
    expect(fixture.sets).toHaveLength(0)
  })

  it.each([false, true])("stale epoch held bound=%j is quarantined in memory only; ledger remains complete", async (bound) => {
    const persisted = envelope(held(bound))
    const fixture = storageFixture(persisted)
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: NEXT })
    const result = await store.inspect()
    expect(result.source).toBe("foundation")
    expect(result.envelope).toEqual(persisted)
    expect(result.view.controllerEpoch).toBe(NEXT)
    expect(result.view.executions["exec-A"]).toMatchObject({ reservation: "held", status: "unknown", needsReconciliation: true })
    expect(result.view.admissionPaused).toBe(true)
    expect(result.view.workRounds).toEqual(persisted.state.workRounds)
    expect(result.view.operations).toEqual(persisted.state.operations)
    expect(result.view.board).toEqual(persisted.state.board)
    expect(result.faults).toContain("recovery-not-persisted")
    result.view.executions["exec-A"]!.writes.push("jazz:caller-mutation")
    result.envelope!.state.workRounds["card-A"]!.consumed = 0
    expect(fixture.values.get(EXECUTION_STATE_KEY)).toEqual(persisted)
    expect(fixture.sets).toHaveLength(0)
  })

  it("historical stop evidence survives inspection but cannot settle under a new epoch", async () => {
    let state = reviewed()
    // A valid pre-settlement snapshot produced using the pure reducer.
    state = held(true)
    state = applyExecutionCommand(state, { type: "observe_terminal", controllerEpoch: EPOCH, at: AT,
      executionID: "exec-A", sessionID: "session-A", observationID: "terminal-A", outcome: "succeeded", detail: "fixture" })
    state = applyExecutionCommand(state, { type: "verify_stop", controllerEpoch: EPOCH, at: AT, executionID: "exec-A",
      receipt: { executionID: "exec-A", sessionID: "session-A", process: "stopped", children: "stopped", effects: "known", cause: "natural", independentFailure: "none" } })
    const fixture = storageFixture(envelope(state))
    const result = await createExecutionStore({ storage: fixture.storage, controllerEpoch: NEXT }).inspect()
    expect(result.view.executions["exec-A"]!.stopVerifiedEpoch).toBe(EPOCH)
    expect(result.view.executions["exec-A"]!.stopVerifications).toEqual(state.executions["exec-A"]!.stopVerifications)
    expect(() => applyExecutionCommand(result.view, { type: "settle", controllerEpoch: NEXT, at: AT, executionID: "exec-A" })).toThrow(/stop-unproved/)
    expect(fixture.values.get(EXECUTION_STATE_KEY)).toEqual(envelope(state))
    expect(fixture.sets).toHaveLength(0)
  })
})

describe("execution store: hypothetical owned data effects only", () => {
  it("persists late interrupted evidence against an immutable natural review settlement and pauses admission", async () => {
    const fixture = storageFixture(envelope(reviewed()))
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: ownerFixture().capability })
    const result = await store.apply({ type: "observe_terminal", controllerEpoch: EPOCH, at: LATER,
      executionID: "exec-A", sessionID: "session-A", observationID: "late-interruption", outcome: "interrupted", detail: "late fixture" })
    expect(result.state.executions["exec-A"]!.settlement).toEqual(reviewed().executions["exec-A"]!.settlement)
    expect(result.state.executions["exec-A"]!.terminalObservations).toHaveLength(2)
    expect(result.state.admissionPaused).toBe(true)
    expect(fixture.sets).toHaveLength(1)
    expect((await store.inspect()).envelope).toEqual(result)
  })

  it("whitespace-only failed detail is retained as observation but normalized to nonblank failure evidence", async () => {
    const fixture = storageFixture(envelope(held(true)))
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: ownerFixture().capability })
    const result = await store.apply({ type: "observe_terminal", controllerEpoch: EPOCH, at: AT,
      executionID: "exec-A", sessionID: "session-A", observationID: "blank-failure", outcome: "failed", detail: " " })
    expect(result.state.executions["exec-A"]!.terminalObservations[0]!.detail).toBe(" ")
    expect(result.state.executions["exec-A"]!.failureEvidence).toEqual(["execution-failure"])
    expect(fixture.sets).toHaveLength(1)
  })

  it("acknowledges one complete envelope per transition and roundtrips all retained records", async () => {
    const fixture = storageFixture()
    const owner = ownerFixture()
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: owner.capability })
    const initialized = await store.initialize(boardFixture())
    expect(initialized.commitSequence).toBe(1)
    expect(initialized.schemaVersion).toBe(1)
    const claimed = await store.apply(claim())
    expect(claimed.commitSequence).toBe(2)
    expect(claimed.state.executions["exec-A"]!.reservation).toBe("held")
    expect(claimed.state.board.cards["card-A"]!.title).toBe("nonce:card-A")
    expect(fixture.sets.map((entry) => entry.key)).toEqual([EXECUTION_STATE_KEY, EXECUTION_STATE_KEY])
    expect(fixture.values.get(EXECUTION_STATE_KEY)).toEqual(claimed)
    const inspection = await store.inspect()
    expect(inspection.envelope).toEqual(claimed)
    claimed.state.executions["exec-A"]!.failureEvidence.push("caller mutation")
    expect((await store.inspect()).view.executions["exec-A"]!.failureEvidence).toEqual([])
  })

  it("identical operation replay avoids set, sequence increment and historical overwrite", async () => {
    const fixture = storageFixture(envelope(held(true)))
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: ownerFixture().capability })
    const replay = await store.apply(claim({ at: LATER }))
    expect(replay).toEqual(envelope(held(true)))
    expect(fixture.sets).toHaveLength(0)
  })

  it("serialized competing claims reserve exactly one card/round", async () => {
    const fixture = storageFixture(envelope(createExecutionState(boardFixture(), EPOCH)))
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: ownerFixture().capability })
    const results = await Promise.allSettled([store.apply(claim()), store.apply(claim({ operationID: "claim-B", executionID: "exec-B" }))])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
    expect(results[1]).toMatchObject({ reason: { code: "card-busy" } })
    expect(fixture.sets).toHaveLength(1)
    const state = (await store.inspect()).view
    expect(Object.keys(state.executions)).toEqual(["exec-A"])
    expect(state.workRounds["card-A"]!.consumed).toBe(1)
  })

  it("initialization cannot replace any existing envelope; apply cannot implicitly initialize", async () => {
    const fixture = storageFixture(envelope(held()))
    const owner = ownerFixture().capability
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: owner })
    await denied(store.initialize(boardFixture()), "already-initialized")
    expect(fixture.sets).toHaveLength(0)
    const empty = storageFixture()
    await denied(createExecutionStore({ storage: empty.storage, controllerEpoch: EPOCH, ownership: owner }).apply(claim()), "not-initialized")
    expect(empty.sets).toHaveLength(0)
  })

  it("rejects commands until old-epoch recovery is explicitly persisted, only to this owner's epoch", async () => {
    const fixture = storageFixture(envelope(held()))
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: NEXT, ownership: ownerFixture().capability })
    await denied(store.apply(claim()), "stale-epoch")
    await denied(store.apply(claim({ controllerEpoch: NEXT })), "recovery-required")
    await denied(store.apply({ type: "recover", controllerEpoch: EPOCH, nextEpoch: "unowned-epoch", at: AT }), "stale-epoch")
    const recovered = await store.apply({ type: "recover", controllerEpoch: EPOCH, nextEpoch: NEXT, at: AT })
    expect(recovered.commitSequence).toBe(8)
    expect(recovered.state.executions["exec-A"]!.reservation).toBe("held")
    expect(recovered.state.executions["exec-A"]!.status).toBe("unknown")
    expect(fixture.sets).toHaveLength(1)
    expect(fixture.values.get(EXECUTION_STATE_KEY)).toEqual(recovered)
  })

  it.each([false, true])("failed set (committed first=%j) freezes all retries, including queued writes; reads stay available", async (committedFirst) => {
    const fixture = storageFixture(envelope(createExecutionState(boardFixture(), EPOCH)))
    const originalSet = fixture.storage.set
    fixture.storage.set = async (key, value) => {
      if (committedFirst) await originalSet(key, value)
      else fixture.sets.push({ key, value: copy(value) })
      throw new Error("ambiguous backend rejection")
    }
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: ownerFixture().capability })
    const first = store.apply(claim())
    const queued = store.apply(claim())
    void queued.catch(() => {}) // Attach immediately while asserting the first failure.
    await denied(first, "persistence-uncertain")
    await denied(queued, "writes-frozen")
    await denied(store.apply(claim()), "writes-frozen")
    await denied(store.initialize(boardFixture()), "writes-frozen")
    expect(fixture.sets).toHaveLength(1)
    const inspected = await store.inspect()
    expect(inspected.faults).toContain("writes-frozen")
    expect(Object.keys(inspected.view.executions)).toEqual(committedFirst ? ["exec-A"] : [])
  })

  it.each(["read", "write"] as const)("ownership lost mid-%s freezes writes, never claims stopped or releases durable holds", async (phase) => {
    const fixture = storageFixture(envelope(held(true)))
    const owner = ownerFixture()
    const originalGet = fixture.storage.get
    const originalSet = fixture.storage.set
    if (phase === "read") fixture.storage.get = async (key) => { const value = await originalGet(key); owner.lose(); return value }
    else fixture.storage.set = async (key, value) => { await originalSet(key, value); owner.lose() }
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: owner.capability })
    await denied(store.apply({ type: "request_stop", controllerEpoch: EPOCH, at: AT, executionID: "exec-A", operationID: "stop-A", reason: "safety" }), "ownership-lost")
    await denied(store.apply(claim()), "writes-frozen")
    expect(fixture.sets).toHaveLength(phase === "read" ? 0 : 1)
    const inspected = await store.inspect()
    expect(inspected.view.executions["exec-A"]!.reservation).toBe("held")
    expect(inspected.view.executions["exec-A"]!.settlement).toBeUndefined()
    expect(inspected.view.board.cards["card-A"]!.assignments[0]!.endedAt).toBeUndefined()
  })

  it("checks ownership on both sides of get and set", async () => {
    const fixture = storageFixture()
    const order: string[] = []
    const get = fixture.storage.get, set = fixture.storage.set
    fixture.storage.get = async (key) => { order.push("get"); return get(key) }
    fixture.storage.set = async (key, value) => { order.push("set"); await set(key, value) }
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH,
      ownership: { assertWritable: () => { order.push("owner") } } })
    await store.initialize(boardFixture())
    expect(order).toEqual(["owner", "get", "owner", "owner", "set", "owner"])
  })
})

describe("execution store: strict quarantine validation, never reset corrupt data", () => {
  it("requires reconciliation for a late live-child receipt even if no failure string or terminal event was added", async () => {
    const original = reviewed()
    const late = applyExecutionCommand(original, { type: "verify_stop", controllerEpoch: EPOCH, at: LATER, executionID: "exec-A",
      receipt: { ...original.executions["exec-A"]!.stopReceipt!, children: "live" } })
    const fixture = storageFixture(envelope(late))
    expect((await createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH }).inspect()).view.admissionPaused).toBe(true)
    delete late.executions["exec-A"]!.reconciliationFault
    late.admissionPaused = false
    const corrupt = storageFixture(envelope(late))
    await expect(createExecutionStore({ storage: corrupt.storage, controllerEpoch: EPOCH }).inspect()).rejects.toMatchObject({ code: "invalid-envelope" })
    expect(fixture.sets).toHaveLength(0)
    expect(corrupt.sets).toHaveLength(0)
  })

  it("rejects independent failure in the settlement's original review receipt rather than treating it as success", async () => {
    const persisted = envelope(reviewed())
    const record = persisted.state.executions["exec-A"]!
    record.stopReceipt!.independentFailure = { reason: "cleanup failed" }
    record.stopVerifications[0]!.receipt.independentFailure = { reason: "cleanup failed" }
    const fixture = storageFixture(persisted)
    await expect(createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH }).inspect()).rejects.toMatchObject({ code: "invalid-envelope" })
    expect(fixture.sets).toHaveLength(0)
  })

  const corruptions: [string, (value: ExecutionEnvelope) => unknown][] = [
    ["unknown version", (value) => ({ ...value, schemaVersion: 2 })],
    ["future essential state key", (value) => ({ ...value, state: { ...value.state, budgetGrants: [] } })],
    ["missing execution map", (value) => { delete (value.state as Partial<ExecutionState>).executions; return value }],
    ["unsafe map key", (value) => { Object.assign(value.state.operations, { constructor: "unsafe" }); return value }],
    ["missing card membership", (value) => { value.state.board.lanes.in_progress = []; return value }],
    ["duplicate card membership", (value) => { value.state.board.lanes.ready!.push("card-A"); return value }],
    ["malformed assignment", (value) => { value.state.board.cards["card-A"]!.assignments[0]!.profile = 7 as unknown as string; return value }],
    ["assignment index mismatch", (value) => { value.state.executions["exec-A"]!.assignmentIndex = 2; return value }],
    ["round count reset", (value) => { value.state.workRounds["card-A"]!.consumed = 0; return value }],
    ["round count above five", (value) => { value.state.workRounds["card-A"]!.consumed = 6; return value }],
    ["missing round execution link", (value) => { value.state.workRounds["card-A"]!.rounds[0]!.executionIDs = []; return value }],
    ["malformed operation fingerprint", (value) => { value.state.operations["claim-A"] = "{}"; return value }],
    ["released record still holds reservation", (value) => { value.state.executions["exec-A"]!.status = "released"; return value }],
    ["unknown execution field", (value) => { Object.assign(value.state.executions["exec-A"]!, { verified: true }); return value }],
    ["unsafe write path", (value) => { value.state.executions["exec-A"]!.writes = ["jazz:../escape"]; return value }],
    ["unsafe commit sequence", (value) => ({ ...value, commitSequence: Number.MAX_SAFE_INTEGER + 1 })],
  ]
  it.each(corruptions)("rejects %s in inspection and owned mutation with no replacement", async (_name, corrupt) => {
    const raw = corrupt(envelope(held(true)))
    const fixture = storageFixture(raw)
    const before = copy(fixture.values.get(EXECUTION_STATE_KEY))
    const store = createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH, ownership: ownerFixture().capability })
    await expect(store.inspect()).rejects.toBeInstanceOf(ExecutionStoreError)
    await expect(store.apply(claim())).rejects.toBeInstanceOf(ExecutionStoreError)
    expect(fixture.values.get(EXECUTION_STATE_KEY)).toEqual(before)
    expect(fixture.sets).toHaveLength(0)
  })

  it.each([null, [], {}, "corrupt", { schemaVersion: 1, commitSequence: 0 }])("rejects invalid envelope %j, never adopts empty", async (raw) => {
    const fixture = storageFixture(raw)
    await expect(createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH }).inspect()).rejects.toBeInstanceOf(ExecutionStoreError)
    expect(fixture.values.get(EXECUTION_STATE_KEY)).toEqual(raw)
    expect(fixture.sets).toHaveLength(0)
  })

  it("roundtrips full settled review records and never strips budget/evidence history", async () => {
    const persisted = envelope(reviewed())
    const fixture = storageFixture(persisted)
    const result = await createExecutionStore({ storage: fixture.storage, controllerEpoch: NEXT }).inspect()
    expect(result.envelope).toEqual(persisted)
    expect(result.view.workRounds).toEqual(persisted.state.workRounds)
    expect(result.view.reviews).toEqual(persisted.state.reviews)
    expect(result.view.executions).toEqual(persisted.state.executions)
    expect(result.view.operations).toEqual(persisted.state.operations)
    expect(fixture.sets).toHaveLength(0)
  })

  it("rejects a review intent not matching its settled review evidence", async () => {
    const persisted = envelope(reviewed())
    persisted.state.reviews["review:exec-A"]!.evidence.references.push("forged")
    const fixture = storageFixture(persisted)
    await expect(createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH }).inspect()).rejects.toBeInstanceOf(ExecutionStoreError)
    expect(fixture.sets).toHaveLength(0)
  })

  it.each(["overlap", "duplicate-session", "duplicate-card"])("rejects simultaneous unsafe owners: %s", async (fault) => {
    let state = held(true)
    state = applyExecutionCommand(state, claim({ operationID: "claim-B", executionID: "exec-B", cardID: "card-B", writes: ["jazz:src/b.ts"] }))
    state = applyExecutionCommand(state, { type: "bind_session", controllerEpoch: EPOCH, at: AT, executionID: "exec-B", sessionID: "session-B" })
    if (fault === "overlap") state.executions["exec-B"]!.writes = ["jazz:src"]
    if (fault === "duplicate-session") state.executions["exec-B"]!.sessionID = "session-A"
    if (fault === "duplicate-card") state.executions["exec-B"]!.cardID = "card-A"
    const fixture = storageFixture(envelope(state))
    await expect(createExecutionStore({ storage: fixture.storage, controllerEpoch: EPOCH }).inspect()).rejects.toBeInstanceOf(ExecutionStoreError)
    expect(fixture.sets).toHaveLength(0)
  })
})
