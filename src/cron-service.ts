import { cronRunRing, isValidCron, nextRunISO, type CronJob, type CronRun, type Lease } from "./cron"
import type { JsonStorage } from "./storage"

export class CronError extends Error {
  constructor(
    public code: "invalid-cron" | "unknown-job",
    message: string,
  ) {
    super(message)
  }
}

export interface CronUpsertInput {
  name: string
  cronExpr: string
  prompt: string
  agent?: string
  enabled?: boolean
  allowNotify?: boolean
}

export const JOBS_KEY = "cron/jobs"
export const RUNS_KEY = "cron/runs"
export const LEASE_KEY = "cron/leader"

export interface CronServiceDeps {
  idgen?: () => string
  now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateJobs(value: unknown): CronJob[] {
  if (!Array.isArray(value)) throw new Error("cron jobs doc is not an array")
  return value.map((raw) => {
    if (!isRecord(raw)) throw new Error("cron job is not an object")
    for (const field of ["id", "name", "cronExpr", "prompt"] as const) {
      if (typeof raw[field] !== "string") throw new Error(`cron job missing string field ${field}`)
    }
    if (typeof raw.enabled !== "boolean") throw new Error("cron job missing boolean enabled")
    if (raw.allowNotify !== undefined && typeof raw.allowNotify !== "boolean") {
      throw new Error("cron job allowNotify must be a boolean when present")
    }
    return raw as unknown as CronJob
  })
}

/**
 * Storage-backed cron state. Job identity is `name` (upsert replaces by
 * name); ids exist for unambiguous references in runs/events.
 *
 * Public methods serialize through one chain; INTERNALS (raw*) never take the
 * chain, so public methods can compose them freely. A serialized method that
 * awaited another serialized method would deadlock against itself (re-entrant
 * mutex) — that bug shipped once already; the raw* split is the guard.
 */
export function createCronService(storage: JsonStorage, deps: CronServiceDeps = {}) {
  const idgen = deps.idgen ?? (() => crypto.randomUUID().slice(0, 8))
  const now = deps.now ?? (() => new Date())
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn)
    tail = next.catch(() => {})
    return next
  }

  // ---- internals (NO chain) ----
  const rawJobs = async (): Promise<CronJob[]> => {
    const value = await storage.get(JOBS_KEY)
    return value === undefined ? [] : validateJobs(value)
  }
  const rawRuns = async (): Promise<CronRun[]> => {
    const value = await storage.get(RUNS_KEY)
    return Array.isArray(value) ? (value as CronRun[]) : []
  }
  const rawLease = async (): Promise<Lease | undefined> => {
    const value = await storage.get(LEASE_KEY)
    if (!isRecord(value) || typeof value.instanceID !== "string" || typeof value.expiresAt !== "number") {
      return undefined
    }
    return { instanceID: value.instanceID, expiresAt: value.expiresAt }
  }

  // ---- public (chain-serialized) ----
  const service = {
    list(): Promise<CronJob[]> {
      return serialize(rawJobs)
    },

    upsert(input: CronUpsertInput): Promise<CronJob> {
      return serialize(async () => {
        if (!isValidCron(input.cronExpr)) {
          throw new CronError("invalid-cron", `invalid cron expression: ${input.cronExpr}`)
        }
        const jobs = await rawJobs()
        const existing = jobs.find((j) => j.name === input.name)
        const nextAt = nextRunISO(input.cronExpr, now())
        const next: CronJob = {
          id: existing?.id ?? idgen(),
          name: input.name,
          cronExpr: input.cronExpr,
          prompt: input.prompt,
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          enabled: input.enabled ?? existing?.enabled ?? true,
          allowNotify: input.allowNotify ?? existing?.allowNotify ?? true,
          ...(nextAt ? { nextRun: nextAt } : {}),
          ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}),
        }
        const updated = existing ? jobs.map((j) => (j.name === input.name ? next : j)) : [...jobs, next]
        await storage.set(JOBS_KEY, updated)
        return next
      })
    },

    replaceJobs(jobs: CronJob[]): Promise<void> {
      return serialize(() => storage.set(JOBS_KEY, jobs))
    },

    updateJob(
      jobID: string,
      patch: Partial<Pick<CronJob, "lastRun" | "nextRun" | "enabled">>,
    ): Promise<CronJob> {
      return serialize(async () => {
        const jobs = await rawJobs()
        const at = jobs.findIndex((j) => j.id === jobID)
        if (at === -1) throw new CronError("unknown-job", `unknown job: ${jobID}`)
        const updated: CronJob = { ...jobs[at]!, ...patch }
        const next = [...jobs]
        next[at] = updated
        await storage.set(JOBS_KEY, next)
        return updated
      })
    },

    get(jobID: string): Promise<CronJob | undefined> {
      return serialize(async () => (await rawJobs()).find((j) => j.id === jobID))
    },

    remove(jobID: string): Promise<void> {
      return serialize(async () => {
        const jobs = await rawJobs()
        if (!jobs.some((j) => j.id === jobID)) throw new CronError("unknown-job", `unknown job: ${jobID}`)
        await storage.set(JOBS_KEY, jobs.filter((j) => j.id !== jobID))
      })
    },

    readRuns(): Promise<CronRun[]> {
      return serialize(rawRuns)
    },

    appendRun(run: CronRun): Promise<void> {
      return serialize(async () => {
        await storage.set(RUNS_KEY, cronRunRing(await rawRuns(), run))
      })
    },

    readLease(): Promise<Lease | undefined> {
      return serialize(rawLease)
    },

    writeLease(lease: Lease): Promise<void> {
      return serialize(() => storage.set(LEASE_KEY, lease))
    },

    async clearLease(instanceID: string): Promise<void> {
      await serialize(async () => {
        const lease = await rawLease()
        if (lease?.instanceID === instanceID) await storage.remove(LEASE_KEY)
      })
    },
  }
  return service
}
