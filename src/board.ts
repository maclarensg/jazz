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
      | "bad-priority"
      | "bad-source"
      | "bad-comment"
      | "assignment-open"
      | "no-open-assignment",
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
 * Set the next profile for a card (triage assignment or handoff target).
 * Does NOT open an assignment — that happens when a worker session starts
 * (kanban_work). Records a `routed` history entry; optionally retunes priority.
 */
export function assignProfile(
  board: BoardState,
  cardID: string,
  profile: string,
  opts: { actor?: string; priority?: Priority } = {},
): BoardState {
  const card = requireCard(board, cardID)
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
