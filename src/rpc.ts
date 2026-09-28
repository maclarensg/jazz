import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  lane: z.string(),
  created: z.string(),
  updated: z.string(),
})

export const boardSchema = z.object({
  cards: z.record(z.string(), cardSchema),
  lanes: z.record(z.string(), z.array(z.string())),
})

export const JazzRpc = Rpc.define({
  id: "jazz",
  methods: {
    "board.get": {
      input: z.object({}).strict(),
      output: boardSchema,
      errors: {},
    },
    "card.create": {
      input: z.object({ title: z.string().min(1), lane: z.string().optional() }),
      output: cardSchema,
      errors: {
        unknown_lane: z.object({ lane: z.string() }),
      },
    },
    "card.move": {
      input: z.object({ cardID: z.string(), lane: z.string(), index: z.number().int().optional() }),
      output: cardSchema,
      errors: {
        unknown_card: z.object({ cardID: z.string() }),
        unknown_lane: z.object({ lane: z.string() }),
      },
    },
    "card.remove": {
      input: z.object({ cardID: z.string() }),
      output: z.object({}).strict(),
      errors: {
        unknown_card: z.object({ cardID: z.string() }),
      },
    },
  },
  events: {
    "card.moved": {
      schema: z.object({
        cardID: z.string(),
        title: z.string(),
        fromLane: z.string(),
        toLane: z.string(),
      }),
    },
  },
})
