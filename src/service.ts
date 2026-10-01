import {
  addComment,
  assignProfile,
  BoardError,
  createCard,
  endAssignment,
  moveCard,
  removeCard,
  startAssignment,
  type AssignmentOutcome,
  type BoardState,
  type Card,
  type CardIDGen,
  type Priority,
} from "./board"
import { loadBoard, saveBoard, type JsonStorage } from "./storage"

export interface BoardService {
  get(): Promise<BoardState>
  create(input: {
    title: string
    lane?: string
    details?: string
    priority?: Card["priority"]
    source?: Card["source"]
    actor?: string
  }): Promise<Card>
  move(input: { cardID: string; lane: string; index?: number; actor?: string }): Promise<Card>
  remove(input: { cardID: string }): Promise<void>
  comment(input: { cardID: string; author: string; body: string }): Promise<Card>
  assign(input: { cardID: string; profile: string; actor?: string; priority?: Priority }): Promise<Card>
  startWork(input: { cardID: string; profile?: string; sessionID?: string; actor?: string }): Promise<Card>
  endWork(input: { cardID: string; outcome: AssignmentOutcome; actor?: string; detail?: string }): Promise<Card>
}

export interface BoardServiceOptions {
  /** Lanes used when the board doc does not exist yet (fresh storage). */
  lanes?: readonly string[]
  idgen?: CardIDGen
  /** Called after every successful lane change (card, fromLane). */
  onMoved?: (card: Card, fromLane: string) => Promise<void> | void
}

/**
 * Single-writer board service. All mutations are serialized through a promise
 * chain: the server is single-process, but tool/RPC handlers interleave, and
 * load→mutate→save must be atomic per operation.
 */
export function createBoardService(storage: JsonStorage, opts: BoardServiceOptions = {}): BoardService {
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn)
    tail = next.catch(() => {})
    return next
  }

  /** Serialized load → pure mutate → save; returns the mutation's value. */
  const mutate = <T>(fn: (board: BoardState) => { board: BoardState; value: T }): Promise<T> =>
    serialize(async () => {
      const board = await loadBoard(storage, opts.lanes)
      const { board: next, value } = fn(board)
      await saveBoard(storage, next)
      return value
    })

  return {
    async get() {
      return loadBoard(storage, opts.lanes)
    },

    create(input) {
      return serialize(async () => {
        const board = await loadBoard(storage, opts.lanes)
        const { board: next, card } = createCard(board, input, opts.idgen)
        await saveBoard(storage, next)
        const from = input.lane ?? "triage"
        await opts.onMoved?.(card, from)
        return card
      })
    },

    move(input) {
      return serialize(async () => {
        const board = await loadBoard(storage, opts.lanes)
        const before = board.cards[input.cardID]
        const next = moveCard(board, input.cardID, input.lane, input.index, { ...(input.actor ? { actor: input.actor } : {}) })
        const card = next.cards[input.cardID]!
        await saveBoard(storage, next)
        if (before && before.lane !== input.lane) await opts.onMoved?.(card, before.lane)
        return card
      })
    },

    remove(input) {
      return serialize(async () => {
        const board = await loadBoard(storage, opts.lanes)
        await saveBoard(storage, removeCard(board, input.cardID))
      })
    },

    comment(input) {
      return mutate((board) => {
        const { board: next } = addComment(board, input.cardID, input)
        return { board: next, value: next.cards[input.cardID]! }
      })
    },

    assign(input) {
      return mutate((board) => {
        const next = assignProfile(board, input.cardID, input.profile, {
          ...(input.actor ? { actor: input.actor } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
        })
        return { board: next, value: next.cards[input.cardID]! }
      })
    },

    startWork(input) {
      return mutate((board) => {
        const next = startAssignment(board, input.cardID, input.profile ?? "worker", {
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
          ...(input.actor ? { actor: input.actor } : {}),
        })
        return { board: next, value: next.cards[input.cardID]! }
      })
    },

    endWork(input) {
      return mutate((board) => {
        const next = endAssignment(board, input.cardID, input.outcome, {
          ...(input.actor ? { actor: input.actor } : {}),
          ...(input.detail ? { detail: input.detail } : {}),
        })
        return { board: next, value: next.cards[input.cardID]! }
      })
    },
  }
}

export { BoardError }
