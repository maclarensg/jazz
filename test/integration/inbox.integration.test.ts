import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startJazzServer, type JazzServer } from "./harness"
import type { Notification } from "../../src/inbox"

let server: JazzServer

beforeAll(async () => {
  server = await startJazzServer()
}, 60_000)

afterAll(async () => {
  await server.close()
})

describe("inbox RPC (real server)", () => {
  it("emits entered_review when a card moves to review, then ack clears it", async () => {
    const title = `nonce-${randomUUID()}`
    const card = await server.jazz["card.create"]({ title })
    await server.jazz["card.move"]({ cardID: card.id, lane: "review" })

    const { notifications, unread } = await server.jazz["inbox.list"]({})
    const mine = (notifications as Notification[]).find((n) => n.cardID === card.id && n.kind === "entered_review")
    expect(mine).toBeDefined()
    expect(mine!.message).toContain(title)
    expect(unread).toBeGreaterThan(0)

    const after = await server.jazz["inbox.ack"]({ id: mine!.id })
    expect(after.unread).toBe(unread - 1)

    const all = await server.jazz["inbox.ackAll"]({})
    expect(all.unread).toBe(0)
  })

  it("lists unread-only when asked", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID()}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "failed" })
    const { notifications } = await server.jazz["inbox.list"]({ unreadOnly: true })
    expect((notifications as Notification[]).some((n) => n.cardID === card.id && n.kind === "failed")).toBe(true)
    expect((notifications as Notification[]).every((n) => !n.read)).toBe(true)
    await server.jazz["inbox.ackAll"]({})
  })

  it("does not notify for non-notable lane moves", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID()}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "backlog" })
    const { notifications } = await server.jazz["inbox.list"]({})
    expect((notifications as Notification[]).some((n) => n.cardID === card.id && n.kind === "requeued")).toBe(false)
  })
})

describe("inbox clear RPC (real server)", () => {
  it("clear removes one notification from the list entirely", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID()}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "failed" })
    const { notifications } = await server.jazz["inbox.list"]({})
    const mine = (notifications as Notification[]).find((n) => n.cardID === card.id && n.kind === "failed")
    expect(mine).toBeDefined()

    const cleared = await server.jazz["inbox.clear"]({ id: mine!.id })
    expect(cleared.cleared).toBe(1)

    const after = await server.jazz["inbox.list"]({})
    expect((after.notifications as Notification[]).some((n) => n.id === mine!.id)).toBe(false)
    await server.jazz["inbox.clearAll"]({})
  })

  it("clearAll empties the list and reports how many went", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID()}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "failed" })
    const { notifications } = await server.jazz["inbox.list"]({})
    expect(notifications.length).toBeGreaterThan(0)

    const r = await server.jazz["inbox.clearAll"]({})
    expect(r.cleared).toBe(notifications.length)
    expect(r.unread).toBe(0)
    const after = await server.jazz["inbox.list"]({})
    expect(after.notifications).toHaveLength(0)
  })
})
