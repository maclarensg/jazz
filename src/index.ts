import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { asJsonStorage } from "./storage"
import { BoardError, createBoardService } from "./service"
import { JazzRpc } from "./rpc"

/**
 * opencode-jazz server plugin.
 *
 * Modules (per docs/design/design.md): board (this file + service/board),
 * cron (Task 3), link (Task 4). They stay decoupled; index.ts is the only
 * place allowed to know about all of them.
 */
export default Plugin.define({
  id: "opencode-jazz",
  async setup(ctx) {
    const storage = asJsonStorage(ctx.storage)
    const options = (ctx.options ?? {}) as { lanes?: unknown }

    const lanes =
      Array.isArray(options.lanes) && options.lanes.every((l) => typeof l === "string")
        ? (options.lanes as string[])
        : undefined

    let emitMoved: ((e: { cardID: string; title: string; fromLane: string; toLane: string }) => Promise<void>) | undefined

    const service = createBoardService(storage, {
      ...(lanes ? { lanes } : {}),
      onMoved: (card, fromLane) => emitMoved?.({ cardID: card.id, title: card.title, fromLane, toLane: card.lane }),
    })

    const registration = await ctx.rpc.register(JazzRpc, {
      "board.get": async () => service.get(),
      "card.create": async (input, { error }) => {
        try {
          return await service.create(input)
        } catch (e) {
          if (e instanceof BoardError && e.code === "unknown-lane") {
            return error("unknown_lane", e.message, { lane: input.lane ?? "backlog" })
          }
          throw e
        }
      },
      "card.move": async (input, { error }) => {
        try {
          return await service.move(input)
        } catch (e) {
          if (e instanceof BoardError) {
            if (e.code === "unknown-card") return error("unknown_card", e.message, { cardID: input.cardID })
            return error("unknown_lane", e.message, { lane: input.lane })
          }
          throw e
        }
      },
      "card.remove": async (input, { error }) => {
        try {
          await service.remove(input)
          return {}
        } catch (e) {
          if (e instanceof BoardError && e.code === "unknown-card") {
            return error("unknown_card", e.message, { cardID: input.cardID })
          }
          throw e
        }
      },
    })

    emitMoved = async (event) => {
      await registration.events.emit("card.moved", event)
    }

    const boardService = service
    const toolReg = await ctx.tool.transform((editor) => {
      editor.namespace({ name: "kanban", description: "opencode-jazz kanban board" })

      editor.add({
        name: "create_card",
        description: "Create a card on the kanban board (defaults to the backlog lane)",
        input: z.object({ title: z.string().min(1), lane: z.string().optional() }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const card = await boardService.create(input)
          return { content: `card ${card.id} created in lane ${card.lane}` }
        },
      })

      editor.add({
        name: "move_card",
        description: "Move a card to a lane (optionally at an index)",
        input: z.object({ cardID: z.string(), lane: z.string(), index: z.number().int().optional() }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const card = await boardService.move(input)
          return { content: `card ${card.id} now in lane ${card.lane}` }
        },
      })

      editor.add({
        name: "list_cards",
        description: "List board cards, optionally filtered to one lane",
        input: z.object({ lane: z.string().optional() }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const board = await boardService.get()
          const laneNames = input.lane ? [input.lane] : Object.keys(board.lanes)
          const lines: string[] = []
          for (const lane of laneNames) {
            const ids = board.lanes[lane]
            if (!ids) return { content: `unknown lane: ${lane}` }
            for (const id of ids) lines.push(`${lane}: ${board.cards[id]?.title} (${id})`)
          }
          return { content: lines.length ? lines.join("\n") : "board is empty" }
        },
      })

      editor.add({
        name: "remove_card",
        description: "Remove a card from the board",
        input: z.object({ cardID: z.string() }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          await boardService.remove(input)
          return { content: `card ${input.cardID} removed` }
        },
      })
    })

    return async () => {
      await toolReg.dispose()
      await registration.dispose()
    }
  },
})
