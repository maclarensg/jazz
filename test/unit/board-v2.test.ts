import { describe, expect, it } from "vitest"
import {
  addComment,
  assignProfile,
  BoardError,
  createBoard,
  createCard,
  DEFAULT_LANES,
  endAssignment,
  HISTORY_CAP,
  migrateBoard,
  moveCard,
  startAssignment,
  type BoardState,
} from "../../src/board"

describe("board v2 — lanes", () => {
  it("defaults to the nine v2 lanes in canonical order", () => {
    const b = createBoard()
    expect(Object.keys(b.lanes)).toEqual([
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

  it("creates cards in triage by default (intake lane)", () => {
    const { board: b, card } = createCard(createBoard(), { title: "intake-nonce-7" }, () => "c1")
    expect(card.lane).toBe("triage")
    expect(b.lanes["triage"]).toEqual(["c1"])
  })
})

describe("board v2 — card fields", () => {
  it("creates a card with priority, source, details, and a created history entry", () => {
    const { card } = createCard(
      createBoard(),
      { title: "t", priority: 0, details: "d", source: "cron" },
      () => "c1",
    )
    expect(card.priority).toBe(0)
    expect(card.source).toBe("cron")
    expect(card.details).toBe("d")
    expect(card.assignments).toEqual([])
    expect(card.comments).toEqual([])
    expect(card.history).toEqual([expect.objectContaining({ kind: "created", ts: card.created })])
  })

  it("defaults priority to 2 and source to manual", () => {
    const { card } = createCard(createBoard(), { title: "t" }, () => "c1")
    expect(card.priority).toBe(2)
    expect(card.source).toBe("manual")
  })

  it("rejects priority outside 0..3", () => {
    expect(() => createCard(createBoard(), { title: "t", priority: 4 as never }, () => "c1")).toThrowError(/priority/i)
    expect(() => createCard(createBoard(), { title: "t", priority: -1 as never }, () => "c1")).toThrowError(/priority/i)
  })

  it("rejects unknown source values", () => {
    expect(() => createCard(createBoard(), { title: "t", source: "nope" as never }, () => "c1")).toThrowError(/source/i)
  })
})

describe("board v2 — history", () => {
  it("moveCard appends a moved entry with from/to lanes and actor", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = moveCard(b, "c1", "ready", undefined, { actor: "laya" })
    const last = b.cards["c1"]!.history.at(-1)!
    expect(last.kind).toBe("moved")
    expect(last.actor).toBe("laya")
    expect(last.from).toBe("triage")
    expect(last.to).toBe("ready")
  })

  it("defaults the move actor to system", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = moveCard(b, "c1", "ready")
    expect(b.cards["c1"]!.history.at(-1)!.actor).toBe("system")
  })

  it("caps history at HISTORY_CAP entries, dropping oldest", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      b = addComment(b, "c1", { author: "bot", body: `note ${i}` }, () => `m${i}`).board
    }
    const history = b.cards["c1"]!.history
    expect(history).toHaveLength(HISTORY_CAP)
    // 206 entries total (created + 205 notes) → 6 dropped → oldest survivor is note 5
    expect(history[0]!.kind).toBe("comment")
    expect(history[0]!.detail).toContain("note 5")
  })
})

describe("board v2 — comments", () => {
  it("adds a comment and records it in history", () => {
    const b = createCard(createBoard(), { title: "t" }, () => "c1").board
    const { board: b2, comment } = addComment(b, "c1", { author: "swe-1", body: "repro found" }, () => "m1")
    expect(comment).toMatchObject({ id: "m1", author: "swe-1", body: "repro found" })
    expect(b2.cards["c1"]!.comments).toEqual([comment])
    expect(b2.cards["c1"]!.history.at(-1)).toMatchObject({ kind: "comment", actor: "swe-1" })
  })

  it("rejects blank bodies", () => {
    const b = createCard(createBoard(), { title: "t" }, () => "c1").board
    expect(() => addComment(b, "c1", { author: "a", body: "" })).toThrowError(/body/i)
    expect(() => addComment(b, "c1", { author: "a", body: "   " })).toThrowError(/body/i)
  })

  it("throws typed errors for unknown cards", () => {
    expect(() => addComment(createBoard(), "nope", { author: "a", body: "x" })).toThrowError(BoardError)
  })
})

describe("board v2 — assignments", () => {
  it("startAssignment sets the card profile and opens an assignment", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = startAssignment(b, "c1", "swe-backend", { sessionID: "s-1", actor: "laya" })
    const card = b.cards["c1"]!
    expect(card.profile).toBe("swe-backend")
    expect(card.assignments).toEqual([
      expect.objectContaining({ profile: "swe-backend", sessionID: "s-1", startedAt: expect.any(String) }),
    ])
    expect(card.assignments[0]!.endedAt).toBeUndefined()
    expect(card.history.at(-1)).toMatchObject({ kind: "assigned", actor: "laya", detail: "swe-backend" })
  })

  it("refuses a second concurrent assignment", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = startAssignment(b, "c1", "swe-backend", { actor: "laya" })
    expect(() => startAssignment(b, "c1", "qa-core", { actor: "laya" })).toThrowError(/open assignment/i)
  })

  it("endAssignment closes the open assignment and the chain accumulates", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = startAssignment(b, "c1", "swe-backend", { actor: "laya" })
    b = endAssignment(b, "c1", "handoff", { actor: "swe-backend" })
    b = startAssignment(b, "c1", "qa-core", { actor: "laya" })
    b = endAssignment(b, "c1", "submitted", { actor: "qa-core" })
    const card = b.cards["c1"]!
    expect(card.profile).toBe("qa-core")
    expect(card.assignments.map((a) => a.outcome)).toEqual(["handoff", "submitted"])
    expect(card.assignments.every((a) => a.endedAt)).toBe(true)
  })

  it("endAssignment without an open assignment throws", () => {
    const b = createCard(createBoard(), { title: "t" }, () => "c1").board
    expect(() => endAssignment(b, "c1", "exited")).toThrowError(/no open assignment/i)
  })
})

describe("board v2 — assignProfile", () => {
  it("sets the next profile with a routed history entry and optional priority", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = assignProfile(b, "c1", "qa-core", { actor: "laya", priority: 1 })
    const card = b.cards["c1"]!
    expect(card.profile).toBe("qa-core")
    expect(card.priority).toBe(1)
    expect(card.history.at(-1)).toMatchObject({ kind: "routed", actor: "laya", detail: "qa-core" })
    expect(card.assignments).toEqual([]) // assignment opens when a session starts
  })

  it("throws on unknown card", () => {
    expect(() => assignProfile(createBoard(), "nope", "x")).toThrowError(BoardError)
  })

  it("refuses to route a card with an open assignment — no concurrent routing over a live worker", () => {
    // live incident 2026-10-03T08:39:10Z: a sweep routed sre-devops over card
    // fc0a2fb6 while tooling-engineer's session had the assignment open
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = startAssignment(b, "c1", "tooling-engineer", { sessionID: "s-1", actor: "laya" })
    b = moveCard(b, "c1", "in_progress")
    expect(() => assignProfile(b, "c1", "sre-devops", { actor: "sweep" })).toThrowError(BoardError)
    expect(() => assignProfile(b, "c1", "sre-devops", { actor: "sweep" })).toThrowError(/open assignment/i)
    expect(b.cards["c1"]!.profile).toBe("tooling-engineer")
    expect(b.cards["c1"]!.history.at(-1)!.kind).not.toBe("routed")
  })

  it("refuses to route cards outside triage/ready", () => {
    const b = createCard(createBoard(), { title: "t" }, () => "c1").board
    for (const lane of ["backlog", "in_progress", "blocked", "review", "done", "cancelled", "failed"]) {
      const moved = moveCard(b, "c1", lane)
      expect(() => assignProfile(moved, "c1", "sre-devops", { actor: "sweep" })).toThrowError(/triage\/ready|lane/i)
    }
  })

  it("routes in triage and ready — the legal routing lanes", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = assignProfile(b, "c1", "swe-backend") // triage
    expect(b.cards["c1"]!.profile).toBe("swe-backend")
    b = moveCard(b, "c1", "ready")
    b = assignProfile(b, "c1", "qa-core", { priority: 1 }) // ready
    expect(b.cards["c1"]!.profile).toBe("qa-core")
  })

  it("routes again once the assignment has ended (handoff closes, then routing proceeds)", () => {
    let b = createCard(createBoard(), { title: "t" }, () => "c1").board
    b = startAssignment(b, "c1", "tooling-engineer", { actor: "laya" })
    b = moveCard(b, "c1", "in_progress")
    b = endAssignment(b, "c1", "handoff", { actor: "tooling-engineer" })
    b = moveCard(b, "c1", "ready")
    expect(() => assignProfile(b, "c1", "qa-core", { actor: "system" })).not.toThrow()
  })
})

describe("board v2 — migration from v1", () => {
  const v1Board = (): BoardState =>
    ({
      cards: {
        a: { id: "a", title: "old work", lane: "backlog", created: "2026-09-28T10:00:00.000Z", updated: "2026-09-29T11:00:00.000Z" },
        d: { id: "d", title: "shipped", lane: "done", created: "2026-09-28T10:00:00.000Z", updated: "2026-09-29T11:00:00.000Z" },
      },
      lanes: { backlog: ["a"], ready: [], in_progress: [], blocked: [], done: ["d"] },
    }) as unknown as BoardState

  it("adds missing v2 lanes in canonical order, preserving card placement", () => {
    const b = migrateBoard(v1Board())
    expect(Object.keys(b.lanes)).toEqual([...DEFAULT_LANES])
    expect(b.lanes["backlog"]).toEqual(["a"])
    expect(b.lanes["done"]).toEqual(["d"])
    expect(b.lanes["triage"]).toEqual([])
  })

  it("backfills v2 card fields without touching v1 data", () => {
    const b = migrateBoard(v1Board())
    const a = b.cards["a"]!
    expect(a.title).toBe("old work")
    expect(a.priority).toBe(2)
    expect(a.source).toBe("manual")
    expect(a.assignments).toEqual([])
    expect(a.comments).toEqual([])
    expect(a.history).toEqual([expect.objectContaining({ kind: "created", ts: a.created })])
  })

  it("keeps custom lanes not in the v2 set, appended after the canonical ones", () => {
    const custom = { ...v1Board(), lanes: { ...v1Board().lanes, frozen: [] } } as unknown as BoardState
    const b = migrateBoard(custom)
    expect(Object.keys(b.lanes).slice(0, 9)).toEqual([...DEFAULT_LANES])
    expect(Object.keys(b.lanes).at(-1)).toBe("frozen")
  })

  it("is idempotent", () => {
    const once = migrateBoard(v1Board())
    expect(migrateBoard(once)).toEqual(once)
  })
})
