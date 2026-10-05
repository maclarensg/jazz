import type { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { FoundationRpc } from "./foundation-rpc"
import { ExecutionStateError } from "./execution-state"
import { createExecutionStore } from "./execution-store"
import { asJsonStorage } from "./storage"

const LEGACY_KEYS = ["board/state", "board/archive", "cron/jobs", "cron/runs", "cron/leader", "inbox/notifications", "jazz/routing"]
const SAFETY_FAULTS = ["ownership_unverified", "managed_child_stop_unverified", "human_authority_unverified"]

/**
 * Nonexecuting diagnostic slice. No ownership producer, timers, event pump,
 * runtime calls, store writes, or public reducer/receipt endpoints exist here.
 * This is a Jazz-entrypoint gate, not a same-UID or other-plugin sandbox.
 */
export async function setupFoundation(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const epoch = `controller-${randomUUID()}`
  const storage = asJsonStorage(ctx.storage)
  const store = createExecutionStore({ storage, controllerEpoch: epoch })
  async function inspect() {
    const legacy = await Promise.all(LEGACY_KEYS.map((key) => storage.get(key)))
    if (legacy.some((value) => value !== undefined)) throw new Error("legacy_data_present")
    return store.inspect()
  }
  async function status() {
    try {
      const snapshot = await inspect()
      return {
        mode: "foundation" as const, executionEnabled: false as const, writesEnabled: false as const,
        humanVerdictsEnabled: false as const, controllerEpoch: epoch, persistence: "read-only" as const,
        source: snapshot.source, leaseInventoryKnown: true, faults: [...SAFETY_FAULTS, ...snapshot.faults],
        heldExecutions: Object.values(snapshot.view.executions).filter((record) => record.reservation === "held")
          .map((record) => ({ executionID: record.executionID, cardID: record.cardID,
            ...(record.sessionID ? { sessionID: record.sessionID } : {}), status: "unknown" as const })),
        roundsConsumed: Object.fromEntries(Object.entries(snapshot.view.workRounds).map(([cardID, ledger]) => [cardID, ledger.consumed])),
      }
    } catch (error) {
      return {
        mode: "foundation" as const, executionEnabled: false as const, writesEnabled: false as const,
        humanVerdictsEnabled: false as const, controllerEpoch: epoch, persistence: "read-only" as const,
        source: "unavailable", leaseInventoryKnown: false, faults: [...SAFETY_FAULTS, error instanceof Error && error.message === "legacy_data_present" ? "legacy_data_present" : "storage_unavailable_or_invalid"],
        heldExecutions: [], roundsConsumed: {},
      }
    }
  }
  const denial = (operation: string) => ({ operation, reason: "Nonexecuting foundation: ownership, managed-child stop and human authority are not verified" })
  type RegisteredHandlers = Parameters<typeof ctx.rpc.register<typeof FoundationRpc>>[1]
  type Handlers = { -readonly [K in keyof RegisteredHandlers]: RegisteredHandlers[K] }
  // Every method starts denied; reads are explicitly allowlisted below. New
  // Jazz methods cannot silently acquire mutation authority in this branch.
  const handlers = Object.fromEntries(Object.keys(FoundationRpc.methods).map((operation) =>
    [operation, async (_input: unknown, caller: { error: (type: string, message: string, data: unknown) => unknown }) =>
      caller.error("foundation_denied", denial(operation).reason, denial(operation))])) as unknown as Handlers
  handlers["factory.status"] = async () => status()
  handlers["board.get"] = async (_input, caller) => {
    try { return (await inspect()).view.board }
    catch { return caller.error("foundation_denied", "Foundation storage is incompatible or unavailable; inspect factory.status", denial("board.get")) }
  }
  // An empty fresh namespace has no cron, links, routing, archive or inbox.
  // Incompatible legacy data is refused, not presented as an empty migration.
  const reads = {
    "cron.list": { jobs: [] }, "cron.runs": { runs: [] }, "link.list": { links: [] },
    "link.get": { link: null }, "routing.log": { decisions: [] }, "archive.get": { total: 0, cards: [] },
    "inbox.list": { notifications: [], unread: 0 }, "profiles.list": { entries: [], total: 0 },
    "profiles.stats": { total: 0, native: 0, perCategory: {} },
  }
  for (const [name, value] of Object.entries(reads)) {
    Object.assign(handlers, { [name]: async (_input: unknown, caller: { error: (type: string, message: string, data: unknown) => unknown }) => {
      try { await inspect(); return value }
      catch { return caller.error("foundation_denied", "Foundation storage is incompatible or unavailable", denial(name)) }
    } })
  }
  const registration = await ctx.rpc.register(FoundationRpc, handlers)
  try {
    const toolReg = await ctx.tool.transform((editor) => {
      for (const namespace of ["kanban", "cron", "inbox"]) {
        editor.namespace({ name: namespace, description: "Jazz nonexecuting foundation; all mutations disabled" })
      }
      const deniedTools = {
        kanban: ["create_card", "intake", "assign", "comment", "submit_review", "handoff", "block", "work", "move_card", "remove_card"],
        cron: ["upsert_job", "remove_job", "run_now"], inbox: ["ack", "clear", "clear_all"],
      }
      for (const [namespace, names] of Object.entries(deniedTools)) {
        for (const name of names) editor.add({
          name, description: "Disabled: nonexecuting foundation prerequisites are unverified",
          input: z.object({}).passthrough(), options: { namespace },
          execute: async () => { throw new ExecutionStateError("foundation_denied", denial(`${namespace}_${name}`).reason) },
        })
      }
      editor.add({ name: "list_cards", description: "Read the retained foundation board; no dispatch or mutation",
        input: z.object({ lane: z.string().optional() }), options: { namespace: "kanban" },
        execute: async (input) => {
          const board = (await inspect()).view.board
          const cards = Object.values(board.cards).filter((card) => !input.lane || card.lane === input.lane)
          return { content: JSON.stringify(cards) }
        },
      })
      editor.add({ name: "foundation_status", description: "Read Jazz safety faults and held/unknown leases",
        input: z.object({}).strict(), options: { namespace: "kanban" },
        execute: async () => ({ content: JSON.stringify(await status()) }),
      })
    })
    return async () => { await toolReg.dispose(); await registration.dispose() }
  } catch (error) {
    await registration.dispose()
    throw error
  }
}
