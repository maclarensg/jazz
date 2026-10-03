import { describe, expect, it } from "vitest"

import { createBoard, createCard, moveCard } from "../../src/board"
import { EXIT_NO_SUBMIT, createLinkRegistry, canSubmitReview, planOutcome, transitionLane } from "../../src/link"

const card = (lane: string) => ({
  id: "c1",
  title: "t",
  lane,
  created: "t0",
  updated: "t0",
  priority: 2 as const,
  assignments: [],
  comments: [],
  history: [],
  source: "manual" as const,
})

describe("transitionLane", () => {
  it("maps outcomes to lanes (v2: success without submit is not done; failures go to failed)", () => {
    expect(transitionLane(card("ready"), "started")).toBe("in_progress")
    expect(transitionLane(card("in_progress"), "succeeded")).toBe("ready")
    expect(transitionLane(card("in_progress"), "failed")).toBe("failed")
    expect(transitionLane(card("in_progress"), "interrupted")).toBe("failed")
  })

  it("returns null when the card is already in the target lane", () => {
    expect(transitionLane(card("in_progress"), "started")).toBeNull()
    expect(transitionLane(card("ready"), "succeeded")).toBeNull()
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

    const lane = transitionLane(board.cards["c1"]!, "failed")
    expect(lane).toBe("failed")
    board = moveCard(board, "c1", lane!)
    expect(board.lanes["failed"]).toEqual(["c1"])
    expect(board.lanes["backlog"]).toEqual(["c2"])
  })
})

describe("planOutcome (assignment-closure rules for the event pump)", () => {
  const withAssignment = (lane: string) => ({
    ...card(lane),
    assignments: [{ profile: "debugger", startedAt: "t0", sessionID: "s-1" }],
  })

  it("a live session failing closes the assignment — card 6787f497 leak: session failed 1s in, pump moved to failed with the row open", () => {
    const plan = planOutcome(withAssignment("in_progress"), "failed")
    expect(plan.target).toBe("failed")
    expect(plan.close).toEqual({ outcome: "failed", detail: "worker session failed" })
    expect(plan.comment).toBeNull()
  })

  it("interrupted closes like failed", () => {
    const plan = planOutcome(withAssignment("in_progress"), "interrupted")
    expect(plan.target).toBe("failed")
    expect(plan.close).toEqual({ outcome: "failed", detail: "worker session interrupted" })
  })

  it("succeeded without submit closes the assignment as the no-submit bail-out", () => {
    const plan = planOutcome(withAssignment("in_progress"), "succeeded")
    expect(plan.target).toBe("ready")
    expect(plan.close).toEqual({ outcome: "exited", detail: EXIT_NO_SUBMIT })
    expect(plan.comment).toBe("Worker session ended without submitting for review.")
  })

  it("cards Gavin owns (moved on while the session was live) are left to the moveCard auto-close guard", () => {
    // 6787f497 rode failed→ready→done while its dead session's row stayed
    // open; the pump must not touch Gavin's lanes — NO_WORKER_LANES entry
    // closes the row instead.
    for (const lane of ["review", "done", "cancelled", "failed"]) {
      expect(planOutcome(withAssignment(lane), "failed")).toEqual({ close: null, comment: null, target: null })
      expect(planOutcome(withAssignment(lane), "succeeded")).toEqual({ close: null, comment: null, target: null })
    }
  })

  it("no open assignment — nothing to close, no phantom exits", () => {
    for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
      expect(planOutcome(card("in_progress"), outcome).close).toBeNull()
    }
  })

  it("started never closes anything", () => {
    expect(planOutcome(withAssignment("ready"), "started")).toEqual({ close: null, comment: null, target: "in_progress" })
  })
})

describe("canSubmitReview (card 592b2b2c: cron monitor submit)", () => {
  const submittable = (lane: string, source: "manual" | "cron" | "session" | "requeue") => ({
    lane,
    source,
  })

  it("workers submit from in_progress regardless of source", () => {
    expect(canSubmitReview(submittable("in_progress", "manual"))).toBe(true)
    expect(canSubmitReview(submittable("in_progress", "cron"))).toBe(true)
    expect(canSubmitReview(submittable("in_progress", "session"))).toBe(true)
  })

  it("cron monitor cards submit straight from ready — an actionable signal is the deliverable", () => {
    expect(canSubmitReview(submittable("ready", "cron"))).toBe(true)
  })

  it("everything else is worker-only: no ready submit for non-cron sources, none from triage/backlog", () => {
    expect(canSubmitReview(submittable("ready", "manual"))).toBe(false)
    expect(canSubmitReview(submittable("ready", "session"))).toBe(false)
    expect(canSubmitReview(submittable("ready", "requeue"))).toBe(false)
    expect(canSubmitReview(submittable("triage", "cron"))).toBe(false)
    expect(canSubmitReview(submittable("backlog", "cron"))).toBe(false)
  })

  it("review and terminal lanes are never submittable — that is Gavin's gate", () => {
    expect(canSubmitReview(submittable("review", "cron"))).toBe(false)
    expect(canSubmitReview(submittable("done", "cron"))).toBe(false)
    expect(canSubmitReview(submittable("failed", "cron"))).toBe(false)
  })
})
