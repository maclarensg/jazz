import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const notificationSchema = z.object({
  id: z.string(),
  ts: z.string(),
  source: z.enum(["card", "cron"]),
  kind: z.string(),
  message: z.string(),
  cardID: z.string().optional(),
  jobID: z.string().optional(),
  read: z.boolean(),
})

export const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  lane: z.string(),
  details: z.string().optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  profile: z.string().optional(),
  assignments: z.array(
    z.object({
      profile: z.string(),
      sessionID: z.string().optional(),
      startedAt: z.string(),
      endedAt: z.string().optional(),
      outcome: z.enum(["handoff", "submitted", "exited", "failed"]).optional(),
    }),
  ),
  comments: z.array(
    z.object({
      id: z.string(),
      author: z.string(),
      body: z.string(),
      ts: z.string(),
    }),
  ),
  history: z.array(
    z.object({
      ts: z.string(),
      kind: z.enum([
        "created",
        "moved",
        "assigned",
        "handoff",
        "comment",
        "review",
        "routed",
        "cron",
        "exit",
        "note",
      ]),
      actor: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
  source: z.enum(["manual", "cron", "session", "requeue"]),
  created: z.string(),
  updated: z.string(),
})

export const boardSchema = z.object({
  cards: z.record(z.string(), cardSchema),
  lanes: z.record(z.string(), z.array(z.string())),
})

export const cronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  cronExpr: z.string(),
  prompt: z.string(),
  agent: z.string().optional(),
  enabled: z.boolean(),
  nextRun: z.string().optional(),
  lastRun: z.string().optional(),
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
      input: z.object({
        title: z.string().min(1),
        lane: z.string().optional(),
        details: z.string().optional(),
        priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
        source: z.enum(["manual", "cron", "session", "requeue"]).optional(),
      }),
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
    "cron.upsert": {
      input: z.object({
        name: z.string().min(1),
        cronExpr: z.string().min(1),
        prompt: z.string().min(1),
        agent: z.string().optional(),
        enabled: z.boolean().optional(),
      }),
      output: cronJobSchema,
      errors: {
        invalid_cron: z.object({ cronExpr: z.string() }),
      },
    },
    "cron.list": {
      input: z.object({}).strict(),
      output: z.object({ jobs: z.array(cronJobSchema) }),
      errors: {},
    },
    "cron.remove": {
      input: z.object({ jobID: z.string() }),
      output: z.object({}).strict(),
      errors: {
        unknown_job: z.object({ jobID: z.string() }),
      },
    },
    "cron.runNow": {
      input: z.object({ jobID: z.string() }),
      output: z.object({ sessionID: z.string(), status: z.string() }),
      errors: {
        unknown_job: z.object({ jobID: z.string() }),
      },
    },
    "cron.runs": {
      input: z.object({ jobID: z.string().optional() }),
      output: z.object({
        runs: z.array(
          z.object({
            jobID: z.string(),
            jobName: z.string(),
            sessionID: z.string().optional(),
            firedAt: z.string(),
            status: z.string(),
            error: z.string().optional(),
            missed: z.boolean().optional(),
          }),
        ),
      }),
      errors: {},
    },
    "card.work": {
      input: z.object({ cardID: z.string(), prompt: z.string().min(1) }),
      output: z.object({ sessionID: z.string(), cardID: z.string() }),
      errors: {
        unknown_card: z.object({ cardID: z.string() }),
      },
    },
    "link.get": {
      input: z.object({ sessionID: z.string() }),
      output: z.object({
        link: z
          .object({ cardID: z.string(), startedAt: z.number() })
          .nullable(),
      }),
      errors: {},
    },
    "link.list": {
      input: z.object({}).strict(),
      output: z.object({
        links: z.array(
          z.object({ sessionID: z.string(), cardID: z.string(), startedAt: z.number() }),
        ),
      }),
      errors: {},
    },
    "inbox.list": {
      input: z.object({ unreadOnly: z.boolean().optional() }),
      output: z.object({ notifications: z.array(notificationSchema), unread: z.number().int() }),
      errors: {},
    },
    "inbox.ack": {
      input: z.object({ id: z.string().min(1) }),
      output: z.object({ unread: z.number().int() }),
      errors: {},
    },
    "inbox.ackAll": {
      input: z.object({}),
      output: z.object({ unread: z.number().int() }),
      errors: {},
    },
    "card.comment": {
      input: z.object({ cardID: z.string(), author: z.string().min(1), body: z.string().min(1) }),
      output: cardSchema,
      errors: {
        unknown_card: z.object({ cardID: z.string() }),
      },
    },
    "review.decide": {
      input: z.object({
        cardID: z.string(),
        decision: z.enum(["accept", "cancel", "requeue"]),
        note: z.string().optional(),
      }),
      output: cardSchema,
      errors: {
        unknown_card: z.object({ cardID: z.string() }),
        not_reviewable: z.object({ cardID: z.string(), lane: z.string() }),
      },
    },
    "routing.log": {
      input: z.object({ cardID: z.string().optional() }),
      output: z.object({
        decisions: z.array(
          z.object({
            cardID: z.string(),
            stage: z.enum(["domain", "profile"]),
            picked: z.string(),
            probabilities: z.record(z.string(), z.number()).optional(),
            confidence: z.number().optional(),
            reason: z.string().optional(),
            ts: z.string(),
            outcome: z.enum(["assigned", "requeued", "accepted", "cancelled"]).optional(),
          }),
        ),
      }),
      errors: {},
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
    "cron.fired": {
      schema: z.object({
        jobID: z.string(),
        jobName: z.string(),
        sessionID: z.string(),
      }),
    },
    "cron.failed": {
      schema: z.object({
        jobID: z.string(),
        jobName: z.string(),
        error: z.string(),
      }),
    },
    "inbox.notification": {
      schema: notificationSchema,
    },
  },
})
