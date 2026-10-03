/**
 * Fire-time session creation for cron jobs, extracted from the plugin
 * closure so the agent-resolution fallback is unit-testable (card
 * fc0a2fb6). Same invariant as work(): switchAgent silently accepts
 * unknown ids and the session dies at prompt time with
 * Session.AgentNotFoundError — so job.agent is resolved against the
 * runtime set via resolveWorkerAgent before any switch. An unresolvable
 * agent degrades to the safe prompt-only default with a run-log note; a
 * fired session is never dead on arrival.
 */

import { resolveWorkerAgent } from "./agent-resolve"
import { cronNotifyKind, type CronJob, type CronRun } from "./cron"

export interface FireJobIO {
  createSession: (title: string) => Promise<{ id: string }>
  switchAgent: (sessionID: string, agent: string) => Promise<unknown>
  prompt: (sessionID: string, text: string) => Promise<unknown>
  /** Ids of the agents the server can actually run; empty on failure. */
  runtimeAgentIds: () => Promise<string[]>
  appendRun: (run: CronRun) => Promise<void>
  notify: (input: { source: "cron"; kind: string; message: string; jobID: string }) => Promise<unknown>
  onFired?: (e: { jobID: string; jobName: string; sessionID: string }) => Promise<void>
  onFailed?: (e: { jobID: string; jobName: string; error: string }) => Promise<void>
}

export function makeFireJob(io: FireJobIO) {
  return async function fireJob(job: CronJob, missed: boolean): Promise<CronRun> {
    const run: CronRun = {
      jobID: job.id,
      jobName: job.name,
      firedAt: new Date().toISOString(),
      status: "fired",
      ...(missed ? { missed: true } : {}),
    }
    try {
      const session = await io.createSession(`jazz:${job.name}`)
      // Only attach an agent the runtime can actually resolve — an unknown
      // id kills the session at prompt time (see module doc). The note rides
      // on the run record before the prompt so the fallback stays visible
      // even if the prompt then fails for an unrelated reason.
      const resolution = resolveWorkerAgent(job.agent, await io.runtimeAgentIds())
      if (resolution.note) run.note = resolution.note
      if (resolution.agent) {
        try {
          await io.switchAgent(session.id, resolution.agent)
        } catch {
          // agent list drifted since resolution — prompt-only default
        }
      }
      await io.prompt(session.id, job.prompt)
      run.sessionID = session.id
      await io.onFired?.({ jobID: job.id, jobName: job.name, sessionID: session.id })
      const kind = cronNotifyKind(job, { ok: true, missed })
      if (kind) {
        await io.notify({
          source: "cron",
          kind,
          message: `cron ${job.name} (${job.id}) ${missed ? "caught up" : "fired"} → session ${session.id}`,
          jobID: job.id,
        })
      }
    } catch (e) {
      run.status = "error"
      run.error = e instanceof Error ? e.message : String(e)
      await io.onFailed?.({ jobID: job.id, jobName: job.name, error: run.error })
      await io.notify({
        source: "cron",
        // failures always notify, even when allowNotify=false (cronNotifyKind)
        kind: cronNotifyKind(job, { ok: false })!,
        message: `cron ${job.name} (${job.id}) failed: ${run.error}`,
        jobID: job.id,
      })
    }
    await io.appendRun(run)
    return run
  }
}
