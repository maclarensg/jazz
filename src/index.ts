import { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { z } from "zod"
import { asJsonStorage } from "./storage"
import { createDispatchState, dispatchableCards, DEFAULT_DISPATCH, type DispatchConfig } from "./dispatch"
import { BoardError, createBoardService } from "./service"
import { createInboxService } from "./inbox-service"
import type { Notification } from "./inbox"
import { createCronService, CronError, type CronUpsertInput } from "./cron-service"
import { catchupPlan, dueJobs, leaseAlive, nextRunISO, type CatchupPolicy, type CronJob } from "./cron"
import { makeFireJob } from "./cron-fire"
import { createLinkRegistry, EXIT_NO_SUBMIT, isTerminalOutcome, OUTCOME_LANES as OUTCOME_LANES_MAP, reviewGuard, transitionLane, type SessionOutcome } from "./link"
import { createRoutingService } from "./routing-service"
import { resolveWorkerAgent } from "./agent-resolve"
import { normalizeRegistry, searchProfiles, topCandidates, type RegistryEntry } from "./profiles"
import { JazzRpc } from "./rpc"

const TICK_MS = 15_000
const LEASE_MS = 30_000
/** Max assignment hops per card before it goes to failed (design §6 loop guards). */
const HANDOFF_CAP = 6

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
    const options = (ctx.options ?? {}) as {
      lanes?: unknown
      dispatch?: { enabled?: unknown; cooldownMs?: unknown; maxInFlight?: unknown }
    }

    const lanes =
      Array.isArray(options.lanes) && options.lanes.every((l) => typeof l === "string")
        ? (options.lanes as string[])
        : undefined

    const dispatchCfg: DispatchConfig = {
      ...DEFAULT_DISPATCH,
      ...(typeof options.dispatch?.enabled === "boolean" ? { enabled: options.dispatch.enabled } : {}),
      ...(typeof options.dispatch?.cooldownMs === "number" ? { cooldownMs: options.dispatch.cooldownMs } : {}),
      ...(typeof options.dispatch?.maxInFlight === "number" ? { maxInFlight: options.dispatch.maxInFlight } : {}),
      // test isolation: the integration harness opts every server out by default
      ...(process.env.JAZZ_DISPATCH === "0" ? { enabled: false } : {}),
    }
    const dispatchState = createDispatchState()

    let emitMoved: ((e: { cardID: string; title: string; fromLane: string; toLane: string }) => Promise<void>) | undefined
    let emitCronFired: ((e: { jobID: string; jobName: string; sessionID: string }) => Promise<void>) | undefined
    let emitCronFailed: ((e: { jobID: string; jobName: string; error: string }) => Promise<void>) | undefined
    let emitInbox: ((n: Notification) => Promise<void>) | undefined

    const inboxService = createInboxService(storage)
    const routingService = createRoutingService(storage)

    // ---- profile registry (imported corpus + soul roles; registry.json is
    // the on-disk source of truth, scripts/import-profiles.sh refreshes it)
    const registryUrl = new URL("../registry.json", import.meta.url)
    let profileRegistry: RegistryEntry[] = []
    try {
      profileRegistry = existsSync(registryUrl) ? normalizeRegistry(JSON.parse(readFileSync(registryUrl, "utf8"))) : []
    } catch (e) {
      console.error("[jazz] registry.json unreadable — profiles unavailable:", e)
    }
    const registryById = new Map(profileRegistry.map((e) => [e.id, e]))
    const roleText = (profile: string): string | null => {
      const entry = registryById.get(profile)
      if (!entry) return null
      try {
        const fileUrl = new URL(`../${entry.path}`, import.meta.url)
        if (!existsSync(fileUrl)) return null
        const text = readFileSync(fileUrl, "utf8")
        const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1
        const body = end >= 0 ? text.slice(end + 4) : text
        return `# Profile: ${entry.name}\n${entry.description}\n\n${body.trim().slice(0, 2500)}`
      } catch {
        return null
      }
    }

    const notify = async (input: Parameters<typeof inboxService.notify>[0]) => {
      const notification = await inboxService.notify(input)
      await emitInbox?.(notification)
    }

    /** Ids of the agents this server can actually run. Empty on failure — the
     * safe default is prompt-only personas, never an unresolvable agent. */
    const runtimeAgentIds = async (): Promise<string[]> => {
      try {
        const { data } = await ctx.agent.list()
        return data.map((a) => a.id)
      } catch {
        return []
      }
    }

    const service = createBoardService(storage, {
      ...(lanes ? { lanes } : {}),
      onMoved: async (card, fromLane) => {
        await emitMoved?.({ cardID: card.id, title: card.title, fromLane, toLane: card.lane })
        if (fromLane === card.lane) return // creates land without a lane change — not a move
        const kind = LANE_NOTIFY_KINDS[card.lane]
        if (kind) {
          let message = `${card.title} (${card.id}): ${fromLane} → ${card.lane}`
          if (card.lane === "review" && card.comments.length > 0) {
            const last = card.comments[card.comments.length - 1]
            if (last) {
              const body = last.body.length > 220 ? `${last.body.slice(0, 220)}…` : last.body
              message += ` · ${last.author}: ${body}`
            }
          }
          await notify({
            source: "card",
            kind,
            message,
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
      "inbox.clear": async (input) => inboxService.clear(input.id),
      "inbox.clearAll": async () => inboxService.clearAll(),
      "board.archiveLane": async (input, { error }) => {
        try {
          const result = await service.archiveLane({ lane: input.lane, ...(input.actor ? { actor: input.actor } : {}) })
          if (result.archived > 0) {
            await notify({
              source: "card",
              kind: "archived",
              message: `archived ${result.archived} cards from ${input.lane} (archive: ${result.archiveTotal})`,
            })
          }
          return result
        } catch (e) {
          if (e instanceof BoardError) {
            if (e.code === "unknown-lane") return error("unknown_lane", e.message, { lane: input.lane })
            return error("not_archivable", e.message, { lane: input.lane })
          }
          throw e
        }
      },
      "archive.get": async () => {
        const doc = await service.archiveList()
        return { total: doc.order.length, cards: doc.order.map((id) => doc.cards[id]!) }
      },
      "card.comment": async (input, { error }) => {
        try {
          return await service.comment(input)
        } catch (e) {
          if (e instanceof BoardError && e.code === "unknown-card") {
            return error("unknown_card", e.message, { cardID: input.cardID })
          }
          throw e
        }
      },
      "review.decide": async (input, { error }) => {
        const board = await service.get()
        const card = board.cards[input.cardID]
        if (!card) return error("unknown_card", `unknown card: ${input.cardID}`, { cardID: input.cardID })
        const from = card.lane
        const decidable = from === "review" || from === "failed"
        if (!decidable || (input.decision === "accept" && from !== "review")) {
          return error("not_reviewable", `card ${input.cardID} is in lane ${from}; decide only from review (a/x/r) or failed (x/r)`, {
            cardID: input.cardID,
            lane: from,
          })
        }
        const to = input.decision === "accept" ? "done" : input.decision === "cancel" ? "cancelled" : "triage"
        if (input.note) await service.comment({ cardID: input.cardID, author: "gavin", body: input.note })
        const moved = await service.move({ cardID: input.cardID, lane: to, actor: "gavin" })
        await routingService.setOutcome(
          input.cardID,
          input.decision === "accept" ? "accepted" : input.decision === "cancel" ? "cancelled" : "requeued",
        )
        return moved
      },
      "routing.log": async (input) => ({ decisions: await routingService.list(input.cardID) }),
      "profiles.list": async (input) => {
        const found = searchProfiles(profileRegistry, input)
        return { entries: found.slice(0, 100), total: found.length }
      },
      "profiles.stats": async () => {
        const perCategory: Record<string, number> = {}
        for (const e of profileRegistry) perCategory[e.category] = (perCategory[e.category] ?? 0) + 1
        return { total: profileRegistry.length, native: profileRegistry.filter((e) => e.native).length, perCategory }
      },
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
      if (!reviewGuard(card.lane)) {
        throw new Error(`card ${input.cardID} is in lane ${card.lane} — review/failed/terminal lanes are Gavin's, not workable`)
      }
      if (card.assignments.some((a) => a.endedAt === undefined)) {
        throw new Error(`card ${input.cardID} already has an open worker session`)
      }
      const actor = card.profile ?? "agent"
      await service.move({ cardID: input.cardID, lane: "in_progress", actor })
      const session = await ctx.session.create({ title: `jazz:${card.title}` })
      // Only attach a profile the runtime can actually resolve — switchAgent
      // accepts unknown ids silently and the session dies at prompt time
      // (Session.AgentNotFoundError). Everyone else runs the default agent
      // with the profile role in the prompt (hybrid personas).
      const resolution = resolveWorkerAgent(card.profile, await runtimeAgentIds())
      if (resolution.agent) {
        try {
          await ctx.session.switchAgent({ sessionID: session.id, agent: resolution.agent })
        } catch {
          // agent list drifted since resolution — the role rides in the prompt instead
        }
      }
      if (resolution.note) {
        await service.comment({ cardID: input.cardID, author: "system", body: resolution.note })
      }
      registry.bind(session.id, input.cardID, Date.now())
      await service.startWork({ cardID: input.cardID, profile: card.profile ?? "worker", sessionID: session.id, actor })
      const comments = card.comments
        .slice(-3)
        .map((c) => `${c.author}: ${c.body}`)
        .join("\n")
      const role = roleText(card.profile ?? "")
      const text = [
        `You are working card "${card.title}" (${input.cardID}), priority p${card.priority}.`,
        card.profile ? `Assigned profile: ${card.profile}.` : null,
        role,
        card.details ? `Details: ${card.details}` : null,
        comments ? `Recent comments:\n${comments}` : null,
        `When your part is done: kanban_submit_review (send to human review) or kanban_handoff (another profile continues). Stuck: kanban_block.`,
        "",
        input.prompt,
      ]
        .filter(Boolean)
        .join("\n")
      await ctx.session.prompt({ sessionID: session.id, text })
      return { sessionID: session.id, cardID: input.cardID }
    }

    const requireWorkableCard = async (cardID: string) => {
      const board = await service.get()
      const card = board.cards[cardID]
      if (!card) throw new BoardError("unknown-card", `unknown card: ${cardID}`)
      if (!reviewGuard(card.lane)) {
        throw new Error(`card ${cardID} is in lane ${card.lane} — not workable from there`)
      }
      return card
    }

    const submitReview = async (input: { cardID: string; summary: string }) => {
      const card = await requireWorkableCard(input.cardID)
      if (card.lane !== "in_progress") throw new Error(`card ${input.cardID} is not in_progress (${card.lane})`)
      const actor = card.profile ?? "worker"
      if (card.assignments.some((a) => a.endedAt === undefined)) {
        await service.endWork({ cardID: input.cardID, outcome: "submitted", actor })
      }
      await service.comment({ cardID: input.cardID, author: actor, body: input.summary })
      return service.move({ cardID: input.cardID, lane: "review", actor })
    }

    const handoff = async (input: { cardID: string; toProfile: string; note?: string; force?: boolean }) => {
      const card = await requireWorkableCard(input.cardID)
      if (card.lane !== "in_progress") throw new Error(`card ${input.cardID} is not in_progress (${card.lane})`)
      const actor = card.profile ?? "worker"
      if (card.assignments.length >= HANDOFF_CAP) {
        await service.comment({ cardID: input.cardID, author: "system", body: `Handoff cap (${HANDOFF_CAP}) reached — sending to failed for Gavin.` })
        const moved = await service.move({ cardID: input.cardID, lane: "failed", actor: "system" })
        return { moved, reason: "handoff-cap" }
      }
      if (input.toProfile === card.profile && !input.force) {
        throw new Error(`card ${input.cardID} is already assigned to ${card.profile} — pass force:true to re-handoff to the same profile`)
      }
      if (card.assignments.some((a) => a.endedAt === undefined)) {
        await service.endWork({ cardID: input.cardID, outcome: "handoff", actor, detail: `→ ${input.toProfile}` })
      }
      if (input.note) await service.comment({ cardID: input.cardID, author: actor, body: input.note })
      // assignProfile only routes in triage/ready — return the card to ready
      // (assignment closed above) BEFORE setting the handoff target profile
      const moved = await service.move({ cardID: input.cardID, lane: "ready", actor })
      await service.assign({ cardID: input.cardID, profile: input.toProfile, actor })
      return { moved, reason: "handoff" }
    }

    const blockCard = async (input: { cardID: string; reason: string }) => {
      const card = await requireWorkableCard(input.cardID)
      const actor = card.profile ?? "worker"
      if (card.assignments.some((a) => a.endedAt === undefined)) {
        await service.endWork({ cardID: input.cardID, outcome: "exited", actor, detail: input.reason })
      }
      await service.comment({ cardID: input.cardID, author: actor, body: `Blocked: ${input.reason}` })
      return service.move({ cardID: input.cardID, lane: "blocked", actor })
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
          // v2: a succeeded session that never submitted for review is not a
          // verdict — record the bail-out, then return the card (or fail it).
          if (target && outcome === "succeeded") {
            if (card.assignments.some((a) => a.endedAt === undefined)) {
              await service.endWork({
                cardID: link.cardID,
                outcome: "exited",
                actor: card.profile ?? "worker",
                detail: EXIT_NO_SUBMIT,
              })
            }
            await service.comment({
              cardID: link.cardID,
              author: "system",
              body: "Worker session ended without submitting for review.",
            })
          }
          if (target) await service.move({ cardID: link.cardID, lane: target, actor: "system" })
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

    // Fire bodies live in src/cron-fire.ts (extracted so the agent-resolution
    // fallback is unit-testable): resolution, notification contract, run ring.
    const fireJob = makeFireJob({
      createSession: (title) => ctx.session.create({ title }),
      switchAgent: (sessionID, agent) => ctx.session.switchAgent({ sessionID, agent }),
      prompt: (sessionID, text) => ctx.session.prompt({ sessionID, text }),
      runtimeAgentIds,
      appendRun: (run) => cronService.appendRun(run),
      notify,
      // late-bound on purpose: emitCronFired/emitCronFailed are let-bound
      // during setup — preserve the original call-time dereference
      onFired: (e) => emitCronFired?.(e),
      onFailed: (e) => emitCronFailed?.(e),
    })

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

        // ---- dispatcher: pull dispatchable ready cards into worker sessions.
        // Leader-gated by the same lease as cron — one dispatcher per storage.
        if (dispatchCfg.enabled) {
          const board = await service.get()
          // prune in-flight entries whose assignment has closed (card moved on)
          for (const id of [...dispatchState.inFlight]) {
            const card = board.cards[id]
            if (!card?.assignments.some((a) => a.endedAt === undefined)) {
              dispatchState.inFlight = dispatchState.inFlight.filter((x) => x !== id)
            }
          }
          const picks = dispatchableCards(board, dispatchState, dispatchCfg, now)
          for (const card of picks) {
            dispatchState.lastAttempt[card.id] = now.toISOString()
            dispatchState.inFlight.push(card.id)
            try {
              await work({
                cardID: card.id,
                prompt: `Work this card autonomously. Read the title${card.details ? " and details" : ""}, do what it asks using your available tools, then kanban_submit_review with a one-paragraph summary.`,
              })
            } catch (e) {
              dispatchState.inFlight = dispatchState.inFlight.filter((x) => x !== card.id)
              const msg = e instanceof Error ? e.message : String(e)
              try {
                await service.comment({ cardID: card.id, author: "system", body: `dispatch failed: ${msg}` })
              } catch {
                // card comment is best-effort; the cooldown already prevents hammering
              }
            }
          }
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
        description: "Create a card on the kanban board (defaults to the triage lane, where Laya routing assigns a profile)",
        input: z.object({
          title: z.string().min(1),
          lane: z.string().optional(),
          details: z.string().optional(),
          priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
          source: z.enum(["manual", "cron", "session", "requeue"]).optional(),
        }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const card = await boardService.create(input)
          return { content: `card ${card.id} created in lane ${card.lane}` }
        },
      })

      editor.add({
        name: "intake",
        description: "File new work into the board: creates a card in triage with priority and details, ready for Laya routing",
        input: z.object({
          title: z.string().min(1),
          details: z.string().optional(),
          priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
          source: z.enum(["manual", "cron", "session", "requeue"]).optional(),
        }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const card = await boardService.create({ ...input, lane: "triage", source: input.source ?? "session" })
          return { content: `card ${card.id} filed to triage (priority p${card.priority})` }
        },
      })

      editor.add({
        name: "assign",
        description:
          "Assign a profile to a card (Laya routing output). Records the routing decision (stage, probabilities, confidence) and sets priority if given",
        input: z.object({
          cardID: z.string(),
          profile: z.string().min(1),
          reason: z.string().optional(),
          priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
          stage: z.enum(["domain", "profile"]).optional(),
          probabilities: z.record(z.string(), z.number()).optional(),
          confidence: z.number().optional(),
        }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          // assign first: only routes that took effect enter the calibration
          // log — a refused assign (open assignment / non-routing lane) must
          // not stamp a phantom "assigned" decision
          const card = await boardService.assign({
            cardID: input.cardID,
            profile: input.profile,
            actor: "laya",
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          })
          await routingService.record({
            cardID: input.cardID,
            stage: input.stage ?? "profile",
            picked: input.profile,
            ...(input.probabilities ? { probabilities: input.probabilities } : {}),
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
            outcome: "assigned",
          })
          return { content: `card ${card.id} assigned to ${input.profile} (now ${card.lane})` }
        },
      })

      editor.add({
        name: "comment",
        description: "Add a comment to a card (visible in card detail and to every future worker)",
        input: z.object({ cardID: z.string(), body: z.string().min(1) }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const board = await boardService.get()
          const card = board.cards[input.cardID]
          if (!card) return { content: `unknown card: ${input.cardID}` }
          await boardService.comment({ cardID: input.cardID, author: card.profile ?? "agent", body: input.body })
          return { content: `comment added to ${input.cardID}` }
        },
      })

      editor.add({
        name: "submit_review",
        description: "Worker: your part of the card is done — submit a summary and send the card to Gavin's review lane",
        input: z.object({ cardID: z.string(), summary: z.string().min(1) }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const card = await submitReview(input)
          return { content: `card ${card.id} submitted for review` }
        },
      })

      editor.add({
        name: "handoff",
        description:
          "Worker: hand the card to another profile (e.g. SWE → QA). Card returns to ready with the new profile set; a dispatch pass starts the next session",
        input: z.object({
          cardID: z.string(),
          toProfile: z.string().min(1),
          note: z.string().optional(),
          force: z.boolean().optional(),
        }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const { moved, reason } = await handoff(input)
          if (reason === "handoff-cap") return { content: `handoff cap reached — card ${moved.id} moved to failed for Gavin` }
          return { content: `card ${moved.id} handed off to ${input.toProfile} (now ${moved.lane})` }
        },
      })

      editor.add({
        name: "block",
        description: "Worker: flag the card as blocked with a reason (needs input/dependency) — it waits in blocked for unblocking",
        input: z.object({ cardID: z.string(), reason: z.string().min(1) }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const card = await blockCard(input)
          return { content: `card ${card.id} blocked: ${input.reason}` }
        },
      })

      editor.add({
        name: "routing_candidates",
        description:
          "Top-16 registry profiles for a card by keyword overlap (Laya stage-2 prefilter). Use with a category to scope; feed the candidates as choice options to core.jev_laya",
        input: z.object({ cardID: z.string(), category: z.string().optional(), limit: z.number().int().min(1).max(16).optional() }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const board = await boardService.get()
          const card = board.cards[input.cardID]
          if (!card) return { content: `unknown card: ${input.cardID}` }
          const candidates = topCandidates(card, profileRegistry, {
            ...(input.category ? { category: input.category } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
          })
          if (!candidates.length) return { content: "no scoring candidates — list profiles with profiles.list or assign manually" }
          return { content: candidates.map((e) => `${e.id} — ${e.name}: ${e.description}`).join("\n") }
        },
      })

      editor.add({
        name: "work",
        description:
          "Start a worker session on a card: resolves its assigned profile, moves it to in_progress, binds the session; exit without submit_review returns the card to ready",
        input: z.object({ cardID: z.string(), prompt: z.string().min(1) }),
        options: { namespace: "kanban" },
        execute: async (input) => {
          const r = await work(input)
          return { content: `session ${r.sessionID} started for card ${r.cardID}; it will move the card when done` }
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

      // ---- cron tools ----
      editor.namespace({ name: "cron", description: "opencode-jazz scheduled jobs" })

      editor.add({
        name: "list_jobs",
        description: "List scheduled cron jobs with their expressions, enable and notify state, and last/next run times",
        input: z.object({}),
        options: { namespace: "cron" },
        execute: async () => {
          const jobs = await cronService.list()
          if (!jobs.length) return { content: "no cron jobs" }
          return {
            content: jobs
              .map(
                (j) =>
                  `${j.id} ${j.enabled ? "enabled" : "disabled"} ${j.name} [${j.cronExpr}] agent=${j.agent ?? "—"} notify=${j.allowNotify === false ? "muted" : "on"} last=${j.lastRun ?? "—"} next=${j.nextRun ?? "—"}`,
              )
              .join("\n"),
          }
        },
      })

      editor.add({
        name: "upsert_job",
        description:
          "Create or update a scheduled cron job. The prompt is executed by an agent session at each fire — make it self-contained (exact commands, exact card IDs, what to do with the result). Set allowNotify=false on high-frequency jobs to mute fired/caught_up inbox notifications (failures still notify)",
        input: z.object({
          name: z.string().min(1),
          cronExpr: z.string().min(1),
          prompt: z.string().min(1),
          agent: z.string().optional(),
          enabled: z.boolean().optional(),
          allowNotify: z.boolean().optional(),
        }),
        options: { namespace: "cron" },
        execute: async (input) => {
          try {
            const job = await cronService.upsert(input as CronUpsertInput)
            return { content: `job ${job.name} (${job.id}) saved [${job.cronExpr}] ${job.enabled ? "enabled" : "disabled"}, notify ${job.allowNotify === false ? "muted" : "on"}, next ${job.nextRun ?? "—"}` }
          } catch (e) {
            if (e instanceof CronError && e.code === "invalid-cron") {
              return { content: `invalid cron expression: ${input.cronExpr}` }
            }
            throw e
          }
        },
      })

      editor.add({
        name: "remove_job",
        description: "Remove a scheduled cron job by id (see cron.list_jobs)",
        input: z.object({ jobID: z.string() }),
        options: { namespace: "cron" },
        execute: async (input) => {
          try {
            await cronService.remove(input.jobID)
            return { content: `job ${input.jobID} removed` }
          } catch (e) {
            if (e instanceof CronError && e.code === "unknown-job") {
              return { content: `unknown job: ${input.jobID}` }
            }
            throw e
          }
        },
      })

      editor.add({
        name: "run_now",
        description: "Fire a scheduled job immediately (spawns its agent session now instead of waiting for the schedule)",
        input: z.object({ jobID: z.string() }),
        options: { namespace: "cron" },
        execute: async (input) => {
          const job = await cronService.get(input.jobID)
          if (!job) return { content: `unknown job: ${input.jobID}` }
          const run = await fireJob(job, false)
          const nextAt = nextRunISO(job.cronExpr, new Date())
          await cronService.updateJob(job.id, {
            lastRun: run.firedAt,
            ...(nextAt ? { nextRun: nextAt } : {}),
          })
          return { content: run.status === "fired" ? `fired ${job.name} -> session ${run.sessionID}` : `${job.name}: ${run.status}` }
        },
      })

      editor.add({
        name: "runs",
        description: "Recent run log for cron jobs (firedAt, status, session), optionally filtered to one job",
        input: z.object({ jobID: z.string().optional() }),
        options: { namespace: "cron" },
        execute: async (input) => {
          const runs = await cronService.readRuns()
          const filtered = input.jobID ? runs.filter((r) => r.jobID === input.jobID) : runs
          if (!filtered.length) return { content: "no runs recorded" }
          return {
            content: filtered
              .slice(-20)
              .map((r) => `${r.firedAt} ${r.jobName} ${r.status}${r.sessionID ? ` ${r.sessionID}` : ""}${r.error ? ` ERROR: ${r.error}` : ""}`)
              .join("\n"),
          }
        },
      })

      // ---- inbox tools ----
      editor.namespace({ name: "inbox", description: "opencode-jazz notification inbox" })

      editor.add({
        name: "list",
        description: "List inbox notifications (newest last), optionally unread-only",
        input: z.object({ unreadOnly: z.boolean().optional(), limit: z.number().int().optional() }),
        options: { namespace: "inbox" },
        execute: async (input) => {
          const r = await inboxService.list({ ...(input.unreadOnly !== undefined ? { unreadOnly: input.unreadOnly } : {}) })
          const items = input.limit ? r.notifications.slice(-input.limit) : r.notifications
          if (!items.length) return { content: `inbox empty (${r.unread} unread)` }
          return {
            content: [`${items.length} notification(s), ${r.unread} unread`, ...items.map((n) => `${n.id} ${n.ts} [${n.kind}] ${n.message}`)].join("\n"),
          }
        },
      })

      editor.add({
        name: "ack",
        description: "Mark one inbox notification read (stays in the list, dimmed)",
        input: z.object({ id: z.string().min(1) }),
        options: { namespace: "inbox" },
        execute: async (input) => {
          const r = await inboxService.ack(input.id)
          return { content: `marked read; ${r.unread} unread remain` }
        },
      })

      editor.add({
        name: "clear",
        description: "Remove one notification from the inbox entirely (unlike ack, it is gone)",
        input: z.object({ id: z.string().min(1) }),
        options: { namespace: "inbox" },
        execute: async (input) => {
          const r = await inboxService.clear(input.id)
          return { content: r.cleared ? `cleared; ${r.unread} unread remain` : `no such notification: ${input.id}` }
        },
      })

      editor.add({
        name: "clear_all",
        description: "Empty the inbox — removes every notification from the list",
        input: z.object({}),
        options: { namespace: "inbox" },
        execute: async () => {
          const r = await inboxService.clearAll()
          return { content: `cleared ${r.cleared} notifications` }
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
