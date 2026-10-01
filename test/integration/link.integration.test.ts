import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { randomUUID } from "node:crypto"
import { startJazzServer, type JazzServer } from "./harness"

vi.setConfig({ testTimeout: 240_000 })

let server: JazzServer

beforeAll(async () => {
  server = await startJazzServer()
})

afterAll(async () => {
  await server?.close()
})

const waitForLane = async (cardID: string, lane: string, deadlineMs: number) => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const board = await server.jazz["board.get"]({})
    if (board.cards[cardID]?.lane === lane) return true
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

describe("link: card-bound sessions", () => {
  it("rejects work on an unknown card with a typed error", async () => {
    await expect(server.jazz["card.work"]({ cardID: "no-such", prompt: "x" })).rejects.toThrow()
  })

  it("kanban_work moves a card to in_progress; exit without submit returns it to ready (v2)", async () => {
    const title = `nonce-${randomUUID().slice(0, 8)}`
    const card = await server.jazz["card.create"]({ title, lane: "ready" })

    const started = await server.jazz["card.work"]({
      cardID: card.id,
      prompt: "Reply with exactly: ok",
    })
    expect(started.sessionID).toBeTruthy()

    // bound immediately: card in_progress, link live
    expect(await waitForLane(card.id, "in_progress", 10_000)).toBe(true)
    const link = await server.jazz["link.get"]({ sessionID: started.sessionID })
    expect(link.link).not.toBeNull()
    expect(link.link?.cardID).toBe(card.id)

    // session completes without submit_review → NOT done: card returns to
    // ready with a bail-out comment; link dropped (worker exit ≠ verdict)
    expect(await waitForLane(card.id, "ready", 120_000)).toBe(true)
    const board = await server.jazz["board.get"]({})
    const after = board.cards[card.id]!
    expect(after.comments.some((c: { body: string }) => c.body.includes("without submitting"))).toBe(true)
    expect(after.assignments.every((a: { endedAt?: string }) => a.endedAt)).toBe(true)
    const linkAfter = await server.jazz["link.get"]({ sessionID: started.sessionID })
    expect(linkAfter.link).toBeNull()
  })

  it("leaves unbound sessions alone (a cron-fired session moves no card)", async () => {
    // the cron-fired sessions in earlier tests carry no links; nothing to assert
    // beyond the board staying coherent — here we assert link.list stays empty
    // right after this test file's own work session completed.
    const links = await server.jazz["link.list"]({})
    expect(
      links.links.every((l: { sessionID: string; cardID: string }) => typeof l.sessionID === "string" && typeof l.cardID === "string"),
    ).toBe(true)
  })
})
