export interface Card {
  id: string
  title: string
  lane: string
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
    public code: "unknown-card" | "unknown-lane",
    message: string,
  ) {
    super(message)
  }
}

export const DEFAULT_LANES = ["backlog", "ready", "in_progress", "blocked", "done"] as const

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

export function createCard(
  board: BoardState,
  input: { title: string; lane?: string },
  idgen: CardIDGen = () => crypto.randomUUID().slice(0, 8),
): { board: BoardState; card: Card } {
  const lane = input.lane ?? "backlog"
  requireLane(board, lane)
  const now = new Date().toISOString()
  const card: Card = { id: idgen(), title: input.title, lane, created: now, updated: now }
  return {
    board: {
      cards: { ...board.cards, [card.id]: card },
      lanes: { ...board.lanes, [lane]: [...board.lanes[lane]!, card.id] },
    },
    card,
  }
}

export function moveCard(board: BoardState, cardID: string, toLane: string, toIndex?: number): BoardState {
  const card = requireCard(board, cardID)
  requireLane(board, toLane)
  const now = new Date().toISOString()
  const updatedCard: Card = { ...card, lane: toLane, updated: now }
  // Same-lane moves work because both entries resolve to the same key and the
  // second assignment wins with the identical array.
  return {
    cards: { ...board.cards, [cardID]: updatedCard },
    lanes: {
      ...board.lanes,
      [card.lane]: board.lanes[card.lane]!.filter((id) => id !== cardID),
      [toLane]: withInserted(board.lanes[toLane]!.filter((id) => id !== cardID), cardID, toIndex),
    },
  }
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
