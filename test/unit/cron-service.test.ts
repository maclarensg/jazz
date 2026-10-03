import { describe, expect, it } from "vitest"

import { createCronService } from "../../src/cron-service"
import { createMemoryStorage } from "../../src/storage"

const T0 = new Date("2026-10-03T10:00:00.000Z")

const service = () =>
  createCronService(createMemoryStorage(), {
    idgen: (() => {
      let n = 0
      return () => `j${++n}`
    })(),
    now: () => T0,
  })

describe("cron service allowNotify", () => {
  it("defaults allowNotify to true so existing behavior is unchanged", async () => {
    const cron = service()
    const job = await cron.upsert({ name: "daily", cronExpr: "0 12 * * *", prompt: "x" })
    expect(job.allowNotify).toBe(true)
  })

  it("stores an explicit allowNotify=false", async () => {
    const cron = service()
    const job = await cron.upsert({ name: "sentinel", cronExpr: "*/1 * * * *", prompt: "x", allowNotify: false })
    expect(job.allowNotify).toBe(false)
    const listed = await cron.list()
    expect(listed.find((j) => j.name === "sentinel")?.allowNotify).toBe(false)
  })

  it("preserves allowNotify across a re-upsert that omits it", async () => {
    const cron = service()
    await cron.upsert({ name: "sentinel", cronExpr: "*/1 * * * *", prompt: "x", allowNotify: false })
    const again = await cron.upsert({ name: "sentinel", cronExpr: "*/5 * * * *", prompt: "y" })
    expect(again.allowNotify).toBe(false)
    expect(again.id).toBe((await cron.list()).find((j) => j.name === "sentinel")?.id)
  })

  it("rejects a stored non-boolean allowNotify", async () => {
    const storage = createMemoryStorage()
    await storage.set("cron/jobs", [
      { id: "j1", name: "bad", cronExpr: "0 12 * * *", prompt: "x", enabled: true, allowNotify: "nope" },
    ])
    const cron = createCronService(storage, { now: () => T0 })
    await expect(cron.list()).rejects.toThrow("boolean")
  })
})
