import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import { createBoard, createCard } from "../../src/board"
import { applyExecutionCommand, createExecutionState, type ExecutionCommand } from "../../src/execution-state"
import { foundationNamespace, startFoundationServer } from "./foundation-harness"

function reviewFixture(nonce: string) {
  const at = "2026-10-05T10:00:00.000Z", epoch = "fixture-epoch"
  let state = createExecutionState(createCard(createBoard(), { title: nonce, lane: "ready" }, () => "card-review").board, epoch)
  const commands: ExecutionCommand[] = [
    { type: "claim", controllerEpoch: epoch, at, operationID: "claim-review", executionID: "exec-review", cardID: "card-review",
      revisionID: "revision-review", roundID: "round-review", stageID: "stage-review", profile: "swe", policyFingerprint: "policy-review", writes: ["jazz:src"] },
    { type: "bind_session", controllerEpoch: epoch, at, executionID: "exec-review", sessionID: "session-review" },
    { type: "request_disposition", controllerEpoch: epoch, at, executionID: "exec-review", sessionID: "session-review", operationID: "disposition-review",
      disposition: { kind: "review", evidence: { id: "evidence-review", revisionID: "revision-review", references: [nonce], acceptance: ["fixture"], provenance: ["synthetic"], testResults: ["not runtime stop proof"], knownGaps: [] } } },
    { type: "observe_terminal", controllerEpoch: epoch, at, executionID: "exec-review", sessionID: "session-review", observationID: "terminal-review", outcome: "succeeded", detail: "synthetic fixture" },
    { type: "verify_stop", controllerEpoch: epoch, at, executionID: "exec-review", receipt: { executionID: "exec-review", sessionID: "session-review", process: "stopped", children: "stopped", effects: "known", cause: "natural", independentFailure: "none" } },
    { type: "settle", controllerEpoch: epoch, at, executionID: "exec-review" },
  ]
  for (const command of commands) state = applyExecutionCommand(state, command)
  return { schemaVersion: 1, commitSequence: commands.length + 1, state }
}

describe("adversarial actual-server foundation", () => {
  it("concurrent finalization/requeue/mutations cannot alter a retained review cycle", async () => {
    const root = await foundationNamespace(), nonce = randomBytes(12).toString("hex")
    const seed = reviewFixture(nonce)
    const server = await startFoundationServer(root, { seed })
    try {
      const decisions = await Promise.all(["accept", "cancel", "requeue"].map((decision) =>
        server.rpc("review.decide", { cardID: "card-review", decision, note: nonce, actor: "gavin", authenticated: true })))
      for (const result of decisions) expect(result).toMatchObject({ status: 400, body: { type: "foundation_denied" } })
      const simultaneous = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        server.rpc("card.create", { title: `${nonce}-${i}`, lane: i % 2 ? "done" : "triage" })))
      for (const result of simultaneous) expect(result).toMatchObject({ status: 400, body: { type: "foundation_denied" } })
      for (const method of ["execution.claim", "execution.verify_stop", "execution.settle", "grant_budget"]) {
        expect(await server.rpc(method, { human: true, authenticated: true })).toMatchObject({ status: 400, body: { type: "rpc.method_not_found" } })
      }
      expect(await server.rpc("board.get")).toMatchObject({ status: 200, body: { output: { cards: { "card-review": { lane: "review", title: nonce } } } } })
      expect(await server.fixture("stats")).toMatchObject({ body: { output: { writes: 0, runtimeCalls: 0, raw: seed } } })
      console.log(`adversarial review nonce=${nonce}; three verdicts, eight concurrent creates denied; no public receipt/grant API`)
    } finally { await server.close() }
  }, 45000)

  it("a durable round-counter reset faults inventory and preserves the raw bytes rather than minting more budget", async () => {
    const root = await foundationNamespace(), nonce = randomBytes(12).toString("hex")
    const seed = reviewFixture(nonce)
    seed.state.workRounds["card-review"]!.consumed = 0
    const server = await startFoundationServer(root, { seed })
    try {
      expect(await server.rpc("factory.status")).toMatchObject({ status: 200, body: { output: { source: "unavailable", leaseInventoryKnown: false } } })
      expect(await server.rpc("board.get")).toMatchObject({ status: 400, body: { type: "foundation_denied" } })
      expect(await server.fixture("stats")).toMatchObject({ body: { output: { writes: 0, runtimeCalls: 0, raw: seed } } })
    } finally { await server.close() }
  }, 45000)

  it.each(["board", "cron"] as const)("refuses an existing legacy %s namespace without adoption or writes", async (kind) => {
    const root = await foundationNamespace(), nonce = randomBytes(12).toString("hex")
    const legacy = await startFoundationServer(root, { legacy: true })
    let before: unknown
    try {
      const method = kind === "board" ? "card.create" : "cron.upsert"
      const input = kind === "board" ? { title: nonce, lane: "triage" }
        : { name: nonce, cronExpr: "* * * * *", prompt: nonce, enabled: false }
      expect(await legacy.rpc(method, input)).toMatchObject({ status: 200 })
      before = await legacy.fixture("stats")
    } finally { await legacy.close() }
    const foundation = await startFoundationServer(root)
    try {
      expect(await foundation.rpc("factory.status")).toMatchObject({ status: 200, body: { output: { source: "unavailable", leaseInventoryKnown: false, faults: expect.arrayContaining(["legacy_data_present"]) } } })
      expect(await foundation.rpc("board.get")).toMatchObject({ status: 400, body: { type: "foundation_denied" } })
      expect(await foundation.fixture("stats")).toMatchObject({ body: { output: { writes: 0, runtimeCalls: 0,
        raw: null, legacyBoard: (before as { body: { output: { legacyBoard: unknown } } }).body.output.legacyBoard } } })
      expect(await foundation.call("GET", "/api/session?limit=100")).toMatchObject({ status: 200, body: { data: [] } })
      console.log(`legacy ${kind} refusal nonce=${nonce}; no migration or runtime calls`)
    } finally { await foundation.close() }
  }, 70000)
})
