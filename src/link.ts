import type { AssignmentOutcome, Card } from "./board"

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
 * Who may submit a card to review (Gavin's verdict gate)?
 *
 * - a worker exits from `in_progress` — the normal submit path, after which
 *   its open assignment is closed;
 * - a cron-sourced monitor card straight from `ready` — monitors never enter
 *   the work lifecycle (no worker claims them); an actionable signal IS the
 *   deliverable, and forcing a fictional in_progress claim makes the daily
 *   submit fail with "card is not in_progress" (seen 2026-10-03, card
 *   3b1e83a2). Everything else stays worker-only.
 */
export function canSubmitReview(card: Pick<Card, "lane" | "source">): boolean {
  if (card.lane === "in_progress") return true
  return card.lane === "ready" && card.source === "cron"
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

/**
 * What the event pump does for a linked session's outcome, as data.
 * Extracted from the pump (index.ts) so the assignment-closure rules are
 * unit-testable; spec'd red in test/unit/link-v2.test.ts (card 36febd0f).
 *
 * Contract: the pump closes the open assignment only on transitions it
 * drives (`target !== null`). Cards Gavin already owns — review/done/
 * cancelled, or already failed — are left alone here; lane ENTRY into those
 * lanes is guarded by moveCard's NO_WORKER_LANES auto-close, so a dead
 * session's claim can never ride into them in the first place (2026-10-03:
 * done-lane 6787f497 carried a debugger assignment whose session had failed
 * one second in).
 */
export interface OutcomePlan {
  /** Lane to move the card to, or null to leave it alone (Gavin's lanes). */
  target: string | null
  /** When set, close the open assignment with this outcome/detail before the move. */
  close: { outcome: AssignmentOutcome; detail: string } | null
  /** When set, append this system comment (the succeeded no-submit bail-out). */
  comment: string | null
}

export function planOutcome(card: Card, outcome: SessionOutcome): OutcomePlan {
  const target = transitionLane(card, outcome)
  if (!target) return { target: null, close: null, comment: null }
  const open = card.assignments.some((a) => a.endedAt === undefined)
  if (outcome === "succeeded") {
    return {
      target,
      close: open ? { outcome: "exited", detail: EXIT_NO_SUBMIT } : null,
      comment: "Worker session ended without submitting for review.",
    }
  }
  if (outcome === "failed" || outcome === "interrupted") {
    return { target, close: open ? { outcome: "failed", detail: `worker session ${outcome}` } : null, comment: null }
  }
  return { target, close: null, comment: null }
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
