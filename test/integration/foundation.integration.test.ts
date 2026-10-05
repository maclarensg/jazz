import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import { createBoard, createCard } from "../../src/board"
import { applyExecutionCommand, createExecutionState } from "../../src/execution-state"
import { foundationNamespace, startFoundationServer } from "./foundation-harness"

function seedFixture(nonce: string) {
  const at = "2026-10-05T10:00:00.000Z"
  let state = createExecutionState(createCard(createBoard(), { title: nonce, lane: "ready" }, () => "card-nonce").board, "previous-controller")
  state = applyExecutionCommand(state, { type: "claim", controllerEpoch: "previous-controller", at,
    operationID: "claim-nonce", executionID: "exec-nonce", cardID: "card-nonce", revisionID: "revision-nonce",
    roundID: "round-nonce", stageID: "stage-nonce", profile: "swe", policyFingerprint: "policy-nonce", writes: ["jazz:src"] })
  state = applyExecutionCommand(state, { type: "bind_session", controllerEpoch: "previous-controller", at,
    executionID: "exec-nonce", sessionID: "retained-session-nonce" })
  // Synthetic retained state, not a spawned worker or authenticated stop proof.
  return { schemaVersion: 1, commitSequence: 3, state }
}

describe("real OpenCode nonexecuting foundation", () => {
  it("denies final intake, review spoofing, removal, cron and tools without any write or runtime call", async () => {
    const root = await foundationNamespace()
    const server = await startFoundationServer(root)
    try {
      expect(await server.rpc("board.get")).toMatchObject({ status: 200, body: { output: { cards: {} } } })
      expect(await server.rpc("factory.status")).toMatchObject({ status: 200, body: { output: {
        mode: "foundation", executionEnabled: false, writesEnabled: false, humanVerdictsEnabled: false,
        leaseInventoryKnown: true, source: "empty", faults: expect.arrayContaining(["ownership_unverified", "managed_child_stop_unverified", "human_authority_unverified"]),
      } } })
      const attempts: [string, unknown][] = [
        ["card.create", { title: "must-not-exist", lane: "done", actor: "gavin" }],
        ["card.create", { title: "even-intake-denied", lane: "triage" }],
        ["card.move", { cardID: "unknown", lane: "done" }],
        ["card.remove", { cardID: "unknown" }],
        ["card.comment", { cardID: "unknown", author: "gavin", body: "no partial evidence" }],
        ["card.work", { cardID: "unknown", prompt: "must not execute" }],
        ["review.decide", { cardID: "unknown", decision: "accept", note: "must not write" }],
        ["review.decide", { cardID: "unknown", decision: "requeue" }],
        ["board.archiveLane", { lane: "done", actor: "gavin" }],
        ["cron.upsert", { name: "must-not-exist", cronExpr: "* * * * *", prompt: "must not execute" }],
        ["cron.remove", { jobID: "unknown" }], ["cron.runNow", { jobID: "unknown" }],
        ["inbox.ack", { id: "unknown" }], ["inbox.ackAll", {}], ["inbox.clear", { id: "unknown" }], ["inbox.clearAll", {}],
      ]
      for (const [method, input] of attempts) expect(await server.rpc(method, input))
        .toMatchObject({ status: 400, body: { type: "foundation_denied" } })
      for (const name of ["kanban_create_card", "kanban_intake", "kanban_assign", "kanban_work", "kanban_submit_review",
        "kanban_handoff", "kanban_block", "kanban_move_card", "kanban_remove_card", "kanban_comment", "cron_upsert_job", "cron_run_now", "cron_remove_job", "inbox_ack", "inbox_clear", "inbox_clear_all"]) {
        expect(await server.fixture("tool", { name })).toMatchObject({ status: 200, body: { output: { code: "foundation_denied" } } })
      }
      expect(await server.fixture("stats")).toMatchObject({ status: 200, body: { output: { writes: 0, runtimeCalls: 0, raw: null, legacyBoard: null } } })
      expect(await server.call("GET", "/api/session?limit=100")).toMatchObject({ status: 200, body: { data: [] } })
      console.log(`foundation denial target=${server.pid} root=${root}; 16 RPC and 16 registered-tool denials; writes=0 runtimeCalls=0`)
    } finally { await server.close() }
  }, 45000)

  it("preserves the exact retained nonce/round/lease across restart, quarantines rather than releases, and never writes recovery", async () => {
    const root = await foundationNamespace()
    const nonce = randomBytes(16).toString("hex")
    const seed = seedFixture(nonce)
    const first = await startFoundationServer(root, { seed })
    let firstEpoch: string
    try {
      const result = await first.rpc("factory.status")
      expect(result).toMatchObject({ status: 200, body: { output: { source: "foundation", leaseInventoryKnown: true,
        heldExecutions: [{ executionID: "exec-nonce", cardID: "card-nonce", sessionID: "retained-session-nonce", status: "unknown" }],
        roundsConsumed: { "card-nonce": 1 }, faults: expect.arrayContaining(["recovery-not-persisted"]) } } })
      firstEpoch = (result.body as { output: { controllerEpoch: string } }).output.controllerEpoch
      expect(await first.fixture("stats")).toMatchObject({ body: { output: { writes: 0, runtimeCalls: 0, raw: seed } } })
    } finally { await first.close() }
    const second = await startFoundationServer(root)
    try {
      const result = await second.rpc("factory.status")
      expect((result.body as { output: { controllerEpoch: string } }).output.controllerEpoch).not.toBe(firstEpoch!)
      expect(result).toMatchObject({ status: 200, body: { output: { heldExecutions: [{ status: "unknown" }], roundsConsumed: { "card-nonce": 1 } } } })
      expect(await second.rpc("board.get")).toMatchObject({ body: { output: { cards: { "card-nonce": { title: nonce,
        lane: "in_progress", assignments: [{ sessionID: "retained-session-nonce" }] } } } } })
      expect(await second.fixture("stats")).toMatchObject({ body: { output: { writes: 0, runtimeCalls: 0, raw: seed } } })
      expect(await second.call("GET", "/api/session?limit=100")).toMatchObject({ status: 200, body: { data: [] } })
      console.log(`foundation restart nonce=${nonce} root=${root}; retained lease unknown; round=1; disk envelope unchanged`)
    } finally { await second.close() }
  }, 70000)

  it("quarantines unknown/corrupt durable state instead of pretending the inventory is empty", async () => {
    const root = await foundationNamespace()
    const nonce = randomBytes(12).toString("hex")
    const raw = { schemaVersion: 999, nonce }
    const server = await startFoundationServer(root, { seed: raw })
    try {
      expect(await server.rpc("factory.status")).toMatchObject({ status: 200, body: { output: {
        source: "unavailable", leaseInventoryKnown: false, faults: expect.arrayContaining(["storage_unavailable_or_invalid"]),
      } } })
      expect(await server.rpc("board.get")).toMatchObject({ status: 400, body: { type: "foundation_denied" } })
      expect(await server.fixture("stats")).toMatchObject({ body: { output: { writes: 0, runtimeCalls: 0, raw } } })
      console.log(`foundation corrupt nonce=${nonce} root=${root}; inventory unavailable; raw state retained`)
    } finally { await server.close() }
  }, 45000)

  it("keeps legacy creation working in explicit legacy mode; factory guards do not change its authority", async () => {
    const root = await foundationNamespace()
    const server = await startFoundationServer(root, { legacy: true })
    try {
      const nonce = randomBytes(12).toString("hex")
      expect(await server.rpc("card.create", { title: nonce, lane: "done" })).toMatchObject({ status: 200, body: { output: { title: nonce, lane: "done" } } })
      expect(await server.rpc("factory.status")).toMatchObject({ status: 400 })
      console.log(`legacy comparison root=${root}; terminal creation remains legacy behavior, not factory conformance`)
    } finally { await server.close() }
  }, 45000)
})
