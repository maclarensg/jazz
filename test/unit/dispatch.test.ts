import { describe, expect, it } from "vitest"
import { createCard, createBoard, moveCard, type BoardState } from "../../src/board"
import { createDispatchState, DEFAULT_DISPATCH, dispatchableCards, recordAttempt, type DispatchState } from "../../src/dispatch"

const NOW = new Date("2026-10-02T12:00:00.000Z")
const iso = (offsetMin: number) => new Date(NOW.getTime() - offsetMin * 60_000).toISOString()

function boardWith(...defs: { title: string; lane: string; priority?: 0 | 1 | 2 | 3; openAssignment?: boolean; created?: string }[]): BoardState {
  let b = createBoard()
  let n = 0
  for (const d of defs) {
    n += 1
    const id = `c${n}`
    const r = createCard(b, { title: d.title, lane: d.lane, priority: d.priority }, () => id)
    b = r.board
    b = { ...b, cards: { ...b.cards, [id]: { ...b.cards[id]!, created: d.created ?? b.cards[id]!.created } } }
    if (d.openAssignment) {
      b = {
        ...b,
        cards: {
          ...b.cards,
          [id]: {
            ...b.cards[id]!,
            assignments: [{ profile: "swe", startedAt: iso(5) }],
          },
        },
      }
    }
  }
  return b
}

describe("dispatch planner", () => {
  it("picks ready-lane cards with no open assignment", () => {
    const b = boardWith({ title: "a", lane: "ready" }, { title: "b", lane: "triage" }, { title: "c", lane: "in_progress" })
    const picks = dispatchableCards(b, createDispatchState(), DEFAULT_DISPATCH, NOW)
    expect(picks.map((c) => c.title)).toEqual(["a"])
  })

  it("skips cards with an open worker assignment even in ready", () => {
    const b = boardWith({ title: "busy", lane: "ready", openAssignment: true }, { title: "free", lane: "ready" })
    const picks = dispatchableCards(b, createDispatchState(), DEFAULT_DISPATCH, NOW)
    expect(picks.map((c) => c.title)).toEqual(["free"])
  })

  it("respects the per-card cooldown", () => {
    const b = boardWith({ title: "a", lane: "ready" })
    let state: DispatchState = createDispatchState()
    state = recordAttempt(state, "c1", iso(0.5)) // attempted 30s ago, cooldown 60s
    expect(dispatchableCards(b, state, DEFAULT_DISPATCH, NOW)).toEqual([])
    const old: DispatchState = { lastAttempt: { c1: iso(5) }, inFlight: [] } // 5 min ago
    expect(dispatchableCards(b, old, DEFAULT_DISPATCH, NOW).map((c) => c.title)).toEqual(["a"])
  })

  it("caps concurrent dispatches at maxInFlight counting open assignments as in-flight", () => {
    const b = boardWith(
      { title: "w1", lane: "in_progress", openAssignment: true },
      { title: "w2", lane: "in_progress", openAssignment: true },
      { title: "w3", lane: "in_progress", openAssignment: true },
      { title: "queued", lane: "ready" },
    )
    const cfg = { ...DEFAULT_DISPATCH, maxInFlight: 3 }
    expect(dispatchableCards(b, createDispatchState(), cfg, NOW)).toEqual([])
    const cfg2 = { ...DEFAULT_DISPATCH, maxInFlight: 4 }
    expect(dispatchableCards(b, createDispatchState(), cfg2, NOW).map((c) => c.title)).toEqual(["queued"])
  })

  it("orders picks by priority then age (oldest first within a priority)", () => {
    const b = boardWith(
      { title: "p2-old", lane: "ready", priority: 2, created: "2026-10-01T00:00:00.000Z" },
      { title: "p1-new", lane: "ready", priority: 1, created: "2026-10-02T00:00:00.000Z" },
      { title: "p2-new", lane: "ready", priority: 2, created: "2026-10-02T06:00:00.000Z" },
    )
    const picks = dispatchableCards(b, createDispatchState(), DEFAULT_DISPATCH, NOW)
    expect(picks.map((c) => c.title)).toEqual(["p1-new", "p2-old", "p2-new"])
  })

  it("respects maxInFlight slots against its own inFlight list", () => {
    const b = boardWith({ title: "a", lane: "ready" }, { title: "b", lane: "ready" })
    const state: DispatchState = { lastAttempt: {}, inFlight: ["cX", "cY", "cZ"] }
    const cfg = { ...DEFAULT_DISPATCH, maxInFlight: 3 }
    expect(dispatchableCards(b, state, cfg, NOW)).toEqual([])
    expect(dispatchableCards(b, { lastAttempt: {}, inFlight: ["cX"] }, cfg, NOW).map((c) => c.title)).toEqual(["a", "b"])
  })

  it("disabled config dispatches nothing", () => {
    const b = boardWith({ title: "a", lane: "ready" })
    expect(dispatchableCards(b, createDispatchState(), { ...DEFAULT_DISPATCH, enabled: false }, NOW)).toEqual([])
  })

  it("empty ready lane is a no-op", () => {
    expect(dispatchableCards(createBoard(), createDispatchState(), DEFAULT_DISPATCH, NOW)).toEqual([])
  })
})
