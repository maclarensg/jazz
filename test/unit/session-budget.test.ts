import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { budgetKillRecord, createBudgetWatch } from "../../src/session-budget"

/**
 * Session budget watchdog (2026-10-04 burn audit): a cron-fired session that
 * overruns its wall-clock budget must be interrupted and recorded. The
 * trigger: two triage-sweep sessions burned ~910M tokens overnight looping
 * on a missing kanban tool catalog — nothing capped a fired session, and
 * prompt() resolves at accept, so the fire path has no completion signal.
 * Disarm is the event pump's terminal session.execution.* outcome.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createBudgetWatch", () => {
  it("kills an overrunning session exactly once at the budget", async () => {
    const killed: string[] = []
    const watch = createBudgetWatch({
      budgetMs: 1_000,
      kill: async (sessionID) => {
        killed.push(sessionID)
      },
    })

    watch.arm("ses_a")
    await vi.advanceTimersByTimeAsync(999)
    expect(killed).toEqual([]) // inside the budget: untouched

    await vi.advanceTimersByTimeAsync(1)
    expect(killed).toEqual(["ses_a"])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(killed).toEqual(["ses_a"]) // no repeat kills
  })

  it("a terminal outcome before the budget disarms the kill", async () => {
    const killed: string[] = []
    const watch = createBudgetWatch({ budgetMs: 1_000, kill: async (s) => void killed.push(s) })

    watch.arm("ses_a")
    watch.disarm("ses_a") // session.execution.succeeded arrived
    await vi.advanceTimersByTimeAsync(120_000)

    expect(killed).toEqual([])
  })

  it("re-arming replaces the pending timer instead of stacking kills", async () => {
    const killed: string[] = []
    const watch = createBudgetWatch({ budgetMs: 1_000, kill: async (s) => void killed.push(s) })

    watch.arm("ses_a")
    await vi.advanceTimersByTimeAsync(500)
    watch.arm("ses_a") // re-arm (defensive; fires are one-shot today)
    await vi.advanceTimersByTimeAsync(600)

    expect(killed).toEqual([]) // old timer was replaced, not stacked
    await vi.advanceTimersByTimeAsync(400)
    expect(killed).toEqual(["ses_a"])
  })

  it("a rejecting kill is swallowed and onKill still runs", async () => {
    const killed: string[] = []
    const notified: string[] = []
    const watch = createBudgetWatch({
      budgetMs: 1_000,
      kill: async () => {
        throw new Error("interrupt rpc failed")
      },
      onKill: async (s) => {
        killed.push(s)
        notified.push(s)
      },
    })

    watch.arm("ses_a")
    await vi.advanceTimersByTimeAsync(1_000) // kill rejects; must not surface
    await vi.advanceTimersByTimeAsync(0) // flush the swallowed rejection

    expect(notified).toEqual(["ses_a"]) // record still lands
    expect(killed).toEqual(["ses_a"])
  })

  it("disposes every pending timer (server shutdown)", async () => {
    const killed: string[] = []
    const watch = createBudgetWatch({ budgetMs: 1_000, kill: async (s) => void killed.push(s) })

    watch.arm("ses_a")
    watch.arm("ses_b")
    watch.dispose()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(killed).toEqual([])
  })

  it("budgetMs <= 0 disables the watchdog entirely", async () => {
    const killed: string[] = []
    const watch = createBudgetWatch({ budgetMs: 0, kill: async (s) => void killed.push(s) })

    watch.arm("ses_a")
    await vi.advanceTimersByTimeAsync(3_600_000)

    expect(killed).toEqual([])
  })
})

describe("budgetKillRecord", () => {
  it("records an error run bound to the fire's session, with the budget in the message", () => {
    const run = budgetKillRecord({
      jobID: "ad848db6",
      jobName: "triage-sweep",
      sessionID: "ses_x",
      budgetMs: 600_000,
    })
    expect(run.status).toBe("error")
    expect(run.sessionID).toBe("ses_x")
    expect(run.error).toContain("600000ms")
    expect(run.error).toContain("interrupted")
  })
})
