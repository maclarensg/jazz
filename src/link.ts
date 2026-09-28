import type { Card } from "./board"

/**
 * Pure link logic: the ONLY coupling between the board and the session world
 * (design: cron and board stay decoupled; this module is the bridge).
 */

export type SessionOutcome = "started" | "succeeded" | "failed" | "interrupted"

export const OUTCOME_LANES: Record<SessionOutcome, string> = {
  started: "in_progress",
  succeeded: "done",
  failed: "blocked",
  interrupted: "blocked",
}

export function isTerminalOutcome(outcome: SessionOutcome): boolean {
  return outcome !== "started"
}

/** Target lane for an outcome, or null when the card is already there. */
export function transitionLane(card: Card, outcome: SessionOutcome): string | null {
  const target = OUTCOME_LANES[outcome]
  if (card.lane === target) return null
  return target
}

export interface Link {
  cardID: string
  /** Epoch ms, for debugging staleness. */
  startedAt: number
}

export interface LinkRegistry {
  bind(sessionID: string, cardID: string, startedAt: number): void
  get(sessionID: string): Link | undefined
  /** Returns true when a link existed and was removed. */
  drop(sessionID: string): boolean
  all(): Map<string, Link>
}

/** In-memory session→card registry (links are ephemeral working state). */
export function createLinkRegistry(): LinkRegistry {
  const links = new Map<string, Link>()
  return {
    bind: (sessionID, cardID, startedAt) => {
      links.set(sessionID, { cardID, startedAt })
    },
    get: (sessionID) => links.get(sessionID),
    drop: (sessionID) => links.delete(sessionID),
    all: () => links,
  }
}
