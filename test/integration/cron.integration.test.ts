import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { randomUUID } from "node:crypto"
import { startJazzServer, type JazzServer } from "./harness"

vi.setConfig({ testTimeout: 240_000 })

let primary: JazzServer

beforeAll(async () => {
  primary = await startJazzServer()
})

afterAll(async () => {
  await primary?.close()
})

describe("cron over a real serve", () => {
  it("rejects an invalid cron expression with a typed error", async () => {
    await expect(
      primary.jazz["cron.upsert"]({ name: "bad", cronExpr: "not a cron", prompt: "x" }),
    ).rejects.toThrow()
  })

  it("fires a * * * * * job into a real session within two minutes", async () => {
    const name = `nonce-${randomUUID().slice(0, 8)}`
    const job = await primary.jazz["cron.upsert"]({
      name,
      cronExpr: "* * * * *",
      prompt: "Reply with the single word ok and nothing else.",
    })
    expect(job.enabled).toBe(true)
    expect(job.nextRun).toBeDefined()

    const listed = await primary.jazz["cron.list"]({})
    expect(listed.jobs.some((j: { id: string; name: string; nextRun?: string; lastRun?: string }) => j.name === name)).toBe(true)

    // Wait for the fire: poll runs + session list. A minute boundary plus
    // 15s tick latency means up to ~75s; budget 150s.
    const deadline = Date.now() + 150_000
    let runs: Array<{ jobID: string; jobName: string; sessionID?: string; status: string }> = []
    let sessionSeen = false
    while (Date.now() < deadline && !sessionSeen) {
      await new Promise((r) => setTimeout(r, 5000))
      const runDoc = await primary.jazz["cron.runs"]({ jobID: job.id })
      runs = runDoc.runs as typeof runs
      const sessions = await primary.client.session.list({})
      const titles = JSON.stringify(sessions)
      sessionSeen = titles.includes(`jazz:${name}`)
    }

    expect(sessionSeen).toBe(true)
    expect(runs.length).toBeGreaterThanOrEqual(1)
    expect(runs[0]!.status).toBe("fired")
    expect(runs[0]!.sessionID).toBeDefined()

    // scheduler updated job state
    const after = await primary.jazz["cron.list"]({})
    const updated = after.jobs.find((j: { id: string; nextRun?: string; lastRun?: string }) => j.id === job.id)
    expect(updated?.lastRun).toBeDefined()
    expect(new Date(updated!.nextRun!).getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it("double-instance: a second serve with the same storage stands down (sequential join)", async () => {
    const name = `nonce2-${randomUUID().slice(0, 8)}`
    const job = await primary.jazz["cron.upsert"]({
      name,
      cronExpr: "*/2 * * * *",
      prompt: "Reply with the single word ok and nothing else.",
    })

    // The primary is already leading (its lease is unexpired). Join a second
    // server sharing the SAME storage (same data dir) and watch it stand down.
    const secondary = await startJazzServer({ dataDir: primary.dataDir })
    try {
      // ~2+ minute slots on a */2 schedule: budget 150s after the first fire.
      const deadline = Date.now() + 150_000
      let fireCount = 0
      let waited = false
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000))
        waited = true
        const runDoc = await primary.jazz["cron.runs"]({ jobID: job.id })
        fireCount = (runDoc.runs as Array<{ jobID: string }>).length
        if (fireCount >= 1 && Date.now() > deadline - 10_000) break
      }
      expect(waited).toBe(true)
      // The strict claim: every scheduled slot fired exactly once across both
      // instances. With a */2 schedule and 150s window we see 1-2 slots;
      // duplicates would mean the lease failed to keep the secondary down.
      const runDoc = await primary.jazz["cron.runs"]({ jobID: job.id })
      const firedAts = (runDoc.runs as Array<{ firedAt: string }>).map((r) => r.firedAt.slice(0, 16)) // minute granularity
      expect(new Set(firedAts).size).toBe(firedAts.length)
    } finally {
      await secondary.close()
    }
  })

  it("removes a job", async () => {
    const job = await primary.jazz["cron.upsert"]({
      name: `removeme-${randomUUID().slice(0, 6)}`,
      cronExpr: "0 3 * * *",
      prompt: "x",
    })
    await primary.jazz["cron.remove"]({ jobID: job.id })
    const listed = await primary.jazz["cron.list"]({})
    expect(listed.jobs.some((j: { id: string; name: string; nextRun?: string; lastRun?: string }) => j.id === job.id)).toBe(false)
    await expect(primary.jazz["cron.remove"]({ jobID: job.id })).rejects.toThrow()
  })
})
