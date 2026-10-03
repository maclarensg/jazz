export type Priority = 0 | 1 | 2 | 3
export type CardSource = "manual" | "cron" | "session" | "requeue"

export type HistoryKind =
  | "created"
  | "moved"
  | "assigned"
  | "handoff"
  | "comment"
  | "review"
  | "routed"
  | "cron"
  | "exit"
  | "note"

export interface HistoryEntry {
  ts: string
  kind: HistoryKind
  actor: string // profile id, "gavin", "cron:<job>", "system"
  from?: string // lane
  to?: string // lane
  detail?: string
}

export interface Comment {
  id: string
  author: string
  body: string
  ts: string
}

export type AssignmentOutcome = "handoff" | "submitted" | "exited" | "failed"

export interface Assignment {
  profile: string // registry id
  sessionID?: string
  startedAt: string
  endedAt?: string
  outcome?: AssignmentOutcome
}

export interface Card {
  id: string
  title: string
  details?: string
  priority: Priority
  lane: string
  /** Registry id of the profile currently working this card (last assignment). */
  profile?: string
  assignments: Assignment[]
  comments: Comment[]
  history: HistoryEntry[]
  source: CardSource
  created: string
  updated: string
}

export interface BoardState {
  cards: Record<string, Card>
  /** Ordered card IDs per lane. Membership and order live here; cards hold a denormalized `lane` for reads. */
  lanes: Record<string, string[]>
}

export class BoardError extends Error {
  constructor(
    public code:
      | "unknown-card"
      | "unknown-lane"
      | "not-archivable"
      | "bad-priority"
      | "bad-source"
      | "bad-comment"
      | "assignment-open"
      | "no-open-assignment"
      | "bad-lane",
    message: string,
  ) {
    super(message)
  }
}

/** v2 canonical lane order. triage is intake; failed is the machine-gave-up lane (only Gavin exits it). */
export const DEFAULT_LANES = [
  "triage",
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "failed",
  "review",
  "done",
  "cancelled",
] as const

export const HISTORY_CAP = 200
export const DEFAULT_PRIORITY: Priority = 2
export const DEFAULT_SOURCE: CardSource = "manual"
/** Lane used by createCard when none is given. */
export const DEFAULT_CREATE_LANE = "triage"

const PRIORITIES: readonly Priority[] = [0, 1, 2, 3]
const SOURCES: readonly CardSource[] = ["manual", "cron", "session", "requeue"]

export function createBoard(lanes: readonly string[] = DEFAULT_LANES): BoardState {
  return { cards: {}, lanes: Object.fromEntries(lanes.map((lane) => [lane, []])) }
}

function requireLane(board: BoardState, lane: string): void {
  if (!(lane in board.lanes)) throw new BoardError("unknown-lane", `unknown lane: ${lane}`)
}

function requireCard(board: BoardState, cardID: string): Card {
  const card = board.cards[cardID]
  if (!card) throw new BoardError("unknown-card", `unknown card: ${cardID}`)
  return card
}

export type CardIDGen = () => string

function now(): string {
  return new Date().toISOString()
}

/** Card replacement that appends a history entry (capped) and bumps `updated`. */
function withHistory(board: BoardState, card: Card, entry: Omit<HistoryEntry, "ts">): BoardState {
  const history = [...card.history, { ...entry, ts: now() }]
  const capped = history.length > HISTORY_CAP ? history.slice(history.length - HISTORY_CAP) : history
  return {
    ...board,
    cards: { ...board.cards, [card.id]: { ...card, history: capped, updated: now() } },
  }
}

export function createCard(
  board: BoardState,
  input: {
    title: string
    lane?: string
    details?: string
    priority?: Priority
    source?: CardSource
    actor?: string
  },
  idgen: CardIDGen = () => crypto.randomUUID().slice(0, 8),
): { board: BoardState; card: Card } {
  if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) {
    throw new BoardError("bad-priority", `priority must be one of 0..3, got ${String(input.priority)}`)
  }
  if (input.source !== undefined && !SOURCES.includes(input.source)) {
    throw new BoardError("bad-source", `source must be one of ${SOURCES.join("|")}, got ${String(input.source)}`)
  }
  const lane = input.lane ?? DEFAULT_CREATE_LANE
  requireLane(board, lane)
  const ts = now()
  const card: Card = {
    id: idgen(),
    title: input.title,
    ...(input.details !== undefined ? { details: input.details } : {}),
    priority: input.priority ?? DEFAULT_PRIORITY,
    lane,
    assignments: [],
    comments: [],
    history: [{ ts, kind: "created", actor: input.actor ?? "system", to: lane }],
    source: input.source ?? DEFAULT_SOURCE,
    created: ts,
    updated: ts,
  }
  return {
    board: {
      cards: { ...board.cards, [card.id]: card },
      lanes: { ...board.lanes, [lane]: [...board.lanes[lane]!, card.id] },
    },
    card,
  }
}

/**
 * Lanes where an open assignment cannot persist: review is Gavin's verdict
 * gate, and blocked/failed/done/cancelled are outside the work lifecycle —
 * the complement of reviewGuard's workable set, so a worker claim only makes
 * sense while the card sits in a lane an agent can act on. moveCard auto-
 * closes any open assignment entering one of these lanes (2026-10-03:
 * done-lane 6787f497 carried a dangling open assignment — its session had
 * failed one second in, and every later move preserved the row).
 */
export const NO_WORKER_LANES: readonly string[] = ["review", "blocked", "failed", "done", "cancelled"]

/**
 * Move (or reorder) a card. A lane *change* appends a `moved` history entry;
 * a same-lane reorder only bumps `updated`.
 */
export function moveCard(
  board: BoardState,
  cardID: string,
  toLane: string,
  toIndex?: number,
  opts: { actor?: string } = {},
): BoardState {
  const card = requireCard(board, cardID)
  requireLane(board, toLane)
  const laneChange = card.lane !== toLane
  let next: BoardState = {
    cards: { ...board.cards, [cardID]: { ...card, lane: toLane, updated: now() } },
    lanes: {
      ...board.lanes,
      [card.lane]: board.lanes[card.lane]!.filter((id) => id !== cardID),
      [toLane]: withInserted(board.lanes[toLane]!.filter((id) => id !== cardID), cardID, toIndex),
    },
  }
  if (laneChange) {
    next = withHistory(next, next.cards[cardID]!, {
      kind: "moved",
      actor: opts.actor ?? "system",
      from: card.lane,
      to: toLane,
    })
  }
  // Assignment hygiene: a lane change into a no-worker lane auto-closes any
  // open assignment (outcome "exited") — callers that forget endAssignment
  // (TUI moves, move_card, review.decide, session outcomes) must not leave a
  // dead session's claim riding into Gavin's lanes.
  if (laneChange && NO_WORKER_LANES.includes(toLane) && next.cards[cardID]!.assignments.some((a) => a.endedAt === undefined)) {
    next = endAssignment(next, cardID, "exited", {
      actor: opts.actor ?? "system",
      detail: `auto-closed on move to ${toLane}`,
    })
  }
  return next
}

function withInserted(ids: string[], id: string, index?: number): string[] {
  const next = [...ids]
  const at = index === undefined ? next.length : Math.max(0, Math.min(index, next.length))
  next.splice(at, 0, id)
  return next
}

export function removeCard(board: BoardState, cardID: string): BoardState {
  const card = requireCard(board, cardID)
  const cards = { ...board.cards }
  delete cards[cardID]
  return {
    cards,
    lanes: { ...board.lanes, [card.lane]: board.lanes[card.lane]!.filter((id) => id !== cardID) },
  }
}

// ---- archive ----

/** Terminal-outcome lanes whose cards may be stashed into the archive. */
export const ARCHIVABLE_LANES = ["done", "cancelled"] as const
export const ARCHIVE_CAP = 500

/** A full card snapshot plus the moment it left the board. */
export interface ArchivedCard extends Card {
  archivedAt: string
}

/** The archive store: insertion order, capped to the newest ARCHIVE_CAP cards. */
export interface ArchiveDoc {
  order: string[]
  cards: Record<string, ArchivedCard>
}

export function createArchive(): ArchiveDoc {
  return { order: [], cards: {} }
}

/**
 * Stash every card in an archivable lane (done|cancelled) out of the board.
 * Each card's history records where it was archived from; the caller owns
 * merging the returned cards into the archive doc.
 */
export function archiveLane(
  board: BoardState,
  lane: string,
  opts: { actor?: string } = {},
): { board: BoardState; archived: Card[] } {
  requireLane(board, lane)
  if (!(ARCHIVABLE_LANES as readonly string[]).includes(lane)) {
    throw new BoardError("not-archivable", `only ${ARCHIVABLE_LANES.join("|")} can be archived, not ${lane}`)
  }
  const ids = [...board.lanes[lane]!]
  const ts = now()
  const archived: Card[] = ids.map((id) => {
    const card = requireCard(board, id)
    const history = [...card.history, { kind: "note" as const, actor: opts.actor ?? "system", detail: `archived from ${lane}`, ts }]
    const capped = history.length > HISTORY_CAP ? history.slice(history.length - HISTORY_CAP) : history
    return { ...card, history: capped, updated: ts }
  })
  const cards = { ...board.cards }
  for (const id of ids) delete cards[id]
  return { board: { cards, lanes: { ...board.lanes, [lane]: [] } }, archived }
}

/** Merge archived cards into the doc: ids dedupe in place, cap keeps the newest. */
export function mergeArchive(doc: ArchiveDoc, archived: readonly Card[], ts: string): ArchiveDoc {
  const cards: Record<string, ArchivedCard> = { ...doc.cards }
  const order = [...doc.order]
  for (const card of archived) {
    cards[card.id] = { ...card, archivedAt: ts }
    if (!order.includes(card.id)) order.push(card.id)
  }
  if (order.length > ARCHIVE_CAP) {
    const keep = order.slice(order.length - ARCHIVE_CAP)
    for (const id of Object.keys(cards)) if (!keep.includes(id)) delete cards[id]
    return { order: keep, cards }
  }
  return { order, cards }
}

export function listLane(board: BoardState, lane: string): Card[] {
  requireLane(board, lane)
  return board.lanes[lane]!.map((id) => board.cards[id]!)
}

export function addComment(
  board: BoardState,
  cardID: string,
  input: { author: string; body: string },
  idgen: CardIDGen = () => crypto.randomUUID().slice(0, 8),
): { board: BoardState; comment: Comment } {
  const card = requireCard(board, cardID)
  if (typeof input.body !== "string" || input.body.trim() === "") {
    throw new BoardError("bad-comment", "comment body must be a non-blank string")
  }
  if (typeof input.author !== "string" || input.author.trim() === "") {
    throw new BoardError("bad-comment", "comment author must be a non-blank string")
  }
  const comment: Comment = { id: idgen(), author: input.author, body: input.body, ts: now() }
  const withComment: Card = { ...card, comments: [...card.comments, comment] }
  const next = withHistory(board, withComment, { kind: "comment", actor: input.author, detail: input.body })
  return { board: next, comment }
}

export function startAssignment(
  board: BoardState,
  cardID: string,
  profile: string,
  opts: { sessionID?: string; actor?: string } = {},
): BoardState {
  const card = requireCard(board, cardID)
  if (card.assignments.some((a) => a.endedAt === undefined)) {
    throw new BoardError("assignment-open", `card ${cardID} already has an open assignment`)
  }
  const withAssignment: Card = {
    ...card,
    profile,
    assignments: [...card.assignments, { profile, startedAt: now(), ...(opts.sessionID ? { sessionID: opts.sessionID } : {}) }],
  }
  return withHistory(board, withAssignment, {
    kind: "assigned",
    actor: opts.actor ?? "system",
    detail: profile,
  })
}

export function endAssignment(
  board: BoardState,
  cardID: string,
  outcome: AssignmentOutcome,
  opts: { actor?: string; detail?: string } = {},
): BoardState {
  const card = requireCard(board, cardID)
  const open = card.assignments.find((a) => a.endedAt === undefined)
  if (!open) throw new BoardError("no-open-assignment", `card ${cardID} has no open assignment`)
  const ended = { ...open, endedAt: now(), outcome }
  const withEnded: Card = {
    ...card,
    assignments: card.assignments.map((a) => (a === open ? ended : a)),
  }
  return withHistory(board, withEnded, {
    kind: outcome === "handoff" ? "handoff" : "exit",
    actor: opts.actor ?? "system",
    detail: opts.detail ?? `${open.profile}: ${outcome}`,
  })
}

/**
 * Lanes where profile routing is legal. Routing sets the NEXT profile for a
 * card; once a card leaves the routing lanes the lifecycle (assignment, review,
 * terminal states) owns it — a concurrent router must not rewrite it.
 */
export const ROUTABLE_LANES: readonly string[] = ["triage", "ready"]

/**
 * Set the next profile for a card (triage assignment or handoff target).
 * Does NOT open an assignment — that happens when a worker session starts
 * (kanban_work). Records a `routed` history entry; optionally retunes priority.
 *
 * Guards (same discipline as startAssignment):
 * - refuses when the card has an open assignment — a live worker owns the
 *   profile field; routing over it is the 2026-10-03 fc0a2fb6 incident
 *   (a sweep routed sre-devops over a running tooling-engineer assignment)
 * - refuses outside triage/ready — only the routing lanes accept new profiles;
 *   handoff closes the assignment and returns the card to ready before routing
 */
export function assignProfile(
  board: BoardState,
  cardID: string,
  profile: string,
  opts: { actor?: string; priority?: Priority } = {},
): BoardState {
  const card = requireCard(board, cardID)
  if (card.assignments.some((a) => a.endedAt === undefined)) {
    throw new BoardError("assignment-open", `card ${cardID} has an open assignment — end it (handoff/exit) before routing a new profile`)
  }
  if (!ROUTABLE_LANES.includes(card.lane)) {
    throw new BoardError("bad-lane", `card ${cardID} is in ${card.lane} — profiles route only in triage/ready`)
  }
  const next: Card = {
    ...card,
    profile,
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
  }
  return withHistory(board, next, { kind: "routed", actor: opts.actor ?? "system", detail: profile })
}

/**
 * Upgrade a persisted board to the current shape:
 * - add missing target lanes in canonical order (custom lanes keep their relative order, appended last)
 * - backfill v2 card fields (priority, source, assignments, comments, history)
 * Idempotent: migrating an already-current board is a no-op.
 */
export function migrateBoard(state: BoardState, target: readonly string[] = DEFAULT_LANES): BoardState {
  const laneNames = [...target]
  for (const lane of Object.keys(state.lanes)) {
    if (!laneNames.includes(lane)) laneNames.push(lane)
  }
  const lanes: Record<string, string[]> = {}
  for (const lane of laneNames) lanes[lane] = state.lanes[lane] ?? []

  const cards: Record<string, Card> = {}
  for (const [id, card] of Object.entries(state.cards)) {
    const assignments = card.assignments ?? []
    cards[id] = {
      ...card,
      priority: card.priority ?? DEFAULT_PRIORITY,
      assignments,
      comments: card.comments ?? [],
      history:
        card.history && card.history.length > 0
          ? card.history
          : [{ ts: card.created, kind: "created", actor: "system", to: card.lane, detail: "backfilled from v1" }],
      source: card.source ?? DEFAULT_SOURCE,
      ...(card.profile === undefined && assignments.length > 0
        ? { profile: assignments[assignments.length - 1]!.profile }
        : {}),
    }
  }
  return { cards, lanes }
}
