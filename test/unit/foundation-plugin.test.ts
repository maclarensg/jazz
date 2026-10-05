import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import Jazz from "../../src/index"
import { createMemoryStorage } from "../../src/storage"

function fixture() {
  const storage = createMemoryStorage()
  const deniedAccess = vi.fn(() => { throw new Error("legacy execution accessed") })
  const handlers: Record<string, (input: unknown, caller: unknown) => Promise<unknown>> = {}
  const tools: Record<string, { execute: (input: unknown, caller: unknown) => Promise<unknown> }> = {}
  const dispose = vi.fn(async () => {})
  const set = vi.spyOn(storage, "set")
  const ctx = {
    options: { factory: { mode: "foundation" } }, storage,
    rpc: { register: vi.fn(async (_definition: unknown, input: typeof handlers) => { Object.assign(handlers, input); return { dispose } }) },
    tool: { transform: vi.fn(async (fn: (editor: { namespace: () => void; add: (tool: { name: string; options: { namespace: string }; execute: (input: unknown, caller: unknown) => Promise<unknown> }) => void }) => void) => {
      fn({ namespace: () => {}, add: (tool) => { tools[`${tool.options.namespace}_${tool.name}`] = tool } })
      return { dispose }
    }) },
    session: new Proxy({}, { get: deniedAccess }), event: new Proxy({}, { get: deniedAccess }),
    agent: new Proxy({}, { get: deniedAccess }),
  }
  const caller = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  return { storage, set, deniedAccess, ctx: ctx as unknown as Plugin.Context, handlers, tools, caller, dispose }
}

describe("foundation entrypoint is nonexecuting and read-only", () => {
  it("branches before legacy timers, event subscriptions, agents, or writes", async () => {
    const f = fixture()
    const cleanup = await Jazz.setup(f.ctx)
    const status = await f.handlers["factory.status"]!({}, f.caller)
    expect(status).toMatchObject({ mode: "foundation", executionEnabled: false, writesEnabled: false, humanVerdictsEnabled: false })
    expect(f.deniedAccess).not.toHaveBeenCalled()
    expect(f.set).not.toHaveBeenCalled()
    await cleanup?.()
    expect(f.dispose).toHaveBeenCalledTimes(2)
  })

  it("denies every mutating RPC before lookup or partial mutation, not just final moves", async () => {
    const f = fixture()
    const cleanup = await Jazz.setup(f.ctx)
    for (const method of ["card.create", "card.move", "card.remove", "card.comment", "card.work", "review.decide",
      "board.archiveLane", "cron.upsert", "cron.remove", "cron.runNow", "inbox.ack", "inbox.ackAll", "inbox.clear", "inbox.clearAll"]) {
      expect(await f.handlers[method]!({ actor: "gavin", human: true }, f.caller)).toMatchObject({ type: "foundation_denied" })
    }
    expect(f.set).not.toHaveBeenCalled()
    expect(f.deniedAccess).not.toHaveBeenCalled()
    await cleanup?.()
  })

  it("all effectful tool executors deny, including intake, assign, submit and handoff", async () => {
    const f = fixture()
    const cleanup = await Jazz.setup(f.ctx)
    for (const name of ["kanban_create_card", "kanban_intake", "kanban_assign", "kanban_comment", "kanban_work",
      "kanban_submit_review", "kanban_handoff", "kanban_block", "kanban_move_card", "kanban_remove_card",
      "cron_upsert_job", "cron_remove_job", "cron_run_now", "inbox_ack", "inbox_clear", "inbox_clear_all"]) {
      await expect(f.tools[name]!.execute({ actor: "gavin" }, {})).rejects.toMatchObject({ code: "foundation_denied" })
    }
    expect(f.set).not.toHaveBeenCalled()
    expect(f.deniedAccess).not.toHaveBeenCalled()
    await cleanup?.()
  })

  it("does not adopt legacy board data into a second factory authority", async () => {
    const f = fixture()
    await f.storage.set("board/state", { legacyNonce: "must-be-preserved" })
    f.set.mockClear()
    const cleanup = await Jazz.setup(f.ctx)
    expect(await f.handlers["factory.status"]!({}, f.caller)).toMatchObject({ faults: expect.arrayContaining(["legacy_data_present"]) })
    expect(await f.handlers["board.get"]!({}, f.caller)).toMatchObject({ type: "foundation_denied" })
    expect(await f.storage.get("board/state")).toEqual({ legacyNonce: "must-be-preserved" })
    expect(f.set).not.toHaveBeenCalled()
    await cleanup?.()
  })
})
