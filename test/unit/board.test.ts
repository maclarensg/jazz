import { describe, expect, it } from "vitest"
import { BoardError, createBoard, createCard, moveCard, removeCard } from "../../src/board"

const board = () => createBoard(["backlog", "ready", "in_progress", "blocked", "done"])

describe("board", () => {
  it("creates a card in a lane with an id and orders it last", () => {
    const b0 = board()
    const { board: b1, card } = createCard(b0, { title: "nonce-card-1", lane: "ready" }, () => "c1")
    expect(card.title).toBe("nonce-card-1")
    expect(b1.lanes["ready"]).toEqual(["c1"])
    expect(b1.lanes["backlog"]).toEqual([])
  })

  it("creates in triage by default on a default board (v2 changed the default from backlog)", () => {
    const { board: b1 } = createCard(createBoard(), { title: "x" }, () => "c1")
    expect(b1.lanes["triage"]).toEqual(["c1"])
  })

  it("moves a card between lanes and reorders within a lane", () => {
    let b = board()
    b = createCard(b, { title: "a", lane: "backlog" }, () => "c1").board
    b = createCard(b, { title: "b", lane: "ready" }, () => "c2").board
    b = moveCard(b, "c1", "ready", 0)
    expect(b.lanes["ready"]).toEqual(["c1", "c2"])
    expect(b.lanes["backlog"]).toEqual([])
    expect(b.cards["c1"]!.updated >= b.cards["c1"]!.created).toBe(true)
  })

  it("moves a card to the end of a lane when no index is given", () => {
    let b = board()
    b = createCard(b, { title: "a", lane: "backlog" }, () => "c1").board
    b = createCard(b, { title: "b", lane: "backlog" }, () => "c2").board
    b = moveCard(b, "c1", "backlog")
    expect(b.lanes["backlog"]).toEqual(["c2", "c1"])
  })

  it("throws typed errors for unknown card and unknown lane", () => {
    const b = board()
    expect(() => moveCard(b, "nope", "ready")).toThrowError(BoardError)
    expect(() => moveCard(b, "nope", "ready")).toThrowError(/unknown card/i)
    expect(() => createCard(b, { title: "x", lane: "wat" })).toThrowError(/unknown lane/i)
    expect(() => createCard(b, { title: "x", lane: "wat" })).toThrowError(BoardError)
    expect(() => removeCard(b, "nope")).toThrowError(BoardError)
  })

  it("removes a card from lane and index", () => {
    let b = board()
    b = createCard(b, { title: "a", lane: "backlog" }, () => "c1").board
    b = removeCard(b, "c1")
    expect(b.cards["c1"]).toBeUndefined()
    expect(b.lanes["backlog"]).toEqual([])
  })

  it("does not mutate the previous state (immutability contract)", () => {
    const b0 = board()
    const { board: b1 } = createCard(b0, { title: "a", lane: "backlog" }, () => "c1")
    moveCard(b1, "c1", "ready")
    expect(b1.lanes["backlog"]).toEqual(["c1"])
    expect(b1.lanes["ready"]).toEqual([])
    expect(b0.lanes["backlog"]).toEqual([])
  })
})
