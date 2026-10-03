/**
 * Pure dispatch planning: which ready-lane cards should a worker be spawned
 * for, right now. No I/O, no session logic — the service tick owns execution
 * (via work()) and the leader lease owns single-writer safety. The planner
 * only answers "what is dispatchable at time T".
 *
 * Failure containment is borrowed from the existing worker semantics: a
 * dispatched card that exits without submit_review returns to ready and the
 * second consecutive exit sends it to failed — so a re-dispatching dispatcher
 * cannot loop forever on a broken card.
 */
import type { BoardState, Card } from "./board"

export interface DispatchConfig {
  enabled: boolean
  /** Do not re-dispatch a card within this window after its last attempt. */
  cooldownMs: number
  /** Cap on concurrently dispatched (open-assignment) cards. */
  maxInFlight: number
  /** The lane the dispatcher pulls from. */
  lane: string
}

export const DEFAULT_DISPATCH: DispatchConfig = {
  enabled: true,
  cooldownMs: 60_000,
  maxInFlight: 3,
  lane: "ready",
}

/** Per-service-run dispatch memory. Not persisted: a restart may re-dispatch a
 * cooled-down card once, which the open-assignment guard makes harmless. */
export interface DispatchState {
  lastAttempt: Record<string, string>
  inFlight: string[]
}

export function createDispatchState(): DispatchState {
  return { lastAttempt: {}, inFlight: [] }
}

export function recordAttempt(state: DispatchState, cardID: string, ts: string): DispatchState {
  return { lastAttempt: { ...state.lastAttempt, [cardID]: ts }, inFlight: [...state.inFlight] }
}

/** Cards the dispatcher should work right now: priority first, oldest first within a priority.
 * The maxInFlight cap counts every open worker assignment on the board (kanban_work-spawned
 * sessions included) unioned with this service's own in-flight attempts. */
export function dispatchableCards(board: BoardState, state: DispatchState, config: DispatchConfig, now: Date): Card[] {
  if (!config.enabled) return []
  const busy = new Set(state.inFlight)
  for (const card of Object.values(board.cards)) {
    if (card.assignments.some((a) => a.endedAt === undefined)) busy.add(card.id)
  }
  const slots = config.maxInFlight - busy.size
  if (slots <= 0) return []
  const ids = board.lanes[config.lane] ?? []
  const eligible = ids
    .map((id) => board.cards[id])
    .filter((c): c is Card => {
      if (!c) return false
      if (c.assignments.some((a) => a.endedAt === undefined)) return false // already worked
      const last = state.lastAttempt[c.id]
      if (last && now.getTime() - new Date(last).getTime() < config.cooldownMs) return false
      return true
    })
  eligible.sort((a, b) => a.priority - b.priority || a.created.localeCompare(b.created))
  return eligible.slice(0, slots)
}
