import { describe, expect, it } from "vitest"
import { createBoard, createCard, moveCard, type BoardState } from "../../src/board"
import {
  createExecutionState,
  applyExecutionCommand,
  ExecutionStateError,
  guardFoundationMutation,
} from "../../src/execution-state"

/**
 * Foundation contract only: one JSON envelope, immutable deterministic commands.
 * No controller/store/RPC wiring, admission scheduler, or effectful launch here.
 * Commands are INTERNAL trusted-controller inputs, never public authorization.
 * In particular, verify_stop fixtures assume a hypothetical verified adapter;
 * these objects DO NOT authenticate a stop, establish installed-runtime child
 * cleanup, or authorize exposing caller-supplied receipts over tool/RPC APIs.
 * No human-verdict input exists: human authority is unavailable and fails closed.
 * Test-only readyFixture represents future admission, not an implemented scheduler.
 * Proved no-effect launch rollback is deliberately deferred: ambiguous claims hold.
 */
type State = ReturnType<typeof createExecutionState>
type Command = Parameters<typeof applyExecutionCommand>[1]
type Claim = Extract<Command, { type: "claim" }>
type Disposition = Extract<Command, { type: "request_disposition" }>
type StopVerification = Extract<Command, { type: "verify_stop" }>
type Mutation = Parameters<typeof guardFoundationMutation>[1]

const EPOCH = "controller-A"
const AT = "2026-10-05T10:00:00.000Z"
const LATER = "2026-10-05T10:01:00.000Z"
const evidence = {
  id: "snapshot-A",
  revisionID: "revision-1",
  references: ["commit:fixture-only"],
  acceptance: ["observable acceptance behavior"],
  testResults: ["synthetic unit evidence, not real-system QA"],
  knownGaps: ["runtime adapter not proved"],
  provenance: ["internal test fixture"],
}

function boardFixture(): BoardState {
  let board = createBoard()
  for (const id of ["card-A", "card-B", "card-C"]) {
    board = createCard(board, { title: id, lane: "ready" }, () => id).board
  }
  return board
}

function fresh(): State {
  return createExecutionState(boardFixture(), EPOCH)
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    type: "claim", controllerEpoch: EPOCH, operationID: "claim-A",
    executionID: "execution-A", cardID: "card-A", revisionID: "revision-1",
    roundID: "round-1", stageID: "stage-A", profile: "swe",
    policyFingerprint: "policy-1", writes: ["jazz:src/board.ts"], at: AT,
    ...overrides,
  }
}

function disposition(overrides: Partial<Disposition> = {}): Disposition {
  return {
    type: "request_disposition", controllerEpoch: EPOCH,
    operationID: "disposition-A", executionID: "execution-A",
    sessionID: "session-A", disposition: { kind: "review", evidence }, at: AT,
    ...overrides,
  }
}

function bound(): State {
  return applyExecutionCommand(applyExecutionCommand(fresh(), claim()), {
    type: "bind_session", controllerEpoch: EPOCH, executionID: "execution-A",
    sessionID: "session-A", at: AT,
  })
}

function terminal(
  state: State,
  outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
  executionID = "execution-A",
  sessionID = "session-A",
): State {
  return applyExecutionCommand(state, {
    type: "observe_terminal", controllerEpoch: state.controllerEpoch,
    executionID, sessionID, observationID: `terminal-${executionID}-${outcome}`,
    outcome, detail: `fixture ${outcome}`, at: AT,
  })
}

function verification(overrides: Partial<StopVerification["receipt"]> = {}): StopVerification {
  return {
    type: "verify_stop", controllerEpoch: EPOCH, executionID: "execution-A", at: AT,
    receipt: {
      executionID: "execution-A", sessionID: "session-A", process: "stopped",
      children: "stopped", effects: "known", cause: "natural",
      independentFailure: "none", ...overrides,
    },
  }
}

function settle(state: State, executionID = "execution-A"): State {
  return applyExecutionCommand(state, {
    type: "settle", controllerEpoch: state.controllerEpoch, executionID, at: AT,
  })
}

function stopped(state: State, overrides: Partial<StopVerification["receipt"]> = {}): State {
  const command = verification(overrides)
  return applyExecutionCommand(state, {
    ...command, controllerEpoch: state.controllerEpoch,
    executionID: command.receipt.executionID,
  })
}

function readyFixture(state: State, cardID = "card-A"): State {
  return { ...state, board: moveCard(state.board, cardID, "ready") }
}

function denied(run: () => unknown, code: string): void {
  let error: unknown
  try { run() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ExecutionStateError)
  expect((error as ExecutionStateError).code).toBe(code)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

describe("execution foundation: reservation and durable identity", () => {
  it.each([
    ["jazz:src", "jazz:src/board.ts"], ["jazz:src/board.ts", "jazz:src"],
  ])("lexical ancestor write %s conflicts with %s", (first, second) => {
    const state = applyExecutionCommand(fresh(), claim({ writes: [first] }))
    denied(() => applyExecutionCommand(state, claim({ operationID: "claim-B",
      executionID: "execution-B", cardID: "card-B", writes: [second],
    })), "write-conflict")
    const sibling = applyExecutionCommand(state, claim({ operationID: "claim-C",
      executionID: "execution-C", cardID: "card-C", writes: ["jazz:src-other/board.ts"],
    }))
    expect(sibling.executions["execution-C"]!.reservation).toBe("held")
  })

  it.each(["__proto__", "constructor", "prototype", "", "has space", "../escape"])(
    "rejects unsafe internal identity %j", (badID) => {
      for (const field of ["operationID", "executionID", "cardID", "revisionID", "roundID", "stageID"] as const) {
        denied(() => applyExecutionCommand(fresh(), claim({ [field]: badID })), "bad-id")
      }
      denied(() => createExecutionState(boardFixture(), badID), "bad-id")
      denied(() => applyExecutionCommand(bound(), { type: "bind_session", controllerEpoch: EPOCH,
        executionID: "execution-A", sessionID: badID, at: AT }), "bad-id")
    },
  )

  it("rejects untracked open legacy assignments rather than pretending to own them", () => {
    const board = boardFixture()
    board.cards["card-A"]!.assignments = [{ profile: "legacy-worker", sessionID: "legacy-session", startedAt: AT }]
    denied(() => createExecutionState(board, EPOCH), "untracked-assignment")
  })

  it.each(["__proto__", "constructor", "prototype"])("constructor rejects reserved board card key %j", (badID) => {
    const board = createCard(createBoard(), { title: "unsafe identity" }, () => badID).board
    denied(() => createExecutionState(board, EPOCH), "bad-id")
  })

  it("claim replay ignores observed time and preserves later binding rather than restoring an old snapshot", () => {
    const state = bound()
    expect(applyExecutionCommand(state, claim({ at: LATER }))).toEqual(state)
  })

  it("returns a JSON-serializable envelope without mutating board or commands", () => {
    const board = freeze(boardFixture())
    const state = freeze(createExecutionState(board, EPOCH))
    const command = freeze(claim())
    const before = JSON.stringify(state)
    const next = applyExecutionCommand(state, command)
    expect(JSON.stringify(state)).toBe(before)
    expect(JSON.parse(JSON.stringify(next))).toEqual(next)
    expect(applyExecutionCommand(state, command)).toEqual(next)
    expect(next).not.toBe(state)
    expect(board.cards["card-A"]!.lane).toBe("ready")
    expect(next.executions["execution-A"]!.claimedAt).toBe(AT)
  })

  it("claims before session creation, auditing identities and holding ownership", () => {
    const state = applyExecutionCommand(fresh(), claim())
    expect(state.executions["execution-A"]).toMatchObject({
      executionID: "execution-A", cardID: "card-A", revisionID: "revision-1",
      roundID: "round-1", stageID: "stage-A", profile: "swe",
      policyFingerprint: "policy-1", controllerEpoch: EPOCH,
      status: "reserved", reservation: "held", writes: ["jazz:src/board.ts"],
    })
    expect(state.executions["execution-A"]!.sessionID).toBeUndefined()
    expect(state.board.cards["card-A"]!.lane).toBe("in_progress")
    expect(state.board.cards["card-A"]!.assignments).toHaveLength(0)
    expect(state.workRounds["card-A"]!.consumed).toBe(1)
    expect(Object.keys(state.reviews)).toHaveLength(0)
  })

  it("deduplicates an identical claim operation but rejects changed payload", () => {
    const state = applyExecutionCommand(fresh(), claim())
    expect(applyExecutionCommand(state, claim())).toEqual(state)
    for (const changed of [
      claim({ executionID: "execution-other" }), claim({ cardID: "card-B" }),
      claim({ writes: ["jazz:src/link.ts"] }), claim({ profile: "qa" }),
    ]) denied(() => applyExecutionCommand(state, changed), "operation-conflict")
    expect(Object.keys(state.executions)).toHaveLength(1)
    expect(state.workRounds["card-A"]!.consumed).toBe(1)
  })

  it("rejects competing claims for a held card or reused execution identity", () => {
    const state = applyExecutionCommand(fresh(), claim())
    denied(() => applyExecutionCommand(state, claim({
      operationID: "claim-other", executionID: "execution-other",
    })), "card-busy")
    denied(() => applyExecutionCommand(state, claim({
      operationID: "claim-other", cardID: "card-B", writes: ["jazz:src/link.ts"],
    })), "execution-conflict")
  })

  it("rejects overlapping canonical write IDs but permits disjoint reservations", () => {
    const state = applyExecutionCommand(fresh(), claim())
    const other = claim({ operationID: "claim-B", executionID: "execution-B", cardID: "card-B" })
    denied(() => applyExecutionCommand(state, other), "write-conflict")
    const next = applyExecutionCommand(state, { ...other, writes: ["jazz:src/link.ts"] })
    expect(Object.values(next.executions).filter((e) => e.reservation === "held")).toHaveLength(2)
  })

  it.each(["", " jazz:src/a.ts", "jazz:../a.ts", "jazz:src//a.ts"])(
    "rejects noncanonical write ID %j (not filesystem alias validation)", (write) => {
      denied(() => applyExecutionCommand(fresh(), claim({ writes: [write] })), "bad-write-id")
    },
  )

  it("requires ready intake for claims, not terminal/review bypass", () => {
    for (const lane of ["triage", "review", "done", "cancelled", "blocked", "failed"]) {
      const state = { ...fresh(), board: moveCard(boardFixture(), "card-A", lane) }
      denied(() => applyExecutionCommand(state, claim()), "claim-lane")
    }
  })

  it("binds exactly one fresh session to one execution and one matching assignment", () => {
    const state = bound()
    expect(state.executions["execution-A"]).toMatchObject({ sessionID: "session-A", status: "running" })
    expect(state.board.cards["card-A"]!.assignments).toEqual([
      { profile: "swe", sessionID: "session-A", startedAt: AT },
    ])
    const bind = { type: "bind_session" as const, controllerEpoch: EPOCH,
      executionID: "execution-A", sessionID: "session-A", at: AT }
    expect(applyExecutionCommand(state, bind)).toEqual(state)
    denied(() => applyExecutionCommand(state, { ...bind, sessionID: "session-other" }), "session-conflict")
    const other = applyExecutionCommand(state, claim({
      operationID: "claim-B", executionID: "execution-B", cardID: "card-B", writes: ["jazz:src/link.ts"],
    }))
    denied(() => applyExecutionCommand(other, { ...bind, executionID: "execution-B" }), "session-conflict")
  })

  it("never reuses a settled session as the successor's fresh session", () => {
    let state = applyExecutionCommand(bound(), disposition({
      disposition: { kind: "handoff", evidence, nextProfile: "qa", reason: "remaining acceptance work" },
    }))
    state = settle(stopped(terminal(state)))
    state = applyExecutionCommand(readyFixture(state), claim({
      operationID: "claim-successor", executionID: "execution-successor", stageID: "stage-B", profile: "qa",
    }))
    denied(() => applyExecutionCommand(state, {
      type: "bind_session", controllerEpoch: EPOCH, executionID: "execution-successor",
      sessionID: "session-A", at: AT,
    }), "session-conflict")
  })
})

describe("execution foundation: disposition seal and stop barrier", () => {
  it("rejects sparse evidence and write arrays before occupying the first-valid slot", () => {
    for (const field of ["acceptance", "provenance", "references", "testResults", "knownGaps"] as const) {
      const state = bound()
      const before = JSON.stringify(state)
      denied(() => applyExecutionCommand(state, disposition({ disposition: {
        kind: "review", evidence: { ...evidence, [field]: new Array<string>(1) },
      } })), "bad-disposition")
      expect(JSON.stringify(state)).toBe(before)
      expect(state.executions["execution-A"]!.pendingDisposition).toBeUndefined()
      expect(applyExecutionCommand(state, disposition()).executions["execution-A"]!.pendingDisposition).toBeDefined()
    }
    const state = fresh()
    denied(() => applyExecutionCommand(state, claim({ writes: new Array<string>(1) })), "bad-write-id")
    expect(Object.keys(state.executions)).toHaveLength(0)
    expect(applyExecutionCommand(state, claim()).executions["execution-A"]!.reservation).toBe("held")
  })

  it("treats optional undefined object properties as omitted in receipt and operation replays", () => {
    const settled = settle(stopped(terminal(applyExecutionCommand(bound(), disposition()))))
    const replayed = stopped(settled, { stopOperationID: undefined })
    expect(replayed).toEqual(settled)
    expect(replayed.executions["execution-A"]!.stopVerifications).toHaveLength(1)
    expect(replayed.executions["execution-A"]!.reconciliationFault).toBeUndefined()
    const pending = applyExecutionCommand(bound(), disposition())
    const replay = { ...disposition(), disposition: { ...disposition().disposition, detail: undefined } }
    expect(applyExecutionCommand(pending, replay)).toEqual(pending)
    const changed = stopped(settled, { independentFailure: { reason: "genuinely changed fault" } })
    expect(changed.executions["execution-A"]!.reconciliationFault).toBeTruthy()
  })

  it("requires disposition evidence to match the claimed revision without occupying the slot", () => {
    const state = bound()
    denied(() => applyExecutionCommand(state, disposition({
      disposition: { kind: "review", evidence: { ...evidence, revisionID: "wrong-revision" } },
    })), "revision-conflict")
    expect(state.executions["execution-A"]!.pendingDisposition).toBeUndefined()
    expect(applyExecutionCommand(state, disposition()).executions["execution-A"]!.pendingDisposition).toBeDefined()
  })

  it("denies settlement-stop request before a valid admitted disposition", () => {
    denied(() => applyExecutionCommand(bound(), { type: "request_stop", controllerEpoch: EPOCH,
      executionID: "execution-A", operationID: "stop-too-early", reason: "settle_disposition", at: AT,
    }), "disposition-required")
  })

  it("an internal stop receipt without a terminal observation cannot settle", () => {
    const state = stopped(applyExecutionCommand(bound(), disposition()))
    denied(() => settle(state), "stop-unproved")
    expect(state.executions["execution-A"]!.reservation).toBe("held")
  })

  it("a failed terminal remains failure despite a correlated intentional-stop receipt", () => {
    let state = applyExecutionCommand(bound(), disposition())
    state = applyExecutionCommand(state, { type: "request_stop", controllerEpoch: EPOCH,
      executionID: "execution-A", operationID: "stop-A", reason: "settle_disposition", at: AT })
    state = settle(stopped(terminal(state, "failed"), { cause: "settle_disposition", stopOperationID: "stop-A" }))
    expect(state.board.cards["card-A"]!.lane).toBe("failed")
    expect(Object.keys(state.reviews)).toHaveLength(0)
  })

  it("deep-copies admitted evidence and replays semantic payload independent of object keys/time", () => {
    const input = disposition({ disposition: { kind: "review", evidence: JSON.parse(JSON.stringify(evidence)) } })
    const state = applyExecutionCommand(bound(), input)
    input.disposition.evidence.references.push("caller-mutated-after-admission")
    expect(state.executions["execution-A"]!.pendingDisposition!.disposition.evidence.references).toEqual(evidence.references)
    const reordered = { ...disposition(), at: LATER,
      disposition: { evidence: { ...evidence }, kind: "review" as const } }
    expect(applyExecutionCommand(state, reordered)).toEqual(state)
    const reviewed = settle(stopped(terminal(state)))
    expect(Object.values(reviewed.reviews)[0]!.evidence.references).toEqual(evidence.references)
  })

  it("rejects an invalid disposition without occupying the first-valid slot", () => {
    const state = bound()
    denied(() => applyExecutionCommand(state, disposition({
      disposition: { kind: "blocked", evidence, requiredAction: "" },
    })), "bad-disposition")
    expect(state.executions["execution-A"]!.pendingDisposition).toBeUndefined()
    expect(applyExecutionCommand(state, disposition()).executions["execution-A"]!.pendingDisposition).toBeDefined()
  })

  it("admits one immutable disposition, replaying its ID but denying alternatives", () => {
    const state = applyExecutionCommand(bound(), freeze(disposition()))
    expect(state.executions["execution-A"]!.pendingDisposition).toMatchObject({
      operationID: "disposition-A", disposition: { kind: "review", evidence },
    })
    expect(applyExecutionCommand(state, disposition())).toEqual(state)
    denied(() => applyExecutionCommand(state, disposition({
      disposition: { kind: "failed", evidence, reason: "replacement" },
    })), "operation-conflict")
    denied(() => applyExecutionCommand(state, disposition({ operationID: "disposition-other" })), "disposition-conflict")
    expect(state.board.cards["card-A"]!.lane).toBe("in_progress")
    expect(state.board.cards["card-A"]!.assignments[0]!.endedAt).toBeUndefined()
    expect(state.executions["execution-A"]!.reservation).toBe("held")
    expect(Object.keys(state.reviews)).toHaveLength(0)
  })

  it("fences disposition and terminal observation by exact bound session", () => {
    denied(() => applyExecutionCommand(bound(), disposition({ sessionID: "session-other" })), "session-conflict")
    denied(() => terminal(bound(), "failed", "execution-A", "session-other"), "session-conflict")
    denied(() => applyExecutionCommand(bound(), verification({ sessionID: "session-other" })), "session-conflict")
    denied(() => applyExecutionCommand(bound(), verification({ executionID: "execution-other" })), "execution-conflict")
  })

  it("first terminal observation seals new dispositions before stop is proved", () => {
    const state = terminal(bound())
    expect(state.executions["execution-A"]!.sealed).toBe(true)
    denied(() => applyExecutionCommand(state, disposition()), "disposition-sealed")
    expect(state.executions["execution-A"]!.reservation).toBe("held")
    denied(() => settle(state), "stop-unproved")
  })

  it("allows identical disposition replay after sealing and after settlement", () => {
    const pending = applyExecutionCommand(bound(), disposition())
    const sealed = terminal(pending)
    expect(applyExecutionCommand(sealed, disposition())).toEqual(sealed)
    const settled = settle(stopped(sealed))
    expect(applyExecutionCommand(settled, disposition())).toEqual(settled)
    denied(() => applyExecutionCommand(settled, disposition({ operationID: "late-new" })), "disposition-sealed")
  })

  it("nominal success without disposition becomes protocol failure, not completion", () => {
    const state = settle(stopped(terminal(bound())))
    expect(state.board.cards["card-A"]!.lane).toBe("failed")
    expect(state.executions["execution-A"]!.settlement).toMatchObject({ kind: "failed", reason: "missing-disposition" })
    expect(state.workRounds["card-A"]!.rounds[0]!.status).toBe("failed")
    expect(Object.keys(state.reviews)).toHaveLength(0)
  })

  it("submit followed by genuine error invalidates success without losing the submission", () => {
    const pending = applyExecutionCommand(bound(), disposition())
    const state = settle(stopped(terminal(pending, "failed")))
    expect(state.board.cards["card-A"]!.lane).toBe("failed")
    expect(state.executions["execution-A"]!.pendingDisposition!.operationID).toBe("disposition-A")
    expect(state.executions["execution-A"]!.settlement!.kind).toBe("failed")
    expect(Object.keys(state.reviews)).toHaveLength(0)
  })

  it("a second admitted error observation before settlement also overrides success", () => {
    let state = terminal(applyExecutionCommand(bound(), disposition()))
    state = terminal(state, "failed")
    state = settle(stopped(state))
    expect(state.board.cards["card-A"]!.lane).toBe("failed")
    expect(Object.keys(state.reviews)).toHaveLength(0)
  })

  it.each([
    { process: "unknown" as const }, { children: "unknown" as const },
    { effects: "unknown" as const }, { cause: "unknown" as const },
    { independentFailure: "unknown" as const },
  ])("uncertain adapter evidence %j retains the reservation", (uncertain) => {
    const state = stopped(terminal(applyExecutionCommand(bound(), disposition())), uncertain)
    denied(() => settle(state), "stop-unproved")
    expect(state.executions["execution-A"]!.reservation).toBe("held")
    expect(state.board.cards["card-A"]!.lane).toBe("in_progress")
    expect(Object.keys(state.reviews)).toHaveLength(0)
  })

  it("requesting interruption alone cannot release, close assignment, or create review", () => {
    const pending = applyExecutionCommand(bound(), disposition())
    const state = applyExecutionCommand(pending, {
      type: "request_stop", controllerEpoch: EPOCH, executionID: "execution-A",
      operationID: "stop-A", reason: "settle_disposition", at: AT,
    })
    expect(state.executions["execution-A"]!.reservation).toBe("held")
    expect(state.executions["execution-A"]!.status).toBe("stop_requested")
    denied(() => settle(terminal(state, "interrupted")), "stop-unproved")
    expect(state.board.cards["card-A"]!.assignments[0]!.endedAt).toBeUndefined()
    expect(Object.keys(state.reviews)).toHaveLength(0)
    // active={}, wait204, interrupt responses and assignment endedAt have NO
    // command that upgrades them to verified stop evidence in this contract.
  })

  it("only a correlated internally verified settlement-stop can normalize interruption", () => {
    let state = applyExecutionCommand(bound(), disposition())
    state = applyExecutionCommand(state, {
      type: "request_stop", controllerEpoch: EPOCH, executionID: "execution-A",
      operationID: "stop-A", reason: "settle_disposition", at: AT,
    })
    state = terminal(state, "interrupted")
    const verified = stopped(state, { cause: "settle_disposition", stopOperationID: "stop-A" })
    expect(settle(verified).board.cards["card-A"]!.lane).toBe("review")
    denied(() => settle(stopped(state, { cause: "settle_disposition", stopOperationID: "wrong-stop" })), "stop-unproved")
    const independentFault = stopped(state, {
      cause: "settle_disposition", stopOperationID: "stop-A",
      independentFailure: { reason: "child cleanup fault" },
    })
    expect(settle(independentFault).board.cards["card-A"]!.lane).toBe("failed")
  })

  it("unexpected interruption is real failure even with a pending review submission", () => {
    const state = stopped(terminal(applyExecutionCommand(bound(), disposition()), "interrupted"), { cause: "unexpected" })
    expect(settle(state).board.cards["card-A"]!.lane).toBe("failed")
    expect(Object.keys(settle(state).reviews)).toHaveLength(0)
  })

  it("plain interrupted outcome plus a natural-stop label still leaves cause unproved", () => {
    const state = stopped(terminal(applyExecutionCommand(bound(), disposition()), "interrupted"))
    denied(() => settle(state), "stop-unproved")
    expect(state.executions["execution-A"]!.reservation).toBe("held")
  })

  it("later nominal stop evidence cannot erase an already admitted independent failure", () => {
    let state = stopped(terminal(applyExecutionCommand(bound(), disposition())), {
      independentFailure: { reason: "known side-effect failure" },
    })
    state = stopped(state)
    expect(settle(state).board.cards["card-A"]!.lane).toBe("failed")
  })

  it("an intentional-stop label without a durable matching request is not proof", () => {
    const state = stopped(terminal(applyExecutionCommand(bound(), disposition()), "interrupted"), {
      cause: "settle_disposition", stopOperationID: "invented-stop",
    })
    denied(() => settle(state), "stop-unproved")
  })

  it("failed disposition remains failed even on natural successful stop", () => {
    const pending = applyExecutionCommand(bound(), disposition({
      disposition: { kind: "failed", evidence, reason: "acceptance failed" },
    }))
    expect(settle(stopped(terminal(pending))).board.cards["card-A"]!.lane).toBe("failed")
  })

  it("human-action block survives a genuine fault, retaining both records", () => {
    const pending = applyExecutionCommand(bound(), disposition({
      disposition: { kind: "blocked", evidence, requiredAction: "Gavin must approve destructive migration" },
    }))
    const state = settle(stopped(terminal(pending, "failed")))
    expect(state.board.cards["card-A"]!.lane).toBe("blocked")
    expect(state.executions["execution-A"]!.settlement).toMatchObject({
      kind: "blocked", requiredAction: "Gavin must approve destructive migration",
    })
    expect(state.workRounds["card-A"]!.rounds[0]!.status).toBe("failed")
  })
})

describe("execution foundation: atomic settlement, continuation, and budget", () => {
  it("refuses settlement rather than closing a different assignment at the recorded index", () => {
    const state = stopped(terminal(applyExecutionCommand(bound(), disposition())))
    const target = state.board.cards["card-A"]!
    const changed = { ...state, board: { ...state.board, cards: { ...state.board.cards,
      "card-A": { ...target, assignments: [{ ...target.assignments[0]!, sessionID: "session-B" }] },
    } } }
    const before = JSON.stringify(changed)
    denied(() => settle(changed), "assignment-conflict")
    expect(JSON.stringify(changed)).toBe(before)
    expect(changed.executions["execution-A"]!.reservation).toBe("held")
  })

  it("late changed stop evidence is retained as a visible fault, never rewriting settlement", () => {
    const settled = settle(stopped(terminal(applyExecutionCommand(bound(), disposition()))))
    const late = stopped(settled, { independentFailure: { reason: "late child fault" } })
    expect(late.board).toEqual(settled.board)
    expect(late.workRounds).toEqual(settled.workRounds)
    expect(late.executions["execution-A"]!.settlement).toEqual(settled.executions["execution-A"]!.settlement)
    expect(late.executions["execution-A"]!.reconciliationFault).toBeTruthy()
    expect(late.admissionPaused).toBe(true)
  })

  it("cannot use plan_rework to bypass an unresolved mandatory human block", () => {
    const pending = applyExecutionCommand(bound(), disposition({ disposition: { kind: "blocked", evidence,
      requiredAction: "Gavin must authorize destructive migration" } }))
    const state = settle(stopped(terminal(pending, "failed")))
    denied(() => applyExecutionCommand(state, { type: "plan_rework", controllerEpoch: EPOCH,
      cardID: "card-A", reason: "retry without human action", route: "backlog", nextEligibleAt: LATER, at: AT,
    }), "human-action-required")
  })

  it("commits matching assignment, round, frozen review intent, and release once", () => {
    const before = freeze(stopped(terminal(applyExecutionCommand(bound(), disposition()))))
    const state = settle(before)
    expect(before.board.cards["card-A"]!.lane).toBe("in_progress")
    expect(before.executions["execution-A"]!.reservation).toBe("held")
    expect(state.board.cards["card-A"]!.lane).toBe("review")
    expect(state.board.lanes.review).toContain("card-A")
    expect(state.board.lanes.in_progress).not.toContain("card-A")
    expect(state.board.cards["card-A"]!.assignments[0]).toMatchObject({
      sessionID: "session-A", endedAt: AT, outcome: "submitted",
    })
    expect(state.executions["execution-A"]!.reservation).toBe("released")
    expect(state.workRounds["card-A"]!.rounds[0]!.status).toBe("review")
    expect(Object.values(state.reviews)).toHaveLength(1)
    expect(Object.values(state.reviews)[0]).toMatchObject({
      cardID: "card-A", executionID: "execution-A", roundID: "round-1", evidence,
      reviewerIntent: { profile: "neolilith", status: "deferred" },
    })
    expect(Object.values(state.reviews)[0]!.reviewerIntent.sessionID).toBeUndefined()
    expect(settle(state)).toEqual(state)
    expect(terminal(state)).toEqual(state)
  })

  it("settlement releases a write ID only after the stop barrier", () => {
    const pending = applyExecutionCommand(bound(), disposition())
    const other = claim({ operationID: "claim-B", executionID: "execution-B", cardID: "card-B" })
    denied(() => applyExecutionCommand(pending, other), "write-conflict")
    const state = applyExecutionCommand(settle(stopped(terminal(pending))), other)
    expect(state.executions["execution-B"]!.reservation).toBe("held")
  })

  it("successful specialist handoffs queue backlog, retaining the same work round", () => {
    let state = bound()
    for (let stage = 1; stage <= 6; stage++) {
      const executionID = stage === 1 ? "execution-A" : `execution-${stage}`
      const sessionID = stage === 1 ? "session-A" : `session-${stage}`
      state = applyExecutionCommand(state, disposition({
        operationID: `handoff-${stage}`, executionID, sessionID,
        disposition: { kind: "handoff", evidence, nextProfile: `role-${stage}`, reason: "remaining acceptance work" },
      }))
      state = terminal(state, "succeeded", executionID, sessionID)
      state = stopped(state, { executionID, sessionID })
      state = settle(state, executionID)
      expect(state.board.cards["card-A"]!.lane).toBe("backlog")
      expect(state.board.cards["card-A"]!.profile).toBe(`role-${stage}`)
      expect(state.workRounds["card-A"]!.consumed).toBe(1)
      expect(state.workRounds["card-A"]!.rounds[0]!.status).toBe("open")
      expect(Object.keys(state.reviews)).toHaveLength(0)
      expect(Object.values(state.executions).filter((e) => e.reservation === "held")).toHaveLength(0)
      if (stage < 6) {
        state = applyExecutionCommand(readyFixture(state), claim({
          operationID: `claim-${stage + 1}`, executionID: `execution-${stage + 1}`,
          stageID: `stage-${stage + 1}`, profile: `role-${stage}`,
        }))
        state = applyExecutionCommand(state, { type: "bind_session", controllerEpoch: EPOCH,
          executionID: `execution-${stage + 1}`, sessionID: `session-${stage + 1}`, at: AT })
      }
    }
    expect(state.workRounds["card-A"]!.rounds[0]!.executionIDs).toHaveLength(6)
  })

  it("fences an old A fault after B starts, keeping B's assignment/lane/lease intact", () => {
    let state = applyExecutionCommand(bound(), disposition({
      disposition: { kind: "handoff", evidence, nextProfile: "qa", reason: "remaining acceptance work" },
    }))
    state = settle(stopped(terminal(state)))
    state = applyExecutionCommand(readyFixture(state), claim({
      operationID: "claim-successor", executionID: "execution-B", stageID: "stage-B", profile: "qa",
    }))
    state = applyExecutionCommand(state, { type: "bind_session", controllerEpoch: EPOCH,
      executionID: "execution-B", sessionID: "session-B", at: AT })
    const beforeB = state.executions["execution-B"]
    const beforeCard = state.board.cards["card-A"]
    state = terminal(state, "failed", "execution-A", "session-A")
    expect(state.executions["execution-B"]).toEqual(beforeB)
    expect(state.board.cards["card-A"]).toEqual(beforeCard)
    expect(state.board.cards["card-A"]!.assignments[1]!.endedAt).toBeUndefined()
    expect(state.executions["execution-A"]!.reconciliationFault).toBeTruthy()
    expect(state.executions["execution-A"]!.reservation).toBe("released")
  })

  it("five genuine failed rounds survive profile changes, restart, and history truncation", () => {
    let state = fresh()
    for (let round = 1; round <= 5; round++) {
      const epoch = state.controllerEpoch
      const executionID = `execution-round-${round}`
      const sessionID = `session-round-${round}`
      state = applyExecutionCommand(readyFixture(state), claim({
        controllerEpoch: epoch, operationID: `claim-round-${round}`, executionID,
        roundID: `round-${round}`, stageID: `stage-round-${round}`, profile: `different-role-${round}`, at: LATER,
      }))
      state = applyExecutionCommand(state, { type: "bind_session", controllerEpoch: epoch,
        executionID, sessionID, at: LATER })
      state = terminal(state, "failed", executionID, sessionID)
      state = stopped(state, { executionID, sessionID })
      state = settle(state, executionID)
      expect(state.workRounds["card-A"]!.consumed).toBe(round)
      expect(state.workRounds["card-A"]!.rounds).toHaveLength(round)
      if (round < 5) {
        expect(state.board.cards["card-A"]!.lane).toBe("failed")
        state = applyExecutionCommand(state, { type: "plan_rework", controllerEpoch: epoch,
          cardID: "card-A", reason: "known effects; acceptance and scope valid; safe rework plan",
          route: "backlog", nextEligibleAt: LATER, at: AT })
        state = JSON.parse(JSON.stringify(state)) as State
        state = applyExecutionCommand(state, { type: "recover", controllerEpoch: epoch,
          nextEpoch: `restart-${round}`, at: AT })
        const card = state.board.cards["card-A"]!
        state = { ...state, board: { ...state.board, cards: {
          ...state.board.cards, "card-A": { ...card, profile: `routing-change-${round}`, history: [] },
        } } }
        expect(state.workRounds["card-A"]!.nextEligibleAt).toBe(LATER)
      }
    }
    expect(state.board.cards["card-A"]!.lane).toBe("blocked")
    expect(state.workRounds["card-A"]!.requiredAction).toMatch(/Gavin.*(budget|scope)/i)
    denied(() => applyExecutionCommand(readyFixture(state), claim({
      controllerEpoch: state.controllerEpoch, operationID: "claim-sixth", executionID: "execution-sixth",
      roundID: "round-6", stageID: "stage-sixth", at: LATER,
    })), "budget-exhausted")
    denied(() => applyExecutionCommand(state, { type: "plan_rework", controllerEpoch: state.controllerEpoch,
      cardID: "card-A", reason: "try again", route: "backlog", nextEligibleAt: LATER, at: AT }), "budget-exhausted")
  })

  it("requires a persisted safe rework plan and honors its backoff before a new round", () => {
    const failed = settle(stopped(terminal(bound(), "failed")))
    const nextClaim = claim({ operationID: "claim-rework", executionID: "execution-rework", roundID: "round-2", stageID: "stage-rework" })
    denied(() => applyExecutionCommand(readyFixture(failed), nextClaim), "rework-unplanned")
    const planned = applyExecutionCommand(failed, { type: "plan_rework", controllerEpoch: EPOCH,
      cardID: "card-A", reason: "safe plan after known effects", route: "backlog", nextEligibleAt: LATER, at: AT })
    denied(() => applyExecutionCommand(readyFixture(planned), nextClaim), "backoff-active")
    expect(applyExecutionCommand(readyFixture(planned), { ...nextClaim, at: LATER }).workRounds["card-A"]!.consumed).toBe(2)
  })

  it("a specialist continuation cannot replace the open round identity to buy a fresh budget", () => {
    let state = applyExecutionCommand(bound(), disposition({
      disposition: { kind: "handoff", evidence, nextProfile: "qa", reason: "remaining acceptance work" },
    }))
    state = settle(stopped(terminal(state)))
    denied(() => applyExecutionCommand(readyFixture(state), claim({
      operationID: "claim-bypass", executionID: "execution-bypass", roundID: "invented-round", stageID: "stage-B",
    })), "round-conflict")
    expect(state.workRounds["card-A"]!.consumed).toBe(1)
  })
})

describe("execution foundation: restart fencing", () => {
  it("never reuses retired epochs to revive old stop verification or stale callbacks", () => {
    const original = stopped(terminal(applyExecutionCommand(bound(), disposition())))
    const recovered = applyExecutionCommand(original, { type: "recover", controllerEpoch: EPOCH,
      nextEpoch: "controller-B", at: AT })
    denied(() => settle(recovered), "stop-unproved")
    denied(() => applyExecutionCommand(recovered, { type: "recover", controllerEpoch: "controller-B",
      nextEpoch: EPOCH, at: AT }), "retired-epoch")
    denied(() => applyExecutionCommand(recovered, { type: "recover", controllerEpoch: "controller-B",
      nextEpoch: "controller-B", at: AT }), "epoch-conflict")
    expect(original.retiredEpochs).toEqual([])
    expect(recovered.retiredEpochs).toEqual([EPOCH])
    const third = applyExecutionCommand(JSON.parse(JSON.stringify(recovered)) as State, {
      type: "recover", controllerEpoch: "controller-B", nextEpoch: "controller-C", at: AT,
    })
    expect(third.retiredEpochs).toEqual([EPOCH, "controller-B"])
    for (const retired of third.retiredEpochs) {
      denied(() => applyExecutionCommand(third, { type: "recover", controllerEpoch: "controller-C",
        nextEpoch: retired, at: AT }), "retired-epoch")
      denied(() => applyExecutionCommand(third, { ...verification(), controllerEpoch: retired }), "stale-epoch")
    }
    expect(third.executions["execution-A"]!.reservation).toBe("held")
    expect(third.executions["execution-A"]!.stopVerifications).toHaveLength(1)
    expect(settle(stopped(third)).executions["execution-A"]!.reservation).toBe("released")
  })

  it("preserves historical stop evidence on recovery but requires fresh epoch verification", () => {
    const before = stopped(terminal(applyExecutionCommand(bound(), disposition())))
    let state = applyExecutionCommand(before, { type: "recover", controllerEpoch: EPOCH,
      nextEpoch: "controller-B", at: AT })
    expect(state.executions["execution-A"]!.stopReceipt).toEqual(before.executions["execution-A"]!.stopReceipt)
    denied(() => settle(state), "stop-unproved")
    state = stopped(state)
    expect(settle(state).board.cards["card-A"]!.lane).toBe("review")
  })

  it.each([false, true])("new epoch quarantines held ownership (bound=%j) until reconciled", (isBound) => {
    const before = isBound ? bound() : applyExecutionCommand(fresh(), claim())
    const state = applyExecutionCommand(JSON.parse(JSON.stringify(before)) as State, {
      type: "recover", controllerEpoch: EPOCH, nextEpoch: "controller-B", at: AT,
    })
    expect(state.controllerEpoch).toBe("controller-B")
    expect(state.admissionPaused).toBe(true)
    expect(state.executions["execution-A"]).toMatchObject({ status: "unknown", reservation: "held" })
    expect(state.workRounds).toEqual(before.workRounds)
    expect(state.board).toEqual(before.board)
    denied(() => applyExecutionCommand(state, claim({ controllerEpoch: "controller-B",
      operationID: "claim-B", executionID: "execution-B", cardID: "card-B", writes: ["jazz:src/link.ts"],
    })), "recovery-pending")
  })

  it("denies stale epoch callbacks even when execution/session IDs still match", () => {
    const state = applyExecutionCommand(bound(), { type: "recover", controllerEpoch: EPOCH,
      nextEpoch: "controller-B", at: AT })
    for (const command of [disposition(), verification(), claim(),
      { type: "observe_terminal" as const, controllerEpoch: EPOCH, executionID: "execution-A",
        sessionID: "session-A", observationID: "stale-event", outcome: "failed" as const, detail: "stale", at: AT },
      { type: "settle" as const, controllerEpoch: EPOCH, executionID: "execution-A", at: AT },
    ]) denied(() => applyExecutionCommand(state, command), "stale-epoch")
  })

  it("matching internal reconciliation and settlement can clear the recovery pause", () => {
    let state = applyExecutionCommand(bound(), { type: "recover", controllerEpoch: EPOCH,
      nextEpoch: "controller-B", at: AT })
    state = settle(stopped(terminal(state, "failed")))
    expect(state.admissionPaused).toBe(false)
    expect(state.executions["execution-A"]!.reservation).toBe("released")
    const next = applyExecutionCommand(state, claim({ controllerEpoch: "controller-B",
      operationID: "claim-B", executionID: "execution-B", cardID: "card-B",
    }))
    expect(next.executions["execution-B"]!.reservation).toBe("held")
  })
})

describe("foundation generic mutation guard: no unproved human authorization", () => {
  it("generic moves cannot manufacture review, running, failed, or human-blocked state", () => {
    for (const toLane of ["review", "in_progress", "failed", "blocked"]) {
      denied(() => guardFoundationMutation(fresh(), { type: "move", cardID: "card-A", toLane }), "mutation-denied")
    }
  })

  it("unknown mutation kinds fail closed despite purported authenticated-human metadata", () => {
    const unknown = { type: "future_privileged_mutation", actor: "gavin", human: true, authenticated: true }
    denied(() => guardFoundationMutation(fresh(), unknown as unknown as Mutation), "mutation-denied")
  })

  it("allows only triage intake; actor/human metadata cannot allow another lane", () => {
    const state = fresh()
    expect(() => guardFoundationMutation(state, { type: "create" })).not.toThrow()
    expect(() => guardFoundationMutation(state, { type: "create", lane: "triage" })).not.toThrow()
    for (const lane of ["backlog", "ready", "in_progress", "blocked", "failed", "review", "done", "cancelled"]) {
      const spoof = { type: "create" as const, lane, actor: "gavin", human: true }
      denied(() => guardFoundationMutation(state, spoof), "mutation-denied")
    }
  })

  it("denies every terminal move, including same-lane reorder and reopening", () => {
    for (const from of ["triage", "backlog", "ready", "in_progress", "blocked", "failed", "review", "done", "cancelled"]) {
      const state = { ...fresh(), board: moveCard(boardFixture(), "card-A", from) }
      for (const toLane of ["triage", "backlog", "ready", "in_progress", "blocked", "failed", "review", "done", "cancelled"]) {
        if (![from, toLane].some((lane) => lane === "done" || lane === "cancelled")) continue
        const spoof = { type: "move" as const, cardID: "card-A", toLane, actor: "gavin", human: true }
        denied(() => guardFoundationMutation(state, spoof), "mutation-denied")
      }
    }
  })

  it("denies generic exits from review and mutation of held worker ownership", () => {
    const review = { ...fresh(), board: moveCard(boardFixture(), "card-A", "review") }
    for (const toLane of ["triage", "backlog", "ready", "in_progress", "blocked", "failed"]) {
      denied(() => guardFoundationMutation(review, { type: "move", cardID: "card-A", toLane, actor: "gavin" }), "mutation-denied")
    }
    for (const toLane of ["backlog", "ready", "review", "blocked", "failed"]) {
      denied(() => guardFoundationMutation(bound(), { type: "move", cardID: "card-A", toLane }), "mutation-denied")
    }
  })

  it("denies removal/archive and privileged verdict/requeue/resolution/grants even for spoofed Gavin", () => {
    const mutations: Mutation[] = [
      { type: "remove", cardID: "card-A" }, { type: "archive", lane: "done" },
      { type: "review_decide", cardID: "card-A", decision: "done" },
      { type: "review_decide", cardID: "card-A", decision: "cancel" },
      { type: "review_decide", cardID: "card-A", decision: "rework" },
      { type: "requeue", cardID: "card-A" }, { type: "resolve_block", cardID: "card-A" },
      { type: "grant_budget", cardID: "card-A", rounds: 5 },
    ]
    for (const mutation of mutations) {
      const spoof = { ...mutation, actor: "gavin", human: true, authenticated: true }
      denied(() => guardFoundationMutation(fresh(), spoof), "mutation-denied")
    }
  })

  it("does not replace separate caller policy for ordinary reads and comments", () => {
    const state = bound()
    const before = JSON.stringify(state)
    expect(() => guardFoundationMutation(state, { type: "read", cardID: "card-A" })).not.toThrow()
    expect(() => guardFoundationMutation(state, { type: "comment", cardID: "card-A" })).not.toThrow()
    expect(JSON.stringify(state)).toBe(before)
  })
})
