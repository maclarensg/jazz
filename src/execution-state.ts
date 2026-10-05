import type { AssignmentOutcome, BoardState, Card, HistoryKind } from "./board"

/** Pure foundation only. No persistence, exclusivity, runtime adapter, or spawn. */
export interface ExecutionEvidence {
  id: string
  revisionID: string
  references: string[]
  acceptance: string[]
  testResults: string[]
  knownGaps: string[]
  provenance: string[]
}

export type ExecutionDisposition =
  | { kind: "review"; evidence: ExecutionEvidence }
  | { kind: "failed"; evidence: ExecutionEvidence; reason: string }
  | { kind: "blocked"; evidence: ExecutionEvidence; requiredAction: string }
  | { kind: "handoff"; evidence: ExecutionEvidence; nextProfile: string; reason: string }

/**
 * INTERNAL adapter result, not self-authenticating proof. Never accept this
 * shape from public callers as a verified stop. Actual adapter gates are absent.
 */
export interface InternalStopReceipt {
  executionID: string
  sessionID: string
  process: "stopped" | "live" | "unknown"
  children: "stopped" | "live" | "unknown"
  effects: "known" | "unknown"
  cause: "natural" | "settle_disposition" | "unexpected" | "unknown"
  independentFailure: "none" | "unknown" | { reason: string }
  stopOperationID?: string
}

interface CommandBase { controllerEpoch: string; at: string }
export interface ClaimExecutionCommand extends CommandBase {
  type: "claim"
  operationID: string
  executionID: string
  cardID: string
  revisionID: string
  roundID: string
  stageID: string
  profile: string
  policyFingerprint: string
  writes: string[]
}

export type ExecutionCommand =
  | ClaimExecutionCommand
  | (CommandBase & { type: "bind_session"; executionID: string; sessionID: string })
  | (CommandBase & { type: "request_disposition"; operationID: string; executionID: string; sessionID: string; disposition: ExecutionDisposition })
  | (CommandBase & { type: "request_stop"; operationID: string; executionID: string; reason: "settle_disposition" | "budget" | "safety" })
  | (CommandBase & { type: "observe_terminal"; executionID: string; sessionID: string; observationID: string; outcome: "succeeded" | "failed" | "interrupted"; detail: string })
  | (CommandBase & { type: "verify_stop"; executionID: string; receipt: InternalStopReceipt })
  | (CommandBase & { type: "settle"; executionID: string })
  | (CommandBase & { type: "plan_rework"; cardID: string; reason: string; route: "backlog" | "triage"; nextEligibleAt: string })
  | (CommandBase & { type: "recover"; nextEpoch: string })

export interface ExecutionSettlement {
  kind: ExecutionDisposition["kind"]
  /** Immutable prefix boundaries distinguish settlement inputs from late faults. */
  terminalObservationCount: number
  failureEvidenceCount: number
  stopVerificationCount: number
  reason?: string
  requiredAction?: string
  at: string
}

export interface ExecutionRecord {
  executionID: string
  cardID: string
  revisionID: string
  roundID: string
  stageID: string
  profile: string
  policyFingerprint: string
  controllerEpoch: string
  claimedAt: string
  writes: string[]
  status: "reserved" | "running" | "stop_requested" | "settling" | "unknown" | "released"
  reservation: "held" | "released"
  sessionID?: string
  assignmentIndex?: number
  sealed: boolean
  needsReconciliation: boolean
  pendingDisposition?: { operationID: string; disposition: ExecutionDisposition; at: string }
  stopRequest?: { operationID: string; reason: "settle_disposition" | "budget" | "safety"; at: string }
  terminalObservations: { observationID: string; outcome: "succeeded" | "failed" | "interrupted"; detail: string; at: string }[]
  stopReceipt?: InternalStopReceipt
  stopVerifiedEpoch?: string
  stopVerifications: { controllerEpoch: string; at: string; receipt: InternalStopReceipt }[]
  failureEvidence: string[]
  settlement?: ExecutionSettlement
  reconciliationFault?: string
}

export interface WorkRound {
  roundID: string
  number: number
  status: "open" | "failed" | "review"
  executionIDs: string[]
  failureEvidence: string[]
}

export interface WorkRoundLedger {
  consumed: number
  rounds: WorkRound[]
  nextEligibleAt?: string
  reworkPlan?: { reason: string; route: "backlog" | "triage"; nextEligibleAt: string }
  requiredAction?: string
}

export interface DeferredReviewCycle {
  cardID: string
  executionID: string
  roundID: string
  evidence: ExecutionEvidence
  reviewerIntent: { profile: "neolilith"; status: "deferred"; sessionID?: string }
}

export interface ExecutionState {
  controllerEpoch: string
  retiredEpochs: string[]
  board: BoardState
  executions: Record<string, ExecutionRecord>
  workRounds: Record<string, WorkRoundLedger>
  reviews: Record<string, DeferredReviewCycle>
  operations: Record<string, string>
  admissionPaused: boolean
}

export type FoundationMutation = { actor?: string } & (
  | { type: "create"; lane?: string }
  | { type: "move"; cardID: string; toLane: string }
  | { type: "read" | "comment" | "remove" | "requeue" | "resolve_block"; cardID: string }
  | { type: "archive"; lane: string }
  | { type: "review_decide"; cardID: string; decision: "done" | "cancel" | "rework" }
  | { type: "grant_budget"; cardID: string; rounds: number }
)

export class ExecutionStateError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = "ExecutionStateError"
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fail(code: string, message = code): never {
  throw new ExecutionStateError(code, message)
}

/** Opaque internal IDs, not paths. Reserved dictionary/prototype keys are banned. */
function id(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    || ["__proto__", "constructor", "prototype"].includes(value)) fail("bad-id")
}

function timestamp(value: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) fail("bad-time")
}

function nonblank(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${Array.from(value, (entry) => entry === undefined ? "null" : canonical(entry)).join(",")}]`
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function fingerprint(command: ExecutionCommand): string {
  const { at: _at, ...payload } = command
  return canonical(command.type === "claim" ? { ...payload, writes: [...command.writes].sort() } : payload)
}

function replay(state: ExecutionState, operationID: string, command: ExecutionCommand): boolean {
  if (!Object.hasOwn(state.operations, operationID)) return false
  if (state.operations[operationID] !== fingerprint(command)) fail("operation-conflict")
  return true
}

function recordOperation(state: ExecutionState, operationID: string, command: ExecutionCommand): void {
  state.operations[operationID] = fingerprint(command)
}

function card(state: ExecutionState, cardID: string): Card {
  if (!Object.hasOwn(state.board.cards, cardID)) fail("unknown-card")
  return state.board.cards[cardID]!
}

function execution(state: ExecutionState, executionID: string): ExecutionRecord {
  if (!Object.hasOwn(state.executions, executionID)) fail("unknown-execution")
  return state.executions[executionID]!
}

function matchingSession(record: ExecutionRecord, sessionID: string): void {
  id(sessionID)
  if (!record.sessionID || record.sessionID !== sessionID) fail("session-conflict")
}

function history(target: Card, kind: HistoryKind, at: string, actor: string, detail: string): void {
  target.history.push({ ts: at, kind, actor, detail })
  target.updated = at
}

function move(state: ExecutionState, target: Card, toLane: string, at: string, actor: string): void {
  if (!Object.hasOwn(state.board.lanes, toLane)) fail("unknown-lane")
  const from = target.lane
  state.board.lanes[from] = state.board.lanes[from]!.filter((value) => value !== target.id)
  state.board.lanes[toLane] = [...state.board.lanes[toLane]!.filter((value) => value !== target.id), target.id]
  target.lane = toLane
  target.updated = at
  if (from !== toLane) target.history.push({ ts: at, kind: "moved", actor, from, to: toLane })
}

function writeID(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value)
    || value.slice(value.indexOf(":") + 1).split("/").some((part) => part === "." || part === "..")) fail("bad-write-id")
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function validateDisposition(value: ExecutionDisposition, record: ExecutionRecord): void {
  if (!value || !["review", "failed", "blocked", "handoff"].includes(value.kind) || !value.evidence) fail("bad-disposition")
  id(value.evidence.id)
  id(value.evidence.revisionID)
  if (value.evidence.revisionID !== record.revisionID) fail("revision-conflict")
  for (const field of ["references", "acceptance", "testResults", "knownGaps", "provenance"] as const) {
    if (!Array.isArray(value.evidence[field]) || !Array.from(value.evidence[field]).every(nonblank)) fail("bad-disposition")
  }
  if (!value.evidence.acceptance.length || !value.evidence.provenance.length) fail("bad-disposition")
  if ((value.kind === "failed" || value.kind === "handoff") && !nonblank(value.reason)) fail("bad-disposition")
  if (value.kind === "blocked" && !nonblank(value.requiredAction)) fail("bad-disposition")
  if (value.kind === "handoff") id(value.nextProfile)
}

function validateReceipt(receipt: InternalStopReceipt, record: ExecutionRecord): void {
  id(receipt.executionID)
  if (receipt.executionID !== record.executionID) fail("execution-conflict")
  matchingSession(record, receipt.sessionID)
  if (receipt.stopOperationID !== undefined) id(receipt.stopOperationID)
  if (!["stopped", "live", "unknown"].includes(receipt.process)
    || !["stopped", "live", "unknown"].includes(receipt.children)
    || !["known", "unknown"].includes(receipt.effects)
    || !["natural", "settle_disposition", "unexpected", "unknown"].includes(receipt.cause)
    || !(receipt.independentFailure === "none" || receipt.independentFailure === "unknown"
      || (typeof receipt.independentFailure === "object" && receipt.independentFailure !== null
        && nonblank(receipt.independentFailure.reason)))) fail("bad-receipt")
}

function confirmedBarrier(record: ExecutionRecord, controllerEpoch: string): InternalStopReceipt {
  const receipt = record.stopReceipt
  if (!record.sealed || !record.terminalObservations.length || !receipt
    || record.stopVerifiedEpoch !== controllerEpoch
    || receipt.process !== "stopped" || receipt.children !== "stopped"
    || receipt.effects !== "known" || receipt.cause === "unknown"
    || receipt.independentFailure === "unknown") fail("stop-unproved")
  if (receipt.cause === "settle_disposition" && (!record.pendingDisposition
    || record.stopRequest?.reason !== "settle_disposition"
    || receipt.stopOperationID !== record.stopRequest.operationID)) fail("stop-unproved")
  if (record.terminalObservations.some((observation) => observation.outcome === "interrupted")
    && !record.terminalObservations.some((observation) => observation.outcome === "failed")
    && receipt.cause === "natural" && !record.failureEvidence.length) fail("stop-unproved")
  return receipt
}

function settleExecution(state: ExecutionState, record: ExecutionRecord, at: string): void {
  const receipt = confirmedBarrier(record, state.controllerEpoch)
  const target = card(state, record.cardID)
  const assignment = record.assignmentIndex === undefined ? undefined : target.assignments[record.assignmentIndex]
  // Never use "the currently open assignment" as a proxy for this execution.
  if (!assignment || assignment.sessionID !== record.sessionID || assignment.profile !== record.profile
    || assignment.endedAt !== undefined || target.lane !== "in_progress") fail("assignment-conflict")
  const ledger = state.workRounds[record.cardID]!
  const round = ledger.rounds.find((value) => value.roundID === record.roundID)
  if (!round || !round.executionIDs.includes(record.executionID) || round.status !== "open") fail("round-conflict")
  const disposition = record.pendingDisposition?.disposition
  const genuineFailure = record.failureEvidence.length > 0
    || record.terminalObservations.some((observation) => observation.outcome === "failed")
    || receipt.cause === "unexpected" || typeof receipt.independentFailure === "object"
    || (record.stopRequest !== undefined && record.stopRequest.reason !== "settle_disposition")
  const failed = genuineFailure || disposition?.kind === "failed" || !disposition
  let kind: ExecutionSettlement["kind"] = failed ? "failed" : disposition!.kind
  let reason: string | undefined
  if (failed) {
    reason = genuineFailure ? "execution-failure" : disposition?.kind === "failed" ? disposition.reason : "missing-disposition"
    round.status = "failed"
    round.failureEvidence = [...record.failureEvidence, reason]
  }
  let lane: string = kind
  if (disposition?.kind === "blocked") {
    kind = "blocked"
    lane = "blocked"
    ledger.requiredAction = disposition.requiredAction
  } else if (failed && ledger.consumed >= 5) {
    lane = "blocked"
    ledger.requiredAction = "Gavin must authorize additional work-round budget or change scope"
  } else if (disposition?.kind === "handoff" && !failed) {
    lane = "backlog"
    target.profile = disposition.nextProfile
  } else if (kind === "review") {
    round.status = "review"
    state.reviews[`review:${record.executionID}`] = {
      cardID: record.cardID, executionID: record.executionID, roundID: record.roundID,
      evidence: clone(disposition!.evidence), reviewerIntent: { profile: "neolilith", status: "deferred" },
    }
  }
  const outcome: AssignmentOutcome = kind === "review" ? "submitted" : kind === "handoff" ? "handoff" : failed ? "failed" : "exited"
  assignment.endedAt = at
  assignment.outcome = outcome
  history(target, kind === "handoff" ? "handoff" : "exit", at, `execution:${record.executionID}`, reason ?? kind)
  move(state, target, lane, at, `execution:${record.executionID}`)
  record.settlement = { kind, at, terminalObservationCount: record.terminalObservations.length,
    failureEvidenceCount: record.failureEvidence.length, stopVerificationCount: record.stopVerifications.length,
    ...(reason ? { reason } : {}),
    ...(ledger.requiredAction ? { requiredAction: ledger.requiredAction } : {}) }
  record.status = "released"
  record.reservation = "released"
  record.needsReconciliation = false
  state.admissionPaused = Object.values(state.executions).some((value) => value.needsReconciliation || value.reconciliationFault !== undefined)
}

export function createExecutionState(board: BoardState, controllerEpoch: string): ExecutionState {
  id(controllerEpoch)
  for (const [cardID, target] of Object.entries(board.cards)) {
    id(cardID)
    id(target.id)
    if (cardID !== target.id) fail("bad-board")
    if (target.assignments.some((assignment) => assignment.endedAt === undefined)) fail("untracked-assignment")
  }
  return { controllerEpoch, retiredEpochs: [], board: clone(board), executions: {}, workRounds: {}, reviews: {}, operations: {}, admissionPaused: false }
}

/** Returns one atomic logical transition; this makes no database-atomicity claim. */
export function applyExecutionCommand(state: ExecutionState, command: ExecutionCommand): ExecutionState {
  // Fence before deduplication: even a replay cannot authorize a stale controller.
  if (command.controllerEpoch !== state.controllerEpoch) fail("stale-epoch")
  id(command.controllerEpoch)
  timestamp(command.at)
  for (const [key, value] of Object.entries(command)) {
    if (key.endsWith("ID") || key === "nextEpoch" || key === "profile") id(value as string)
  }
  const next = clone(state)
  switch (command.type) {
    case "claim": {
      if (!Array.isArray(command.writes)) fail("bad-write-id")
      for (const write of command.writes) writeID(write)
      if (replay(state, command.operationID, command)) return state
      if (state.admissionPaused) fail("recovery-pending")
      if (Object.hasOwn(state.executions, command.executionID)) fail("execution-conflict")
      const target = card(next, command.cardID)
      if (Object.values(state.executions).some((record) => record.cardID === command.cardID && record.reservation === "held")
        || target.assignments.some((assignment) => assignment.endedAt === undefined)) fail("card-busy")
      if (target.lane !== "ready") fail("claim-lane")
      if (!nonblank(command.policyFingerprint)) fail("bad-policy")
      for (const record of Object.values(state.executions)) {
        if (record.reservation === "held" && record.writes.some((left) => command.writes.some((right) => overlaps(left, right)))) fail("write-conflict")
      }
      const ledger = Object.hasOwn(next.workRounds, command.cardID)
        ? next.workRounds[command.cardID]! : { consumed: 0, rounds: [] } as WorkRoundLedger
      const previous = ledger.rounds.at(-1)
      if (ledger.requiredAction) fail(ledger.consumed >= 5 ? "budget-exhausted" : "human-action-required")
      if (previous?.status === "open") {
        if (previous.roundID !== command.roundID) fail("round-conflict")
      } else {
        if (ledger.consumed >= 5) fail("budget-exhausted")
        if (previous?.status === "review") fail("human-action-required")
        if (previous && !ledger.reworkPlan) fail("rework-unplanned")
        if (ledger.nextEligibleAt && Date.parse(command.at) < Date.parse(ledger.nextEligibleAt)) fail("backoff-active")
        if (ledger.rounds.some((round) => round.roundID === command.roundID)) fail("round-conflict")
        ledger.consumed++
        ledger.rounds.push({ roundID: command.roundID, number: ledger.consumed,
          status: "open", executionIDs: [], failureEvidence: [] })
        delete ledger.reworkPlan
      }
      if (Object.values(state.executions).some((record) => record.cardID === command.cardID
        && record.roundID === command.roundID && record.stageID === command.stageID)) fail("stage-conflict")
      ledger.rounds.at(-1)!.executionIDs.push(command.executionID)
      next.workRounds[command.cardID] = ledger
      next.executions[command.executionID] = {
        executionID: command.executionID, cardID: command.cardID, revisionID: command.revisionID,
        roundID: command.roundID, stageID: command.stageID, profile: command.profile,
        policyFingerprint: command.policyFingerprint, controllerEpoch: command.controllerEpoch,
        claimedAt: command.at, writes: [...new Set(command.writes)].sort(),
        status: "reserved", reservation: "held", sealed: false, needsReconciliation: false,
        terminalObservations: [], stopVerifications: [], failureEvidence: [],
      }
      recordOperation(next, command.operationID, command)
      move(next, target, "in_progress", command.at, `execution:${command.executionID}`)
      return next
    }
    case "bind_session": {
      const record = execution(next, command.executionID)
      if (record.sessionID) {
        if (record.sessionID !== command.sessionID) fail("session-conflict")
        return state
      }
      if (record.status !== "reserved" || record.reservation !== "held") fail("recovery-pending")
      if (Object.values(state.executions).some((owner) => owner.sessionID === command.sessionID)
        || Object.values(state.board.cards).some((target) => target.assignments.some((assignment) => assignment.sessionID === command.sessionID))) fail("session-conflict")
      const target = card(next, record.cardID)
      if (target.lane !== "in_progress" || target.assignments.some((assignment) => assignment.endedAt === undefined)) fail("assignment-conflict")
      record.sessionID = command.sessionID
      record.assignmentIndex = target.assignments.length
      record.status = "running"
      target.profile = record.profile
      target.assignments.push({ profile: record.profile, sessionID: command.sessionID, startedAt: command.at })
      history(target, "assigned", command.at, `execution:${record.executionID}`, record.profile)
      return next
    }
    case "request_disposition": {
      const record = execution(next, command.executionID)
      matchingSession(record, command.sessionID)
      if (replay(state, command.operationID, command)) return state
      if (record.sealed || record.settlement) fail("disposition-sealed")
      if (record.pendingDisposition) fail("disposition-conflict")
      if (record.status === "unknown" || record.reservation !== "held") fail("recovery-pending")
      validateDisposition(command.disposition, record)
      record.pendingDisposition = { operationID: command.operationID, disposition: clone(command.disposition), at: command.at }
      recordOperation(next, command.operationID, command)
      return next
    }
    case "request_stop": {
      const record = execution(next, command.executionID)
      if (replay(state, command.operationID, command)) return state
      if (record.settlement) fail("execution-settled")
      if (!["settle_disposition", "budget", "safety"].includes(command.reason)) fail("bad-stop-reason")
      if (command.reason === "settle_disposition" && !record.pendingDisposition) fail("disposition-required")
      if (record.stopRequest) fail("stop-conflict")
      record.stopRequest = { operationID: command.operationID, reason: command.reason, at: command.at }
      if (record.status !== "unknown") record.status = "stop_requested"
      recordOperation(next, command.operationID, command)
      return next
    }
    case "observe_terminal": {
      const record = execution(next, command.executionID)
      matchingSession(record, command.sessionID)
      if (replay(state, command.observationID, command)) return state
      if (!["succeeded", "failed", "interrupted"].includes(command.outcome)) fail("bad-outcome")
      record.sealed = true
      record.terminalObservations.push({ observationID: command.observationID, outcome: command.outcome, detail: command.detail, at: command.at })
      if (command.outcome === "failed") record.failureEvidence.push(nonblank(command.detail) ? command.detail : "execution-failure")
      if (record.settlement && command.outcome !== "succeeded") {
        record.reconciliationFault = "Late terminal evidence requires human reconciliation; prior settlement is immutable"
        next.admissionPaused = true
      } else if (record.status !== "unknown" && !record.settlement) record.status = "settling"
      recordOperation(next, command.observationID, command)
      return next
    }
    case "verify_stop": {
      const record = execution(next, command.executionID)
      validateReceipt(command.receipt, record)
      if (record.stopVerifiedEpoch === command.controllerEpoch
        && canonical(record.stopReceipt ?? null) === canonical(command.receipt)) return state
      if (record.stopVerifications.some((verification) => verification.controllerEpoch === command.controllerEpoch
        && canonical(verification.receipt) === canonical(command.receipt)) && record.settlement) return state
      record.stopVerifications.push({ controllerEpoch: command.controllerEpoch, at: command.at, receipt: clone(command.receipt) })
      if (typeof command.receipt.independentFailure === "object") record.failureEvidence.push(command.receipt.independentFailure.reason)
      if (command.receipt.cause === "unexpected") record.failureEvidence.push("unexpected-stop")
      if (record.settlement) {
        record.reconciliationFault = "Late stop evidence requires human reconciliation; prior settlement is immutable"
        next.admissionPaused = true
        return next
      }
      record.stopReceipt = clone(command.receipt)
      record.stopVerifiedEpoch = command.controllerEpoch
      if (record.status !== "unknown") record.status = "settling"
      return next
    }
    case "settle": {
      const record = execution(next, command.executionID)
      if (record.settlement) return state
      settleExecution(next, record, command.at)
      return next
    }
    case "plan_rework": {
      const target = card(next, command.cardID)
      if (!Object.hasOwn(next.workRounds, command.cardID)) fail("rework-unplanned")
      const ledger = next.workRounds[command.cardID]!
      if (ledger.consumed >= 5) fail("budget-exhausted")
      if (ledger.requiredAction || target.lane === "blocked") fail("human-action-required")
      const round = ledger.rounds.at(-1)
      if (target.lane !== "failed" || round?.status !== "failed"
        || Object.values(next.executions).some((record) => record.cardID === command.cardID && record.reservation === "held")) fail("rework-unplanned")
      const previous = execution(next, round.executionIDs.at(-1)!)
      if (!previous.settlement || previous.stopReceipt?.effects !== "known") fail("stop-unproved")
      if (!nonblank(command.reason) || !["backlog", "triage"].includes(command.route)) fail("bad-rework")
      timestamp(command.nextEligibleAt)
      if (Date.parse(command.nextEligibleAt) <= Date.parse(command.at)) fail("bad-backoff")
      ledger.reworkPlan = { reason: command.reason, route: command.route, nextEligibleAt: command.nextEligibleAt }
      ledger.nextEligibleAt = command.nextEligibleAt
      move(next, target, command.route, command.at, "controller")
      history(target, "note", command.at, "controller", command.reason)
      return next
    }
    case "recover": {
      if (command.nextEpoch === state.controllerEpoch) fail("epoch-conflict")
      if (state.retiredEpochs.includes(command.nextEpoch)) fail("retired-epoch")
      next.retiredEpochs.push(state.controllerEpoch)
      next.controllerEpoch = command.nextEpoch
      for (const record of Object.values(next.executions)) {
        if (record.reservation === "released") continue
        record.status = "unknown"
        record.needsReconciliation = true
        // Preserve evidence; stopVerifiedEpoch fences it from the new epoch.
      }
      next.admissionPaused = Object.values(next.executions).some((record) => record.needsReconciliation || record.reconciliationFault !== undefined)
      return next
    }
    default: fail("unknown-command")
  }
}

/** Negative safety gate only, never authentication or a replacement caller policy. */
export function guardFoundationMutation(state: ExecutionState, mutation: FoundationMutation): void {
  switch (mutation.type) {
    case "read":
    case "comment": return
    case "create":
      if ((mutation.lane ?? "triage") === "triage") return
      break
    case "move": {
      id(mutation.cardID)
      const target = card(state, mutation.cardID)
      const protectedLanes = ["in_progress", "review", "failed", "blocked", "done", "cancelled"]
      if (!protectedLanes.includes(target.lane) && !protectedLanes.includes(mutation.toLane)
        && ["triage", "backlog", "ready"].includes(mutation.toLane)
        && !Object.values(state.executions).some((record) => record.cardID === target.id && record.reservation === "held")) return
      break
    }
  }
  fail("mutation-denied", "foundation cannot authorize this mutation")
}
