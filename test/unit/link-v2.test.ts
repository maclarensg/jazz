import { describe, expect, it } from "vitest"
import { createCard, createBoard, moveCard, addComment, type BoardState, type Card } from "../../src/board"
import {
  EXIT_NO_SUBMIT,
  noSubmitStreak,
  reviewGuard,
  transitionLane,
  type SessionOutcome,
} from "../../src/link"

const v2 = () => createBoard()

const cardIn = (lane: string, mutate?: (c: Card) => void): Card => {
  const { card } = createCard(v2(), { title: "t" }, () => "c1")
  const withLane: Card = { ...card, lane }
  mutate?.(withLane)
  return withLane
}

describe("transitionLane v2", () => {
  it("started → in_progress", () => {
    expect(transitionLane(cardIn("ready"), "started")).toBe("in_progress")
  })

  it("succeeded on a review-lane card is neutral (already submitted)", () => {
    expect(transitionLane(cardIn("review"), "succeeded")).toBeNull()
  })

  it("succeeded without prior no-submit exit → ready (worker exit is not a verdict)", () => {
    expect(transitionLane(cardIn("in_progress"), "succeeded")).toBe("ready")
  })

  it("succeeded after one prior no-submit exit → failed (second consecutive)", () => {
    const card = cardIn("in_progress", (c) => {
      c.history = [...c.history, { ts: "t1", kind: "exit", actor: "swe-1", detail: EXIT_NO_SUBMIT }]
    })
    expect(transitionLane(card, "succeeded")).toBe("failed")
  })

  it("comments between exits do not break the consecutive streak", () => {
    const card = cardIn("in_progress", (c) => {
      c.history = [
        ...c.history,
        { ts: "t1", kind: "exit", actor: "swe-1", detail: EXIT_NO_SUBMIT },
        { ts: "t2", kind: "comment", actor: "gavin", detail: "hm" },
      ]
    })
    expect(transitionLane(card, "succeeded")).toBe("failed")
  })

  it("an assignment after a no-submit exit resets the streak", () => {
    const card = cardIn("in_progress", (c) => {
      c.history = [
        ...c.history,
        { ts: "t1", kind: "exit", actor: "swe-1", detail: EXIT_NO_SUBMIT },
        { ts: "t2", kind: "assigned", actor: "laya", detail: "qa-core" },
      ]
    })
    expect(transitionLane(card, "succeeded")).toBe("ready")
  })

  it("failed and interrupted → failed lane (new in v2, was blocked)", () => {
    expect(transitionLane(cardIn("in_progress"), "failed")).toBe("failed")
    expect(transitionLane(cardIn("in_progress"), "interrupted")).toBe("failed")
  })

  it("no outcome yanks a card out of review", () => {
    for (const outcome of ["started", "succeeded", "failed", "interrupted"] as SessionOutcome[]) {
      expect(transitionLane(cardIn("review"), outcome)).toBeNull()
    }
  })

  it("terminal lanes are immune to session outcomes", () => {
    expect(transitionLane(cardIn("done"), "failed")).toBeNull()
    expect(transitionLane(cardIn("cancelled"), "succeeded")).toBeNull()
  })
})

describe("noSubmitStreak", () => {
  it("counts trailing no-submit exits, skipping comments", () => {
    const card = cardIn("in_progress", (c) => {
      c.history = [
        ...c.history,
        { ts: "t1", kind: "exit", actor: "a", detail: EXIT_NO_SUBMIT },
        { ts: "t2", kind: "comment", actor: "b", detail: "x" },
        { ts: "t3", kind: "exit", actor: "a", detail: EXIT_NO_SUBMIT },
      ]
    })
    expect(noSubmitStreak(card)).toBe(2)
  })

  it("stops at the first non-exit lifecycle entry", () => {
    const card = cardIn("in_progress", (c) => {
      c.history = [
        ...c.history,
        { ts: "t1", kind: "exit", actor: "a", detail: EXIT_NO_SUBMIT },
        { ts: "t2", kind: "moved", actor: "system", from: "ready", to: "in_progress" },
        { ts: "t3", kind: "exit", actor: "a", detail: EXIT_NO_SUBMIT },
      ]
    })
    expect(noSubmitStreak(card)).toBe(1)
  })

  it("other exit details do not count", () => {
    const card = cardIn("in_progress", (c) => {
      c.history = [...c.history, { ts: "t1", kind: "exit", actor: "a", detail: "swe-1: handoff" }]
    })
    expect(noSubmitStreak(card)).toBe(0)
  })
})

describe("reviewGuard", () => {
  it("allows agent transitions only from work lanes, never review/terminal", () => {
    expect(reviewGuard("in_progress")).toBe(true)
    expect(reviewGuard("ready")).toBe(true)
    expect(reviewGuard("review")).toBe(false)
    expect(reviewGuard("done")).toBe(false)
    expect(reviewGuard("cancelled")).toBe(false)
    expect(reviewGuard("failed")).toBe(false)
  })
})

// keep board imports honest (used by link flows in production code paths)
