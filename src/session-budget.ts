/**
 * Session budget watchdog (2026-10-04 burn audit, ~910M wasted tokens).
 *
 * A cron-fired session that overruns its wall-clock budget gets interrupted
 * and recorded. The overnight trigger: two triage-sweep sessions looped for
 * hours on a missing kanban tool catalog — nothing capped a fired session,
 * because fire prompt() resolves at accept and the scheduler moves on, so
 * the only guard (fireTimeoutMs) bounds the scheduler tick, not the session.
 *
 * Scope: cron-fired sessions only. Card-worker sessions are deliberately
 * excluded — real builds may legitimately run long, and their runtime is
 * already bounded by the requeue cap. Wiring (index.ts): arm in the
 * onFired hook, disarm in the event pump on terminal session.execution.*
 * outcomes, kill via ctx.session.interrupt, record via cronService.
 */

export interface BudgetWatch {
  /** Arm (or re-arm) the cap for a fired session. No-op when disabled. */
  arm: (sessionID: string) => void
  /** Clear the cap — the session reached a terminal outcome on its own. */
  disarm: (sessionID: string) => void
  /** Clear every pending timer (server shutdown). */
  dispose: () => void
}

export interface BudgetWatchInput {
  /** Wall-clock budget per fired session. 0/negative disables the watchdog. */
  budgetMs: number
  /** The kill switch — e.g. ctx.session.interrupt. */
  kill: (sessionID: string) => Promise<unknown>
  /** Runs after every kill attempt, even when kill rejects. */
  onKill?: (sessionID: string) => Promise<void>
}

export function createBudgetWatch(input: BudgetWatchInput): BudgetWatch {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const enabled = Number.isFinite(input.budgetMs) && input.budgetMs > 0

  const arm = (sessionID: string): void => {
    if (!enabled) return
    disarm(sessionID) // re-arm replaces, never stacks
    const timer = setTimeout(() => {
      pending.delete(sessionID)
      void (async () => {
        try {
          await input.kill(sessionID)
        } catch {
          // best effort — the record below must land regardless
        }
        await input.onKill?.(sessionID)
      })()
    }, input.budgetMs)
    pending.set(sessionID, timer)
  }

  const disarm = (sessionID: string): void => {
    const timer = pending.get(sessionID)
    if (timer === undefined) return
    clearTimeout(timer)
    pending.delete(sessionID)
  }

  const dispose = (): void => {
    for (const sessionID of [...pending.keys()]) disarm(sessionID)
  }

  return { arm, disarm, dispose }
}

/** The run-ring record for a budget kill: an error run bound to the fire. */
export function budgetKillRecord(job: {
  jobID: string
  jobName: string
  sessionID: string
  budgetMs: number
}): {
  jobID: string
  jobName: string
  sessionID: string
  firedAt: string
  status: "error"
  error: string
} {
  return {
    jobID: job.jobID,
    jobName: job.jobName,
    sessionID: job.sessionID,
    firedAt: new Date().toISOString(),
    status: "error",
    error: `session budget ${job.budgetMs}ms exceeded — session interrupted`,
  }
}
