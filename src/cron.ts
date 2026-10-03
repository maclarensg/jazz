import { Cron } from "croner"

export interface CronJob {
  id: string
  name: string
  cronExpr: string
  prompt: string
  agent?: string
  enabled: boolean
  /** Push inbox notifications on fired/caught_up? Failures always notify. Default true. */
  allowNotify?: boolean
  /** ISO timestamp of the next scheduled fire. */
  nextRun?: string
  /** ISO timestamp of the last completed fire attempt. */
  lastRun?: string
}

export interface CronRun {
  jobID: string
  jobName: string
  sessionID?: string
  firedAt: string
  status: "fired" | "error"
  error?: string
  /** Set when the fire is a catch-up for a slot missed while the server was down. */
  missed?: boolean
}

export type CatchupPolicy = "fire-missed" | "skip-missed"

export interface Lease {
  instanceID: string
  /** Epoch ms. */
  expiresAt: number
}

export const RUN_RING_CAP = 100

/** Next fire for a cron expression, strictly after `from`. Null if invalid. */
export function nextRunISO(expr: string, from: Date): string | null {
  try {
    const scheduler = new Cron(expr, { timezone: "UTC" })
    const next = scheduler.nextRun(from)
    scheduler.stop()
    return next ? next.toISOString() : null
  } catch {
    return null
  }
}

export function isValidCron(expr: string): boolean {
  return nextRunISO(expr, new Date()) !== null
}

export function dueJobs(jobs: CronJob[], now: Date): CronJob[] {
  return jobs.filter((j) => {
    if (!j.enabled || !j.nextRun) return false
    return new Date(j.nextRun).getTime() <= now.getTime()
  })
}

export interface CatchupPlan {
  /** Past-due jobs to fire now (empty under skip-missed). */
  fire: CronJob[]
  /** Full job list with every past-due job's nextRun recomputed from `now`. */
  jobs: CronJob[]
}

export function catchupPlan(jobs: CronJob[], now: Date, policy: CatchupPolicy): CatchupPlan {
  const due = dueJobs(jobs, now)
  const dueIDs = new Set(due.map((j) => j.id))
  const rescheduled = jobs.map((j) => {
    if (!dueIDs.has(j.id)) return j
    return { ...j, nextRun: nextRunISO(j.cronExpr, now) ?? undefined }
  })
  return { fire: policy === "fire-missed" ? due : [], jobs: rescheduled }
}

/** Append an entry, keeping at most RUN_RING_CAP, oldest dropped. */
export function cronRunRing<T>(runs: T[], entry: T, cap = RUN_RING_CAP): T[] {
  return [...runs, entry].slice(-cap)
}

export function leaseAlive(lease: Lease | undefined, instanceID: string, now: number): boolean {
  if (!lease) return false
  if (lease.instanceID !== instanceID) return false
  return now < lease.expiresAt
}
