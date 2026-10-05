import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { JazzRpc } from "./rpc"

const denied = z.object({ operation: z.string(), reason: z.string() })
type OriginalMethods = typeof JazzRpc.methods
type GuardedMethods = { [K in keyof OriginalMethods]: OriginalMethods[K] & { errors: OriginalMethods[K]["errors"] & { foundation_denied: typeof denied } } }

/** Same wire ID; registered INSTEAD OF legacy RPC, never beside it. */
export const FoundationRpc = Rpc.define({
  ...JazzRpc,
  methods: {
    ...Object.fromEntries(Object.entries(JazzRpc.methods).map(([name, method]) =>
      [name, { ...method, errors: { ...method.errors, foundation_denied: denied } }])) as GuardedMethods,
    "factory.status": {
      input: z.object({}).strict(),
      output: z.object({
        mode: z.literal("foundation"), executionEnabled: z.literal(false), writesEnabled: z.literal(false),
        humanVerdictsEnabled: z.literal(false), controllerEpoch: z.string(), source: z.string(),
        persistence: z.literal("read-only"), leaseInventoryKnown: z.boolean(), faults: z.array(z.string()),
        heldExecutions: z.array(z.object({ executionID: z.string(), cardID: z.string(), sessionID: z.string().optional(), status: z.literal("unknown") })),
        roundsConsumed: z.record(z.string(), z.number().int()),
      }),
      errors: {},
    },
  },
})
