import type { Card } from "./board"

/**
 * Pure link logic: the ONLY coupling between the board and the session world
 * (design: cron and board stay decoupled; this module is the bridge).
 *
 * v2 semantics (docs/design/v2-orchestrator.md §2):
 * - a worker's exit code is not a verdict — success without `submit_review`
 *   returns the card to ready, and the second consecutive such exit fails it
 * - failure is not stuck: session failures go to `failed`, not `blocked`
 * - once a card reaches review or a terminal lane, session outcomes leave it
 *   alone — review is Gavin's verdict gate
 */

export type SessionOutcome = "started" | "succeeded" | "failed" | "interrupted"

/** History detail marker for "the worker session ended without submit_review". */
export const EXIT_NO_SUBMIT = "worker exited without submitting"

export const OUTCOME_LANES: Record<SessionOutcome, string> = {
  started: "in_progress",
  succeeded: "ready",
  failed: "failed",
  interrupted: "failed",
}

export function isTerminalOutcome(outcome: SessionOutcome): boolean {
  return outcome !== "started"
}

/** Lanes from which agent tools may act on a card. Review/terminal/failed are Gavin's. */
export function reviewGuard(lane: string): boolean {
  return lane === "triage" || lane === "backlog" || lane === "ready" || lane === "in_progress"
}

/**
 * Count trailing no-submit exits in history. Comments do not break the run
 * (a human remark between two bail-outs doesn't reset the worker's streak);
 * any other lifecycle entry (assignment, move, review…) does.
 */
export function noSubmitStreak(card: Card): number {
  let streak = 0
  for (let i = card.history.length - 1; i >= 0; i--) {
    const entry = card.history[i]!
    if (entry.kind === "comment") continue
    if (entry.kind === "exit" && entry.detail === EXIT_NO_SUBMIT) {
      streak++
      continue
    }
    break
  }
  return streak
}

/** Target lane for an outcome, or null when the card should not move. */
export function transitionLane(card: Card, outcome: SessionOutcome): string | null {
  // Review and terminal lanes belong to Gavin — no session outcome touches them.
  if (card.lane === "review" || card.lane === "done" || card.lane === "cancelled") return null
  if (outcome === "started") return card.lane === "in_progress" ? null : "in_progress"
  if (outcome === "succeeded") {
    if (card.lane === "failed") return null // already failed; awaits Gavin's r/x
    const target = noSubmitStreak(card) >= 1 ? "failed" : "ready"
    return card.lane === target ? null : target
  }
  // failed | interrupted
  return card.lane === "failed" ? null : "failed"
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
