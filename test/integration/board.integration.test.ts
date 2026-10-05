import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { randomUUID } from "node:crypto"
import { startJazzServer, type JazzServer } from "./harness"

vi.setConfig({ testTimeout: 90_000 })

let server: JazzServer

beforeAll(async () => {
  server = await startJazzServer()
})

afterAll(async () => {
  await server?.close()
})

describe("board over a real serve", () => {
  it("returns all nine lanes before any cards or cron jobs exist", async () => {
    const board = await server.jazz["board.get"]({})
    expect(board.cards).toEqual({})
    expect(board.lanes).toEqual({
      triage: [],
      backlog: [],
      ready: [],
      in_progress: [],
      blocked: [],
      failed: [],
      review: [],
      done: [],
      cancelled: [],
    })
    expect(await server.jazz["cron.list"]({})).toEqual({ jobs: [] })
  })

  it("round-trips a nonce card through create + board.get", async () => {
    const title = `nonce-${randomUUID()}`
    const card = await server.jazz["card.create"]({ title })
    expect(card.title).toBe(title)

    const board = await server.jazz["board.get"]({})
    const cards = Object.values(board.cards) as { id: string; title: string; lane: string }[]
    const matches = cards.filter((c) => c.title === title)
    expect(matches).toHaveLength(1)
    // v2: intake lane is triage (was backlog in v1)
    expect(matches[0]!.lane).toBe("triage")
    expect(board.lanes["triage"]).toContain(card.id)
    // v2: fresh board carries the nine canonical lanes, in order
    expect(Object.keys(board.lanes)).toEqual([
      "triage",
      "backlog",
      "ready",
      "in_progress",
      "blocked",
      "failed",
      "review",
      "done",
      "cancelled",
    ])
  })

  it("moves a card and reflects it in board.get", async () => {
    const title = `nonce-${randomUUID()}`
    const card = await server.jazz["card.create"]({ title })
    const moved = await server.jazz["card.move"]({ cardID: card.id, lane: "ready" })
    expect(moved.lane).toBe("ready")

    const board = await server.jazz["board.get"]({})
    expect(board.cards[card.id]!.lane).toBe("ready")
    expect(board.lanes["ready"]).toContain(card.id)
    expect(board.lanes["backlog"]).not.toContain(card.id)
  })

  it("emits card.moved on lane change", async () => {
    const seen: { cardID: string; fromLane: string; toLane: string }[] = []
    const off = server.jazz.events.on("card.moved", (e: { data: { cardID: string; fromLane: string; toLane: string } }) => {
      seen.push({ cardID: e.data.cardID, fromLane: e.data.fromLane, toLane: e.data.toLane })
    })
    try {
      const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID()}` })
      await server.jazz["card.move"]({ cardID: card.id, lane: "in_progress" })
      await vi.waitFor(() => {
        expect(seen.some((e) => e.cardID === card.id && e.fromLane === "triage" && e.toLane === "in_progress")).toBe(true)
      })
    } finally {
      off()
    }
  })

  it("rejects moving an unknown card with a typed error", async () => {
    await expect(server.jazz["card.move"]({ cardID: "no-such-card", lane: "ready" })).rejects.toThrow()
  })

  it("removes a card", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID()}` })
    await server.jazz["card.remove"]({ cardID: card.id })
    const board = await server.jazz["board.get"]({})
    expect(board.cards[card.id]).toBeUndefined()
  })
})

describe("archive RPC (real server)", () => {
  it("archives a done lane into the separate archive store", async () => {
    const card = await server.jazz["card.create"]({ title: `nonce-${randomUUID()}` })
    await server.jazz["card.move"]({ cardID: card.id, lane: "done" })

    const r = await server.jazz["board.archiveLane"]({ lane: "done", actor: "gavin" })
    expect(r.archived).toBeGreaterThanOrEqual(1)
    expect(r.archiveTotal).toBeGreaterThanOrEqual(r.archived)

    const board = await server.jazz["board.get"]({})
    expect(board.cards[card.id]).toBeUndefined()
    expect(board.lanes.done).toEqual([])

    const archive = await server.jazz["archive.get"]({})
    const mine = archive.cards.find((c: { id: string }) => c.id === card.id)
    expect(mine).toBeDefined()
    expect(mine!.archivedAt).toBeTruthy()
    expect(mine!.history.at(-1)?.detail).toContain("archived from done")
  })

  it("refuses to archive a non-terminal lane with not_archivable", async () => {
    await server.jazz["card.create"]({ title: `nonce-${randomUUID()}` })
    const r = await server.jazz["board.archiveLane"]({ lane: "triage" }).catch((e: unknown) => e)
    expect(JSON.stringify(r)).toContain("not_archivable")
  })
})
