import { describe, expect, it } from "vitest"
import {
  createRoutingLog,
  decisionsFor,
  normalizeRouting,
  recordDecision,
  setOutcome,
  type RoutingDecision,
} from "../../src/routing"

const d = (cardID: string, stage: "domain" | "profile", picked: string, over: Partial<RoutingDecision> = {}): Omit<RoutingDecision, "ts"> => ({
  cardID,
  stage,
  picked,
  ...over,
})

describe("routing log", () => {
  it("records decisions newest-last and lists per card", () => {
    let log = createRoutingLog()
    log = recordDecision(log, d("c1", "domain", "engineering"))
    log = recordDecision(log, d("c1", "profile", "backend-engineer", { confidence: 0.61 }))
    log = recordDecision(log, d("c2", "domain", "qa"))
    expect(decisionsFor(log, "c1")).toHaveLength(2)
    expect(decisionsFor(log, "c1")[1]!.picked).toBe("backend-engineer")
    expect(decisionsFor(log, "c2")).toHaveLength(1)
    expect(decisionsFor(log, "missing")).toEqual([])
  })

  it("setOutcome updates the latest profile-stage decision for a card", () => {
    let log = createRoutingLog()
    log = recordDecision(log, d("c1", "domain", "engineering"))
    log = recordDecision(log, d("c1", "profile", "backend-engineer"))
    log = setOutcome(log, "c1", "accepted")
    expect(decisionsFor(log, "c1")[1]!.outcome).toBe("accepted")
    expect(decisionsFor(log, "c1")[0]!.outcome).toBeUndefined()
  })

  it("setOutcome on a card with no decisions is a no-op", () => {
    const log = createRoutingLog()
    expect(setOutcome(log, "c1", "requeued")).toEqual(log)
  })

  it("normalizeRouting drops malformed entries and accepts unknown docs", () => {
    expect(normalizeRouting(undefined)).toEqual({ decisions: [] })
    const bad = { decisions: [{ cardID: "c1" }, "junk", { cardID: "c2", stage: "profile", picked: "x", ts: "t" }] }
    const log = normalizeRouting(bad)
    expect(log.decisions).toHaveLength(1)
    expect(log.decisions[0]!.cardID).toBe("c2")
  })

  it("caps the log at 500 decisions, keeping newest", () => {
    let log = createRoutingLog()
    for (let i = 0; i < 510; i++) log = recordDecision(log, d(`c${i}`, "domain", `cat-${i}`))
    expect(log.decisions).toHaveLength(500)
    expect(log.decisions[0]!.cardID).toBe("c10")
  })
})
