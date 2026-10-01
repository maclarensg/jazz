/**
 * Pure routing-log logic: every Laya routing decision (2-stage: domain →
 * profile) is recorded with its probabilities, and later stamped with the
 * review outcome — the calibration loop that makes routing quality measurable
 * instead of vibes (docs/design/v2-orchestrator.md §6).
 */

export type RoutingStage = "domain" | "profile"

export type RoutingOutcome = "assigned" | "requeued" | "accepted" | "cancelled"

export interface RoutingDecision {
  cardID: string
  stage: RoutingStage
  picked: string
  probabilities?: Record<string, number>
  confidence?: number
  reason?: string
  ts: string
  outcome?: RoutingOutcome
}

export interface RoutingLog {
  decisions: RoutingDecision[]
}

export const ROUTING_CAP = 500

export function createRoutingLog(): RoutingLog {
  return { decisions: [] }
}

function isRoutingDecision(value: unknown): value is RoutingDecision {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.cardID === "string" &&
    (v.stage === "domain" || v.stage === "profile") &&
    typeof v.picked === "string" &&
    typeof v.ts === "string"
  )
}

export function normalizeRouting(value: unknown): RoutingLog {
  const raw = (value as { decisions?: unknown } | null | undefined)?.decisions
  const valid = Array.isArray(raw) ? raw.filter(isRoutingDecision) : []
  const decisions = valid.length > ROUTING_CAP ? valid.slice(valid.length - ROUTING_CAP) : valid
  return { decisions }
}

export function recordDecision(log: RoutingLog, input: Omit<RoutingDecision, "ts">, ts: string = new Date().toISOString()): RoutingLog {
  const next = [...log.decisions, { ...input, ts }]
  const decisions = next.length > ROUTING_CAP ? next.slice(next.length - ROUTING_CAP) : next
  return { decisions }
}

export function decisionsFor(log: RoutingLog, cardID: string): RoutingDecision[] {
  return log.decisions.filter((d) => d.cardID === cardID)
}

/** Stamp the newest profile-stage decision for a card with its review outcome. */
export function setOutcome(log: RoutingLog, cardID: string, outcome: RoutingOutcome): RoutingLog {
  let stamped = false
  const decisions = [...log.decisions]
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i]!
    if (d.cardID === cardID && d.stage === "profile") {
      decisions[i] = { ...d, outcome }
      stamped = true
      break
    }
  }
  return stamped ? { decisions } : log
}
