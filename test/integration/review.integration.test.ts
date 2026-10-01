import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startJazzServer, type JazzServer } from "./harness"
import type { Card } from "../../src/board"
import type { Notification } from "../../src/inbox"

let server: JazzServer

beforeAll(async () => {
  server = await startJazzServer()
}, 60_000)

afterAll(async () => {
  await server.close()
})

describe("review gate (real server)", () => {
  it("accept moves review → done and stamps routing outcome", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID().slice(0, 8)}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "review" })

    const decided = await server.jazz["review.decide"]({ cardID: card.id, decision: "accept", note: "shipped" })
    expect(decided.lane).toBe("done")

    const board = await server.jazz["board.get"]({})
    const after = board.cards[card.id] as Card
    expect(after.comments.some((c) => c.author === "gavin" && c.body === "shipped")).toBe(true)

    const { notifications } = await server.jazz["inbox.list"]({})
    expect((notifications as Notification[]).some((n) => n.cardID === card.id && n.kind === "done")).toBe(true)
  })

  it("rejects accept from a non-review lane with a typed error", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID().slice(0, 8)}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "in_progress" })
    await expect(server.jazz["review.decide"]({ cardID: card.id, decision: "accept" })).rejects.toThrow(/not_reviewable|lane/)
  })

  it("requeue moves review → triage and notifies", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID().slice(0, 8)}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "review" })
    const decided = await server.jazz["review.decide"]({ cardID: card.id, decision: "requeue" })
    expect(decided.lane).toBe("triage")
    const { notifications } = await server.jazz["inbox.list"]({})
    expect((notifications as Notification[]).some((n) => n.cardID === card.id && n.kind === "requeued")).toBe(true)
  })

  it("cancel works from failed (x) but accept does not", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID().slice(0, 8)}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "failed" })
    await expect(server.jazz["review.decide"]({ cardID: card.id, decision: "accept" })).rejects.toThrow()
    const decided = await server.jazz["review.decide"]({ cardID: card.id, decision: "cancel" })
    expect(decided.lane).toBe("cancelled")
  })

  it("card.comment round-trips into board.get", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID().slice(0, 8)}` })
    const commented = await server.jazz["card.comment"]({ cardID: card.id, author: "laya", body: "routed to qa-core (0.61)" })
    expect(commented.comments).toHaveLength(1)
    const board = await server.jazz["board.get"]({})
    expect((board.cards[card.id] as Card).comments[0]!.body).toContain("qa-core")
  })

  it("routing.log returns an empty but well-shaped log for a fresh card", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID().slice(0, 8)}` })
    const { decisions } = await server.jazz["routing.log"]({ cardID: card.id })
    expect(decisions).toEqual([])
  })
})
