import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { startJazzServer, type JazzServer } from "./harness"
import type { BoardState } from "../../src/board"

// dispatcher tick is 15s — give the full cycle plus session-spawn slack
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 })

let server: JazzServer

beforeAll(async () => {
  server = await startJazzServer({ dispatch: true })
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe("dispatcher (real serve, real session)", () => {
  it("picks up a ready-lane card and assigns a worker", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-dispatch-${randomUUID().slice(0, 8)}`, details: "Say done in one line, then kanban_submit_review." })
    await server.jazz["card.move"]({ cardID: card.id, lane: "ready" })

    const deadline = Date.now() + 90_000
    let seen: BoardState | null = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000))
      seen = (await server.jazz["board.get"]({})) as BoardState
      const c = seen.cards[card.id]
      if (c && c.lane !== "ready" && c.assignments.length > 0) break
    }
    const c = seen!.cards[card.id]!
    expect(c.assignments.length).toBeGreaterThanOrEqual(1)
    // the dispatcher must have moved it out of ready (in_progress, or onward if the worker finished fast)
    expect(["in_progress", "review", "done"]).toContain(c.lane)
  }, 150_000)
})
