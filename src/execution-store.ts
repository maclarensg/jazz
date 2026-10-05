import { z } from "zod"
import { createBoard, DEFAULT_LANES, type BoardState } from "./board"
import { applyExecutionCommand, createExecutionState, type ExecutionCommand, type ExecutionState } from "./execution-state"
import type { JsonStorage } from "./storage"

export const EXECUTION_STATE_KEY = "factory/state/v1"
export interface ExecutionEnvelope { schemaVersion: 1; commitSequence: number; state: ExecutionState }
/**
 * INTERNAL trusted adapter boundary, not authentication from a caller's object
 * or boolean. The adapter must prove exclusive ownership for this controller's
 * whole mutation interval, including outstanding storage I/O. No production
 * producer is wired: the installed runtime cannot currently establish this.
 * Never construct/accept it from public tools, RPC, actor labels or receipts.
 */
export interface InternalExecutionOwnership { assertWritable(): void | Promise<void> }
export class ExecutionStoreError extends Error {
  constructor(public code: string, message = code) { super(message); this.name = "ExecutionStoreError" }
}

const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value))
const Time = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)))
const Text = z.string().refine((value) => value.trim().length > 0)
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const WriteID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine((value) => !value.slice(value.indexOf(":") + 1).split("/").some((part) => part === "." || part === ".."))
const Evidence = z.strictObject({ id: ID, revisionID: ID, references: z.array(Text), acceptance: z.array(Text).min(1),
  testResults: z.array(Text), knownGaps: z.array(Text), provenance: z.array(Text).min(1) })
const Disposition = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("review"), evidence: Evidence }),
  z.strictObject({ kind: z.literal("failed"), evidence: Evidence, reason: Text }),
  z.strictObject({ kind: z.literal("blocked"), evidence: Evidence, requiredAction: Text }),
  z.strictObject({ kind: z.literal("handoff"), evidence: Evidence, nextProfile: ID, reason: Text }),
])
const Receipt = z.strictObject({ executionID: ID, sessionID: ID, process: z.enum(["stopped", "live", "unknown"]),
  children: z.enum(["stopped", "live", "unknown"]), effects: z.enum(["known", "unknown"]),
  cause: z.enum(["natural", "settle_disposition", "unexpected", "unknown"]),
  independentFailure: z.union([z.enum(["none", "unknown"]), z.strictObject({ reason: Text })]), stopOperationID: ID.optional() })
const StopReason = z.enum(["settle_disposition", "budget", "safety"])
const Outcome = z.enum(["succeeded", "failed", "interrupted"])
const Assignment = z.strictObject({ profile: ID, sessionID: ID.optional(), startedAt: Time, endedAt: Time.optional(),
  outcome: z.enum(["handoff", "submitted", "exited", "failed"]).optional() })
const CardSchema = z.strictObject({ id: ID, title: z.string(), details: z.string().optional(), priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  lane: ID, profile: ID.optional(), assignments: z.array(Assignment),
  comments: z.array(z.strictObject({ id: ID, author: Text, body: Text, ts: Time })),
  history: z.array(z.strictObject({ ts: Time, kind: z.enum(["created", "moved", "assigned", "handoff", "comment", "review", "routed", "cron", "exit", "note"]),
    actor: Text, from: ID.optional(), to: ID.optional(), detail: z.string().optional() })),
  source: z.enum(["manual", "cron", "session", "requeue"]), created: Time, updated: Time })
const BoardSchema = z.strictObject({ cards: z.record(ID, CardSchema), lanes: z.record(ID, z.array(ID)) })
const RecordSchema = z.strictObject({ executionID: ID, cardID: ID, revisionID: ID, roundID: ID, stageID: ID, profile: ID,
  policyFingerprint: Text, controllerEpoch: ID, claimedAt: Time, writes: z.array(WriteID),
  status: z.enum(["reserved", "running", "stop_requested", "settling", "unknown", "released"]), reservation: z.enum(["held", "released"]),
  sessionID: ID.optional(), assignmentIndex: Counter.optional(), sealed: z.boolean(), needsReconciliation: z.boolean(),
  pendingDisposition: z.strictObject({ operationID: ID, disposition: Disposition, at: Time }).optional(),
  stopRequest: z.strictObject({ operationID: ID, reason: StopReason, at: Time }).optional(),
  terminalObservations: z.array(z.strictObject({ observationID: ID, outcome: Outcome, detail: z.string(), at: Time })),
  stopReceipt: Receipt.optional(), stopVerifiedEpoch: ID.optional(),
  stopVerifications: z.array(z.strictObject({ controllerEpoch: ID, at: Time, receipt: Receipt })),
  failureEvidence: z.array(Text), settlement: z.strictObject({ kind: z.enum(["review", "failed", "blocked", "handoff"]),
    terminalObservationCount: Counter.min(1), failureEvidenceCount: Counter, stopVerificationCount: Counter.min(1),
    reason: Text.optional(), requiredAction: Text.optional(), at: Time }).optional(), reconciliationFault: Text.optional() })
const StateSchema = z.strictObject({ controllerEpoch: ID, retiredEpochs: z.array(ID), board: BoardSchema, executions: z.record(ID, RecordSchema),
  workRounds: z.record(ID, z.strictObject({ consumed: Counter.max(5),
    rounds: z.array(z.strictObject({ roundID: ID, number: Counter.min(1).max(5), status: z.enum(["open", "failed", "review"]),
      executionIDs: z.array(ID).min(1), failureEvidence: z.array(Text) })),
    nextEligibleAt: Time.optional(), reworkPlan: z.strictObject({ reason: Text, route: z.enum(["backlog", "triage"]), nextEligibleAt: Time }).optional(),
    requiredAction: Text.optional() })),
  reviews: z.record(ID, z.strictObject({ cardID: ID, executionID: ID, roundID: ID, evidence: Evidence,
    reviewerIntent: z.strictObject({ profile: z.literal("neolilith"), status: z.literal("deferred"), sessionID: ID.optional() }) })),
  operations: z.record(ID, z.string()), admissionPaused: z.boolean() })
const EnvelopeSchema = z.strictObject({ schemaVersion: z.literal(1), commitSequence: Counter.min(1), state: StateSchema })

// Fingerprints are reducer-generated canonical command payloads, minus `at`.
const OperationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("claim"), controllerEpoch: ID, operationID: ID, executionID: ID, cardID: ID,
    revisionID: ID, roundID: ID, stageID: ID, profile: ID, policyFingerprint: Text, writes: z.array(WriteID) }),
  z.strictObject({ type: z.literal("request_disposition"), controllerEpoch: ID, operationID: ID, executionID: ID, sessionID: ID, disposition: Disposition }),
  z.strictObject({ type: z.literal("request_stop"), controllerEpoch: ID, operationID: ID, executionID: ID, reason: StopReason }),
  z.strictObject({ type: z.literal("observe_terminal"), controllerEpoch: ID, executionID: ID, sessionID: ID,
    observationID: ID, outcome: Outcome, detail: z.string() }),
])

function fail(code: string, message = code): never { throw new ExecutionStoreError(code, message) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)
}
function check(condition: unknown, detail: string): asserts condition { if (!condition) fail("invalid-envelope", detail) }
function unique(values: string[]): boolean { return new Set(values).size === values.length }
function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** Reject non-JSON objects and unsafe dictionary keys before parsing or cloning. */
function checkJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") { check(Number.isFinite(value), "nonfinite JSON number"); return }
  check(typeof value === "object" && value !== null, "non-JSON value")
  check(!ancestors.has(value), "cyclic value")
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "non-JSON prototype")
  ancestors.add(value)
  for (const key of Object.keys(value)) {
    check(!["__proto__", "constructor", "prototype"].includes(key), "unsafe dictionary key")
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    check("value" in descriptor, "non-JSON accessor")
    checkJson(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}

function validateSemantics(state: ExecutionState): void {
  const { board, executions, workRounds, reviews, operations } = state
  check(unique(state.retiredEpochs) && !state.retiredEpochs.includes(state.controllerEpoch), "invalid retired epochs")
  check(Object.keys(board.lanes).length === DEFAULT_LANES.length && DEFAULT_LANES.every((lane) => Object.hasOwn(board.lanes, lane)), "noncanonical lanes")
  const membership = new Set<string>()
  for (const [lane, ids] of Object.entries(board.lanes)) for (const cardID of ids) {
    check(Object.hasOwn(board.cards, cardID) && board.cards[cardID]!.lane === lane && !membership.has(cardID), "card lane membership mismatch")
    membership.add(cardID)
  }
  const assignmentSessions = new Set<string>()
  for (const [cardID, card] of Object.entries(board.cards)) {
    check(card.id === cardID && membership.has(cardID), "card identity or membership mismatch")
    check(unique(card.comments.map((comment) => comment.id)), "duplicate comment identity")
    for (const assignment of card.assignments) {
      check((assignment.endedAt === undefined) === (assignment.outcome === undefined), "assignment closure mismatch")
      if (assignment.sessionID) {
        check(!assignmentSessions.has(assignment.sessionID), "duplicate assignment session")
        assignmentSessions.add(assignment.sessionID)
      }
    }
  }
  const linked = new Set<string>()
  for (const [cardID, ledger] of Object.entries(workRounds)) {
    check(Object.hasOwn(board.cards, cardID) && ledger.consumed === ledger.rounds.length && ledger.consumed > 0, "round budget mismatch")
    check(unique(ledger.rounds.map((round) => round.roundID)), "duplicate round identity")
    if (ledger.reworkPlan) check(ledger.nextEligibleAt === ledger.reworkPlan.nextEligibleAt && ledger.rounds.at(-1)!.status === "failed", "rework backoff mismatch")
    for (const [index, round] of ledger.rounds.entries()) {
      check(round.number === index + 1 && (index === ledger.rounds.length - 1 || round.status === "failed"), "round sequence mismatch")
      const stages = new Set<string>()
      for (const executionID of round.executionIDs) {
        const record = Object.hasOwn(executions, executionID) ? executions[executionID] : undefined
        check(record && record.cardID === cardID && record.roundID === round.roundID && !linked.has(executionID), "execution round link mismatch")
        check(!stages.has(record.stageID), "duplicate stage identity")
        stages.add(record.stageID); linked.add(executionID)
        if (record.reservation === "held") check(round.status === "open" && index === ledger.rounds.length - 1, "held closed round")
      }
      const last = executions[round.executionIDs.at(-1)!]!
      if (round.status === "review") check(last.settlement?.kind === "review", "review round mismatch")
      if (round.status === "failed") check(last.settlement?.kind === "failed" || (last.settlement?.kind === "blocked" && last.settlement.reason !== undefined), "failed round mismatch")
      if (round.status === "open") check(round.executionIDs.every((id) => !executions[id]!.settlement || ["handoff", "blocked"].includes(executions[id]!.settlement!.kind)), "open round settlement mismatch")
    }
  }
  const heldCards = new Set<string>(), sessions = new Set<string>()
  const heldRecords = Object.values(executions).filter((record) => record.reservation === "held")
  for (const [executionID, record] of Object.entries(executions)) {
    check(record.executionID === executionID && Object.hasOwn(board.cards, record.cardID) && linked.has(executionID), "execution identity or ledger missing")
    check(unique(record.writes) && canonical(record.writes) === canonical([...record.writes].sort()), "noncanonical writes")
    const released = record.reservation === "released"
    check(released === (record.status === "released") && released === (record.settlement !== undefined), "release/settlement mismatch")
    check(record.needsReconciliation === (record.status === "unknown"), "reconciliation status mismatch")
    check(record.sealed === (record.terminalObservations.length > 0), "terminal seal mismatch")
    check(unique(record.terminalObservations.map((observation) => observation.observationID)), "duplicate terminal identity")
    check((record.sessionID === undefined) === (record.assignmentIndex === undefined), "session index missing")
    const target = board.cards[record.cardID]!
    if (!released) {
      check(!heldCards.has(record.cardID) && target.lane === "in_progress", "multiple held card owners or wrong lane")
      heldCards.add(record.cardID)
      check(record.controllerEpoch === state.controllerEpoch || record.status === "unknown", "unreconciled stale execution")
      for (const other of heldRecords) if (other.executionID !== executionID) check(!record.writes.some((left) => other.writes.some((right) => overlaps(left, right))), "overlapping held writes")
    }
    if (record.sessionID) {
      check(!sessions.has(record.sessionID), "duplicate execution session"); sessions.add(record.sessionID)
      const assignment = target.assignments[record.assignmentIndex!]
      check(assignment && assignment.sessionID === record.sessionID && assignment.profile === record.profile, "assignment index mismatch")
      check(released === (assignment.endedAt !== undefined), "assignment release mismatch")
      if (record.settlement) check(assignment.endedAt === record.settlement.at, "settlement assignment time mismatch")
      if (!released) check(target.profile === record.profile && record.status !== "reserved", "running profile mismatch")
    } else check(!released && !record.pendingDisposition && !record.stopReceipt && !record.stopVerifications.length
      && !record.terminalObservations.length && ["reserved", "unknown", "stop_requested"].includes(record.status), "unbound execution evidence")
    if (record.pendingDisposition) check(record.pendingDisposition.disposition.evidence.revisionID === record.revisionID, "disposition revision mismatch")
    if (record.stopRequest?.reason === "settle_disposition") check(record.pendingDisposition, "stop disposition missing")
    for (const receipt of [record.stopReceipt, ...record.stopVerifications.map((verification) => verification.receipt)]) if (receipt) {
      check(receipt.executionID === executionID && receipt.sessionID === record.sessionID, "stop receipt identity mismatch")
    }
    check((record.stopReceipt === undefined) === (record.stopVerifiedEpoch === undefined), "stop verification epoch missing")
    if (record.stopReceipt) check(record.stopVerifications.some((verification) => verification.controllerEpoch === record.stopVerifiedEpoch
      && canonical(verification.receipt) === canonical(record.stopReceipt)), "stop verification history missing")
    if (released) {
      const receipt = record.stopReceipt
      const settlement = record.settlement!
      check(settlement.terminalObservationCount <= record.terminalObservations.length
        && settlement.failureEvidenceCount <= record.failureEvidence.length
        && settlement.stopVerificationCount <= record.stopVerifications.length, "settlement evidence prefix missing")
      const settledVerification = record.stopVerifications[settlement.stopVerificationCount - 1]!
      check(settledVerification.controllerEpoch === record.stopVerifiedEpoch
        && canonical(settledVerification.receipt) === canonical(receipt), "settlement stop verification mismatch")
      const settledObservations = record.terminalObservations.slice(0, settlement.terminalObservationCount)
      const settledFailures = record.failureEvidence.slice(0, settlement.failureEvidenceCount)
      const lateFault = record.terminalObservations.slice(settlement.terminalObservationCount)
        .some((observation) => observation.outcome !== "succeeded")
        || record.failureEvidence.length > settlement.failureEvidenceCount
        || record.stopVerifications.length > settlement.stopVerificationCount
      if (lateFault) check(record.reconciliationFault, "late evidence lost its reconciliation fault")
      check(record.sealed && receipt && receipt.process === "stopped" && receipt.children === "stopped"
        && receipt.effects === "known" && receipt.cause !== "unknown" && receipt.independentFailure !== "unknown", "released stop unproved")
      if (receipt.cause === "settle_disposition") check(record.pendingDisposition && record.stopRequest?.reason === "settle_disposition"
        && receipt.stopOperationID === record.stopRequest.operationID, "released stop correlation missing")
      if (receipt.cause === "natural" && settledObservations.some((observation) => observation.outcome === "interrupted")) {
        check(settledObservations.some((observation) => observation.outcome === "failed") || settledFailures.length, "released interruption unproved")
      }
      if (["review", "handoff"].includes(settlement.kind)) check(receipt.independentFailure === "none"
        && receipt.cause !== "unexpected" && !settledFailures.length
        && !settledObservations.some((observation) => observation.outcome === "failed")
        && (!record.stopRequest || record.stopRequest.reason === "settle_disposition"), "successful settlement contains genuine failure")
      if (record.settlement!.kind === "review") check(record.pendingDisposition?.disposition.kind === "review"
        && Object.hasOwn(reviews, `review:${executionID}`), "review settlement missing intent")
      if (record.settlement!.kind === "handoff") check(record.pendingDisposition?.disposition.kind === "handoff", "handoff disposition missing")
      if (record.settlement!.kind === "blocked") check(record.settlement!.requiredAction, "blocked action missing")
    }
  }
  for (const target of Object.values(board.cards)) for (const [index, assignment] of target.assignments.entries()) {
    if (assignment.endedAt === undefined) check(heldRecords.some((record) => record.cardID === target.id
      && record.assignmentIndex === index && record.sessionID === assignment.sessionID), "untracked open assignment")
  }
  for (const [reviewID, review] of Object.entries(reviews)) {
    const record = Object.hasOwn(executions, review.executionID) ? executions[review.executionID] : undefined
    check(record && reviewID === `review:${review.executionID}` && record.settlement?.kind === "review"
      && record.cardID === review.cardID && record.roundID === review.roundID
      && canonical(record.pendingDisposition!.disposition.evidence) === canonical(review.evidence), "review intent mismatch")
    // Physical reviewer creation is unsupported in this foundation schema.
    check(review.reviewerIntent.sessionID === undefined, "unsupported reviewer session")
  }
  check(state.admissionPaused === Object.values(executions).some((record) => record.needsReconciliation || record.reconciliationFault !== undefined), "admission pause mismatch")

  const claims = new Set<string>(), seenOperations = new Set<string>()
  for (const [operationID, fingerprint] of Object.entries(operations)) {
    let raw: unknown
    try { raw = JSON.parse(fingerprint) } catch { fail("invalid-envelope", "invalid operation JSON") }
    checkJson(raw)
    const parsed = OperationSchema.safeParse(raw)
    check(parsed.success && canonical(raw) === fingerprint, "invalid operation fingerprint")
    const operation = parsed.data
    const record = Object.hasOwn(executions, operation.executionID) ? executions[operation.executionID] : undefined
    check(record, "operation execution missing")
    const key = operation.type === "observe_terminal" ? operation.observationID : operation.operationID
    check(operationID === key, "operation key mismatch")
    if (operation.type === "claim") {
      check(!claims.has(record.executionID) && operation.controllerEpoch === record.controllerEpoch
        && operation.cardID === record.cardID && operation.revisionID === record.revisionID && operation.roundID === record.roundID
        && operation.stageID === record.stageID && operation.profile === record.profile && operation.policyFingerprint === record.policyFingerprint
        && canonical([...new Set(operation.writes)].sort()) === canonical(record.writes)
        && canonical(operation.writes) === canonical([...operation.writes].sort()), "claim fingerprint mismatch")
      claims.add(record.executionID)
    } else if (operation.type === "request_disposition") {
      check(operation.sessionID === record.sessionID && record.pendingDisposition?.operationID === operationID
        && canonical(operation.disposition) === canonical(record.pendingDisposition.disposition), "disposition fingerprint mismatch")
    } else if (operation.type === "request_stop") {
      check(record.stopRequest?.operationID === operationID && operation.reason === record.stopRequest.reason, "stop fingerprint mismatch")
    } else {
      check(operation.sessionID === record.sessionID && record.terminalObservations.some((observation) => observation.observationID === operationID
        && operation.outcome === observation.outcome && operation.detail === observation.detail), "terminal fingerprint mismatch")
    }
    seenOperations.add(operationID)
  }
  for (const record of Object.values(executions)) {
    check(claims.has(record.executionID), "claim operation missing")
    for (const key of [record.pendingDisposition?.operationID, record.stopRequest?.operationID,
      ...record.terminalObservations.map((observation) => observation.observationID)]) if (key) check(seenOperations.has(key), "record operation missing")
  }
}

function validateEnvelope(raw: unknown): ExecutionEnvelope {
  checkJson(raw)
  if (typeof raw === "object" && raw !== null && "schemaVersion" in raw && raw.schemaVersion !== 1) fail("unsupported-schema", "unsupported execution schema version")
  const result = EnvelopeSchema.safeParse(raw)
  if (!result.success) fail("invalid-envelope", result.error.message)
  // Validate without rebuilding/migrating state; essential ledgers are retained.
  const envelope = raw as ExecutionEnvelope
  validateSemantics(envelope.state)
  return clone(envelope)
}

/**
 * One fixed JSON value per acknowledged transition, serialized in this object
 * only. This is NOT a cross-process lock, CAS, database transaction, physical
 * exactly-once execution, or power-loss durability guarantee. The trusted
 * ownership adapter is a prerequisite, not something this queue establishes.
 * No board/state dual-write, migration, implicit initialization or save retry.
 */
export function createExecutionStore(options: {
  storage: JsonStorage; controllerEpoch: string; ownership?: InternalExecutionOwnership
}) {
  if (!ID.safeParse(options.controllerEpoch).success) fail("bad-epoch")
  const { storage, controllerEpoch, ownership } = options
  let frozen = false
  let queue: Promise<unknown> = Promise.resolve()
  async function assertWritable(): Promise<void> {
    if (frozen) fail("writes-frozen")
    if (!ownership || typeof ownership.assertWritable !== "function") fail("ownership-unavailable")
    try { await ownership.assertWritable() } catch { frozen = true; fail("ownership-lost") }
  }
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run)
    queue = result.catch(() => {})
    return result
  }
  async function ownedRead(): Promise<ExecutionEnvelope | undefined> {
    await assertWritable()
    let raw: unknown
    try { raw = await storage.get(EXECUTION_STATE_KEY) }
    catch { await assertWritable(); frozen = true; fail("storage-read-failed") }
    await assertWritable()
    return raw === undefined ? undefined : validateEnvelope(raw)
  }
  async function save(envelope: ExecutionEnvelope): Promise<ExecutionEnvelope> {
    const validated = validateEnvelope(envelope)
    await assertWritable()
    try { await storage.set(EXECUTION_STATE_KEY, clone(validated)) }
    catch { await assertWritable(); frozen = true; fail("persistence-uncertain", "save outcome unknown; no implicit retry") }
    await assertWritable()
    return clone(validated)
  }
  return {
    async inspect(): Promise<{ envelope?: ExecutionEnvelope; view: ExecutionState; source: "empty" | "foundation"; faults: string[] }> {
      let raw: unknown
      try { raw = await storage.get(EXECUTION_STATE_KEY) } catch { fail("storage-read-failed") }
      const faults: string[] = []
      if (!ownership || typeof ownership.assertWritable !== "function") faults.push("ownership-unavailable")
      if (frozen) faults.push("writes-frozen")
      if (raw === undefined) return { view: createExecutionState(createBoard(), controllerEpoch), source: "empty", faults }
      const envelope = validateEnvelope(raw)
      let view = clone(envelope.state)
      if (view.controllerEpoch !== controllerEpoch) {
        view = applyExecutionCommand(view, { type: "recover", controllerEpoch: view.controllerEpoch,
          nextEpoch: controllerEpoch, at: new Date().toISOString() })
        faults.push("recovery-not-persisted")
      }
      return { envelope, view, source: "foundation", faults }
    },
    /** INTERNAL fixture/future-controller data effect; unavailable without ownership. */
    initialize(board: BoardState): Promise<ExecutionEnvelope> {
      const snapshot = clone(board)
      return serialize(async () => {
        const existing = await ownedRead()
        if (existing) fail("already-initialized")
        return save({ schemaVersion: 1, commitSequence: 1, state: createExecutionState(snapshot, controllerEpoch) })
      })
    },
    /**
     * INTERNAL commands only. Explicit recovery alone may name the stored old
     * epoch, and must target THIS owner's epoch; ordinary commands require the
     * configured epoch and previously persisted recovery. No stop/human proof
     * is authenticated here; public consumers must expose inspection only.
     */
    apply(command: ExecutionCommand): Promise<ExecutionEnvelope> {
      const snapshot = clone(command)
      return serialize(async () => {
        const existing = await ownedRead()
        if (!existing) fail("not-initialized")
        if (snapshot.type === "recover") {
          if (snapshot.nextEpoch !== controllerEpoch || snapshot.controllerEpoch !== existing.state.controllerEpoch) fail("stale-epoch")
        } else {
          if (snapshot.controllerEpoch !== controllerEpoch) fail("stale-epoch")
          if (existing.state.controllerEpoch !== controllerEpoch) fail("recovery-required")
        }
        const state = applyExecutionCommand(existing.state, snapshot)
        if (canonical(state) === canonical(existing.state)) return clone(existing)
        if (existing.commitSequence === Number.MAX_SAFE_INTEGER) fail("sequence-exhausted")
        return save({ schemaVersion: 1, commitSequence: existing.commitSequence + 1, state })
      })
    },
  }
}
