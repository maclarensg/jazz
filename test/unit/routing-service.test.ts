import { describe, expect, it } from "vitest"
import { createMemoryStorage, type JsonStorage } from "../../src/storage"
import { createRoutingService, ROUTING_KEY } from "../../src/routing-service"

/**
 * Regression pins for the live incident on 2026-10-03: the shared service
 * process predated the routing-log code, so kanban.assign never wrote
 * jazz/routing and the calibration loop stamped outcomes onto decisions
 * that did not exist. These tests pin the properties the live system
 * must keep: record() persists to storage (visible to a fresh service
 * instance), and a failing save rejects the caller instead of vanishing
 * into the serialize tail.
 */
describe("routing service", () => {
  it("record() round-trips to storage and is visible to a fresh service instance", async () => {
    const storage = createMemoryStorage()
    const first = createRoutingService(storage)
    const decision = await first.record({
      cardID: "fc0a2fb6",
      stage: "profile",
      picked: "tooling-engineer",
      confidence: 0.71,
      outcome: "assigned",
    })
    expect(decision.picked).toBe("tooling-engineer")

    const raw = (await storage.get(ROUTING_KEY)) as { decisions: Array<{ picked: string }> }
    expect(raw.decisions).toHaveLength(1)
    expect(raw.decisions[0]!.picked).toBe("tooling-engineer")

    const second = createRoutingService(storage)
    const listed = await second.list("fc0a2fb6")
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ stage: "profile", picked: "tooling-engineer", outcome: "assigned" })
  })

  it("setOutcome survives the storage round-trip", async () => {
    const storage = createMemoryStorage()
    const writer = createRoutingService(storage)
    await writer.record({ cardID: "c1", stage: "domain", picked: "engineering" })
    await writer.record({ cardID: "c1", stage: "profile", picked: "swe-backend", outcome: "assigned" })
    await writer.setOutcome("c1", "accepted")

    const reader = createRoutingService(storage)
    const decisions = await reader.list("c1")
    expect(decisions).toHaveLength(2)
    expect(decisions[0]!.outcome).toBeUndefined()
    expect(decisions[1]!.outcome).toBe("accepted")
  })

  it("a failing save rejects the record() caller and the serialize tail recovers", async () => {
    const storage = createMemoryStorage()
    let failNextSet = false
    const flaky: JsonStorage = {
      get: (key) => storage.get(key),
      set: async (key, value) => {
        if (failNextSet) {
          failNextSet = false
          throw new Error("storage write failed")
        }
        return storage.set(key, value)
      },
      remove: (key) => storage.remove(key),
    }
    const svc = createRoutingService(flaky)

    failNextSet = true
    await expect(svc.record({ cardID: "c1", stage: "profile", picked: "x", outcome: "assigned" })).rejects.toThrowError(
      /storage write failed/,
    )

    // the swallowed tail must not poison the chain: the next record goes through
    const ok = await svc.record({ cardID: "c1", stage: "profile", picked: "y", outcome: "assigned" })
    expect(ok.picked).toBe("y")
    expect(await svc.list("c1")).toHaveLength(1)
  })
})
