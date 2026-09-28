import { describe, expect, it } from "vitest"

import { createBoard, createCard, moveCard } from "../../src/board"
import { createLinkRegistry, transitionLane } from "../../src/link"

const card = (lane: string) => ({ id: "c1", title: "t", lane, created: "t0", updated: "t0" })

describe("transitionLane", () => {
  it("maps outcomes to lanes", () => {
    expect(transitionLane(card("ready"), "started")).toBe("in_progress")
    expect(transitionLane(card("in_progress"), "succeeded")).toBe("done")
    expect(transitionLane(card("in_progress"), "failed")).toBe("blocked")
    expect(transitionLane(card("in_progress"), "interrupted")).toBe("blocked")
  })

  it("returns null when the card is already in the target lane", () => {
    expect(transitionLane(card("in_progress"), "started")).toBeNull()
    expect(transitionLane(card("done"), "succeeded")).toBeNull()
  })
})

describe("linkRegistry", () => {
  it("binds, looks up, and drops session→card links", () => {
    const reg = createLinkRegistry()
    expect(reg.get("s1")).toBeUndefined()
    reg.bind("s1", "c1", 1000)
    expect(reg.get("s1")).toEqual({ cardID: "c1", startedAt: 1000 })
    expect(reg.drop("s1")).toBe(true)
    expect(reg.get("s1")).toBeUndefined()
    expect(reg.drop("s1")).toBe(false)
  })

  it("rebinding a session replaces the link", () => {
    const reg = createLinkRegistry()
    reg.bind("s1", "c1", 1000)
    reg.bind("s1", "c2", 2000)
    expect(reg.get("s1")).toEqual({ cardID: "c2", startedAt: 2000 })
  })

  it("lists all live links", () => {
    const reg = createLinkRegistry()
    reg.bind("s1", "c1", 1000)
    reg.bind("s2", "c2", 2000)
    expect(reg.all().size).toBe(2)
  })
})

describe("outcome application over a board", () => {
  it("moves the linked card and leaves others alone", () => {
    let board = createBoard()
    board = createCard(board, { title: "work me", lane: "ready" }, () => "c1").board
    board = createCard(board, { title: "bystander", lane: "backlog" }, () => "c2").board

    const lane = transitionLane(board.cards["c1"]!, "succeeded")
    expect(lane).toBe("done")
    board = moveCard(board, "c1", lane!)
    expect(board.lanes["done"]).toEqual(["c1"])
    expect(board.lanes["backlog"]).toEqual(["c2"])
  })
})
