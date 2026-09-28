import { describe, expect, it } from "vitest"

import {
  catchupPlan,
  cronRunRing,
  dueJobs,
  leaseAlive,
  nextRunISO,
  type CronJob,
  type Lease,
} from "../../src/cron"

const T0 = new Date("2026-09-28T10:03:07.000Z")

const job = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "j1",
  name: "daily",
  cronExpr: "0 12 * * *",
  prompt: "do the thing",
  enabled: true,
  nextRun: "2026-09-28T12:00:00.000Z",
  ...overrides,
})

describe("cron math", () => {
  it("computes the next minute boundary with croner", () => {
    expect(nextRunISO("*/5 * * * *", T0)).toBe("2026-09-28T10:05:00.000Z")
  })

  it("computes the next occurrence of a daily expression", () => {
    expect(nextRunISO("0 12 * * *", T0)).toBe("2026-09-28T12:00:00.000Z")
  })

  it("returns null for an invalid expression instead of throwing", () => {
    expect(nextRunISO("not a cron", T0)).toBeNull()
  })
})

describe("dueJobs", () => {
  it("returns only enabled jobs whose nextRun is at or before now", () => {
    const jobs = [
      job({ id: "due", nextRun: "2026-09-28T09:00:00.000Z" }),
      job({ id: "future", nextRun: "2026-09-28T23:00:00.000Z" }),
      job({ id: "disabled", enabled: false, nextRun: "2026-09-28T09:00:00.000Z" }),
      job({ id: "unscheduled", nextRun: undefined }),
    ]
    const ids = dueJobs(jobs, T0).map((j) => j.id)
    expect(ids).toEqual(["due"])
  })
})

describe("catchupPlan", () => {
  const jobs = [
    job({ id: "past-1", nextRun: "2026-09-28T08:00:00.000Z" }),
    job({ id: "past-2", nextRun: "2026-09-28T09:30:00.000Z" }),
    job({ id: "future", nextRun: "2026-09-28T23:00:00.000Z" }),
  ]

  it("fire-missed: every past-due job fires exactly once and is rescheduled", () => {
    const plan = catchupPlan(jobs, T0, "fire-missed")
    expect(plan.fire.map((j) => j.id)).toEqual(["past-1", "past-2"])
    const rescheduled = plan.jobs.find((j) => j.id === "past-1")!
    expect(new Date(rescheduled.nextRun!).getTime()).toBeGreaterThan(T0.getTime())
    const untouched = plan.jobs.find((j) => j.id === "future")!
    expect(untouched.nextRun).toBe("2026-09-28T23:00:00.000Z")
  })

  it("skip-missed: nothing fires, but past-due jobs are still rescheduled", () => {
    const plan = catchupPlan(jobs, T0, "skip-missed")
    expect(plan.fire).toEqual([])
    const rescheduled = plan.jobs.find((j) => j.id === "past-2")!
    expect(new Date(rescheduled.nextRun!).getTime()).toBeGreaterThan(T0.getTime())
  })
})

describe("cronRunRing", () => {
  it("caps the run log at 100, dropping the oldest", () => {
    let runs: unknown[] = []
    for (let i = 0; i < 101; i++) {
      runs = cronRunRing(runs, { seq: i })
    }
    expect(runs).toHaveLength(100)
    expect(runs[0]).toEqual({ seq: 1 })
    expect(runs[99]).toEqual({ seq: 100 })
  })
})

describe("leaseAlive", () => {
  const lease: Lease = { instanceID: "abc", expiresAt: 1000 }

  it("is alive when the instance matches and the lease is unexpired", () => {
    expect(leaseAlive(lease, "abc", 999)).toBe(true)
  })

  it("is dead when expired, when the instance differs, or when absent", () => {
    expect(leaseAlive(lease, "abc", 1000)).toBe(false)
    expect(leaseAlive(lease, "other", 500)).toBe(false)
    expect(leaseAlive(undefined, "abc", 500)).toBe(false)
  })
})
