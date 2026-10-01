import { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { asJsonStorage } from "./storage"
import { BoardError, createBoardService } from "./service"
import { createInboxService } from "./inbox-service"
import type { Notification } from "./inbox"
import { createCronService, CronError, type CronUpsertInput } from "./cron-service"
import { catchupPlan, dueJobs, leaseAlive, nextRunISO, type CatchupPolicy, type CronJob, type CronRun } from "./cron"
import { createLinkRegistry, isTerminalOutcome, OUTCOME_LANES as OUTCOME_LANES_MAP, transitionLane, type SessionOutcome } from "./link"
import { JazzRpc } from "./rpc"

const TICK_MS = 15_000
const LEASE_MS = 30_000

/** Lane → inbox kind. Lanes absent from this map are not notification-worthy. */
const LANE_NOTIFY_KINDS: Record<string, string> = {
  review: "entered_review",
  failed: "failed",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
  triage: "requeued",
}

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
    let emitCronFired: ((e: { jobID: string; jobName: string; sessionID: string }) => Promise<void>) | undefined
    let emitCronFailed: ((e: { jobID: string; jobName: string; error: string }) => Promise<void>) | undefined
    let emitInbox: ((n: Notification) => Promise<void>) | undefined

    const inboxService = createInboxService(storage)
    const notify = async (input: Parameters<typeof inboxService.notify>[0]) => {
      const notification = await inboxService.notify(input)
      await emitInbox?.(notification)
    }

    const service = createBoardService(storage, {
      ...(lanes ? { lanes } : {}),
      onMoved: async (card, fromLane) => {
        await emitMoved?.({ cardID: card.id, title: card.title, fromLane, toLane: card.lane })
        if (fromLane === card.lane) return // creates land without a lane change — not a move
        const kind = LANE_NOTIFY_KINDS[card.lane]
        if (kind) {
          await notify({
            source: "card",
            kind,
            message: `${card.title} (${card.id}): ${fromLane} → ${card.lane}`,
            cardID: card.id,
          })
        }
      },
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
      "cron.upsert": async (input, { error }) => {
        try {
          return await cronService.upsert(input as CronUpsertInput)
        } catch (e) {
          if (e instanceof CronError && e.code === "invalid-cron") {
            return error("invalid_cron", e.message, { cronExpr: input.cronExpr })
          }
          throw e
        }
      },
      "cron.list": async () => ({ jobs: await cronService.list() }),
      "cron.remove": async (input, { error }) => {
        try {
          await cronService.remove(input.jobID)
          return {}
        } catch (e) {
          if (e instanceof CronError && e.code === "unknown-job") {
            return error("unknown_job", e.message, { jobID: input.jobID })
          }
          throw e
        }
      },
      "cron.runNow": async (input, { error }) => {
        const job = await cronService.get(input.jobID)
        if (!job) return error("unknown_job", `unknown job: ${input.jobID}`, { jobID: input.jobID })
        const run = await fireJob(job, false)
        const nextAt = nextRunISO(job.cronExpr, new Date())
        await cronService.updateJob(job.id, {
          lastRun: run.firedAt,
          ...(nextAt ? { nextRun: nextAt } : {}),
        })
        return { sessionID: run.sessionID ?? "", status: run.status }
      },
      "cron.runs": async (input) => {
        const runs = await cronService.readRuns()
        return { runs: input.jobID ? runs.filter((r) => r.jobID === input.jobID) : runs }
      },
      "card.work": async (input, { error }) => {
        try {
          return await work(input)
        } catch (e) {
          if (e instanceof BoardError && e.code === "unknown-card") {
            return error("unknown_card", e.message, { cardID: input.cardID })
          }
          throw e
        }
      },
      "link.get": async (input) => {
        const link = registry.get(input.sessionID)
        return { link: link ? { cardID: link.cardID, startedAt: link.startedAt } : null }
      },
      "link.list": async () => {
        const links = [...registry.all().entries()].map(([sessionID, l]) => ({
          sessionID,
          cardID: l.cardID,
          startedAt: l.startedAt,
        }))
        return { links }
      },
      "inbox.list": async (input) => inboxService.list(input),
      "inbox.ack": async (input) => inboxService.ack(input.id),
      "inbox.ackAll": async () => inboxService.ackAll(),
    })

    emitCronFired = async (event) => {
      await registration.events.emit("cron.fired", event)
    }
    emitCronFailed = async (event) => {
      await registration.events.emit("cron.failed", event)
    }
    emitMoved = async (event) => {
      await registration.events.emit("card.moved", event)
    }
    emitInbox = async (notification) => {
      await registration.events.emit("inbox.notification", notification)
    }

    // ---- link (Task 4): the ONLY bridge between board and sessions.
    // kanban_work binds a session to a card; execution events move the card.
    const registry = createLinkRegistry()

    const work = async (input: { cardID: string; prompt: string }): Promise<{ sessionID: string; cardID: string }> => {
      const board = await service.get()
      const card = board.cards[input.cardID]
      if (!card) throw new BoardError("unknown-card", `unknown card: ${input.cardID}`)
      await service.move({ cardID: input.cardID, lane: "in_progress" })
      const session = await ctx.session.create({ title: `jazz:${card.title}` })
      registry.bind(session.id, input.cardID, Date.now())
      await ctx.session.prompt({
        sessionID: session.id,
        text: `You are working card "${card.title}" (${input.cardID}).\n\n${input.prompt}`,
      })
      return { sessionID: session.id, cardID: input.cardID }
    }

    const evController = new AbortController()
    const pump = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: evController.signal })) {
          const type = (event as { type?: string }).type
          if (typeof type !== "string" || !type.startsWith("session.execution.")) continue
          const outcome = type.slice("session.execution.".length) as SessionOutcome
          if (!(outcome in OUTCOME_LANES_MAP)) continue
          const data = (event as { data?: { sessionID?: string } }).data
          const sessionID = data?.sessionID
          if (!sessionID) continue
          const link = registry.get(sessionID)
          if (!link) continue // session we didn't start — not ours to move
          const board = await service.get()
          const card = board.cards[link.cardID]
          if (!card) {
            registry.drop(sessionID)
            continue
          }
          const target = transitionLane(card, outcome)
          if (target) await service.move({ cardID: link.cardID, lane: target })
          if (isTerminalOutcome(outcome)) registry.drop(sessionID)
        }
      } catch (e) {
        if (!(e instanceof Error && e.name === "AbortError")) {
          console.error("[jazz] event pump error:", e)
        }
      }
    })()

    // ---- cron (Task 3): dumb scheduler — prompt + schedule → fresh session.
    // Knows nothing about cards (design: board/cron decoupled; link is the
    // only bridge, arriving in Task 4).
    const cronOptions = (ctx.options ?? {}) as { catchup?: unknown }
    const policy: CatchupPolicy = cronOptions.catchup === "skip-missed" ? "skip-missed" : "fire-missed"
    const cronService = createCronService(storage)
    const instanceID = randomUUID()

    const fireJob = async (job: CronJob, missed: boolean): Promise<CronRun> => {
      const run: CronRun = {
        jobID: job.id,
        jobName: job.name,
        firedAt: new Date().toISOString(),
        status: "fired",
        ...(missed ? { missed: true } : {}),
      }
      try {
        const session = await ctx.session.create({ title: `jazz:${job.name}` })
        if (job.agent) await ctx.session.switchAgent({ sessionID: session.id, agent: job.agent })
        await ctx.session.prompt({ sessionID: session.id, text: job.prompt })
        run.sessionID = session.id
        await emitCronFired?.({ jobID: job.id, jobName: job.name, sessionID: session.id })
        await notify({
          source: "cron",
          kind: missed ? "caught_up" : "fired",
          message: `cron ${job.name} (${job.id}) ${missed ? "caught up" : "fired"} → session ${session.id}`,
          jobID: job.id,
        })
      } catch (e) {
        run.status = "error"
        run.error = e instanceof Error ? e.message : String(e)
        await emitCronFailed?.({ jobID: job.id, jobName: job.name, error: run.error })
        await notify({
          source: "cron",
          kind: "failed",
          message: `cron ${job.name} (${job.id}) failed: ${run.error}`,
          jobID: job.id,
        })
      }
      await cronService.appendRun(run)
      return run
    }

    let firstTick = true
    let ticking = false
    const tick = async (): Promise<void> => {
      if (ticking) return
      ticking = true
      try {
        const now = new Date()
        const lease = await cronService.readLease()
        if (!leaseAlive(lease, instanceID, now.getTime())) {
          if (lease && now.getTime() < lease.expiresAt) return // another instance leads
          await cronService.writeLease({ instanceID, expiresAt: now.getTime() + LEASE_MS })
        } else {
          await cronService.writeLease({ instanceID, expiresAt: now.getTime() + LEASE_MS })
        }

        const jobs = await cronService.list()
        let toFire: { job: CronJob; missed: boolean }[]
        if (firstTick) {
          firstTick = false
          const plan = catchupPlan(jobs, now, policy)
          await cronService.replaceJobs(plan.jobs)
          toFire = plan.fire.map((job) => ({ job, missed: true }))
        } else {
          toFire = dueJobs(jobs, now).map((job) => ({ job, missed: false }))
        }
        for (const { job, missed } of toFire) {
          const run = await fireJob(job, missed)
          const nextAt = nextRunISO(job.cronExpr, new Date())
          await cronService.updateJob(job.id, {
            lastRun: run.firedAt,
            ...(nextAt ? { nextRun: nextAt } : {}),
          })
        }
      } finally {
        ticking = false
      }
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

      editor.add({
        name: "work",
        description:
          "Start an agent session working a card: moves it to in_progress and binds the session so completion moves the card to done (or blocked on failure)",
        input: z.object({ cardID: z.string(), prompt: z.string().min(1) }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const r = await work(input)
          return { content: `session ${r.sessionID} started for card ${r.cardID}; it will move the card when done` }
        },
      })
    })

    const timer = setInterval(() => {
      void tick().catch(() => {}) // tick errors are recorded as failed runs; never kill the interval
    }, TICK_MS)
    void tick()

    return async () => {
      clearInterval(timer)
      evController.abort()
      await pump
      await cronService.clearLease(instanceID)
      await toolReg.dispose()
      await registration.dispose()
    }
  },
})
