import { describe, expect, it, vi } from "vitest"

import { makeFireJob, type FireJobIO } from "../../src/cron-fire"
import type { CronJob } from "../../src/cron"

/** Fake I/O mirroring the plugin wiring: every seam is observable. */
const io = (): FireJobIO & {
  switched: string[]
  prompted: { sessionID: string; text: string }[]
  notifications: { kind: string; jobID: string }[]
  runs: unknown[]
} => {
  const state = {
    switched: [] as string[],
    prompted: [] as { sessionID: string; text: string }[],
    notifications: [] as { kind: string; jobID: string }[],
    runs: [] as unknown[],
  }
  const io: FireJobIO = {
    createSession: async (title) => ({ id: `ses_${title.replace(/\s+/g, "-")}` }),
    switchAgent: async (sessionID, agent) => {
      state.switched.push(`${sessionID}:${agent}`)
    },
    prompt: async (sessionID, text) => {
      state.prompted.push({ sessionID, text })
    },
    runtimeAgentIds: async () => ["swe", "qa"],
    appendRun: async (run) => {
      state.runs.push(run)
    },
    notify: async (n) => {
      state.notifications.push({ kind: n.kind, jobID: n.jobID })
    },
  }
  return Object.assign(io, state)
}

const job = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "j1",
  name: "nightly",
  cronExpr: "0 3 * * *",
  prompt: "do the thing",
  enabled: true,
  ...overrides,
})

describe("fireJob agent resolution (card fc0a2fb6)", () => {
  it("never switchAgents an unresolvable job.agent — the session degrades to the default agent with a run note", async () => {
    const f = io()
    const fire = makeFireJob(f)
    const run = await fire(job({ agent: "ghost-persona" }), false)

    expect(f.switched).toEqual([]) // the load-bearing invariant: no dead fired session
    expect(f.prompted).toHaveLength(1) // prompt still runs, on the default agent
    expect(run.status).toBe("fired")
    expect(run.sessionID).toBeDefined()
    expect(run.note).toContain("ghost-persona")
    expect(run.note).toContain("default agent")
  })

  it("switches to an exact-match runtime agent with no note (unchanged behavior)", async () => {
    const f = io()
    const fire = makeFireJob(f)
    const run = await fire(job({ agent: "swe" }), false)

    expect(f.switched).toEqual([`ses_jazz:nightly:swe`])
    expect(run.note).toBeUndefined()
    expect(run.status).toBe("fired")
  })

  it("treats an absent job.agent exactly as before: no switch, no note", async () => {
    const f = io()
    const fire = makeFireJob(f)
    const run = await fire(job(), false)

    expect(f.switched).toEqual([])
    expect(run.note).toBeUndefined()
    expect(f.prompted).toHaveLength(1)
  })

  it("still fires prompt-only when the agent list drifted between resolution and switch", async () => {
    const f = io()
    f.switchAgent = vi.fn().mockRejectedValue(new Error("agent vanished"))
    const fire = makeFireJob(f)
    const run = await fire(job({ agent: "swe" }), false)

    expect(run.status).toBe("fired")
    expect(f.prompted).toHaveLength(1)
    expect(f.notifications.map((n) => n.kind)).toEqual(["fired"])
  })

  it("preserves the fallback note on the run record even when the prompt then fails", async () => {
    const f = io()
    f.prompt = vi.fn().mockRejectedValue(new Error("model exploded"))
    const fire = makeFireJob(f)
    const run = await fire(job({ agent: "ghost-persona" }), false)

    expect(run.status).toBe("error")
    expect(run.error).toContain("model exploded")
    expect(run.note).toContain("ghost-persona")
    // failures always notify, even when allowNotify would mute a fired run
    expect(f.notifications.map((n) => n.kind)).toEqual(["failed"])
  })

  it("keeps the allowNotify contract: muted fired run, failed run still notifies", async () => {
    const muted = io()
    const fireMuted = makeFireJob(muted)
    await fireMuted(job({ allowNotify: false }), false)
    expect(muted.notifications).toEqual([])

    const failing = io()
    failing.prompt = vi.fn().mockRejectedValue(new Error("boom"))
    const fireFailing = makeFireJob(failing)
    await fireFailing(job({ allowNotify: false }), false)
    expect(failing.notifications.map((n) => n.kind)).toEqual(["failed"])
  })

  it("marks catch-up fires with missed=true in the run record", async () => {
    const f = io()
    const fire = makeFireJob(f)
    const run = await fire(job(), true)

    expect(run.missed).toBe(true)
    expect(run.status).toBe("fired")
  })
})

describe("fireJob fire timeout (card 592b2b2c follow-up)", () => {
  it("a stalled fire records one timeout run, notifies, and returns — the tick is never wedged", async () => {
    const f = io()
    f.prompt = () => new Promise(() => {}) // never settles — the 2026-10-02 stall
    const fire = makeFireJob({ ...f, fireTimeoutMs: 20 })
    const run = await fire(job(), false)

    expect(run.status).toBe("error")
    expect(run.error).toContain("fire timeout after 20ms")
    expect(run.error).toContain("may still complete")
    expect(f.runs).toHaveLength(1)
    expect(f.notifications.map((n) => n.kind)).toEqual(["failed"])
  })

  it("the straggler's late completion adds no second run or notification", async () => {
    const f = io()
    let release!: () => void
    f.prompt = () => new Promise<void>((r) => (release = r))
    const fire = makeFireJob({ ...f, fireTimeoutMs: 10 })
    const run = await fire(job(), false)
    expect(run.status).toBe("error")

    release() // the wedged prompt finally settles
    await new Promise((r) => setTimeout(r, 10)) // let the straggler body run out

    expect(f.runs).toHaveLength(1)
    expect(f.notifications.map((n) => n.kind)).toEqual(["failed"])
  })

  it("a fire inside the budget is untouched: fired, one run, fired notification", async () => {
    const f = io()
    const fire = makeFireJob({ ...f, fireTimeoutMs: 5_000 })
    const run = await fire(job(), false)

    expect(run.status).toBe("fired")
    expect(f.runs).toHaveLength(1)
    expect(f.notifications.map((n) => n.kind)).toEqual(["fired"])
  })

  it("no budget configured: legacy semantics, even when the fire never returns", async () => {
    const f = io()
    f.prompt = () => new Promise(() => {})
    const fire = makeFireJob(f) // fireTimeoutMs unset
    const runaway = fire(job(), false)
    const firstSettled = await Promise.race([runaway, Promise.resolve("tick-would-hang")])
    expect(firstSettled).toBe("tick-would-hang")
  })
})
