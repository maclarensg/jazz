import {
  BoardError,
  createCard,
  moveCard,
  removeCard,
  type BoardState,
  type Card,
  type CardIDGen,
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
  move(input: { cardID: string; lane: string; index?: number }): Promise<Card>
  remove(input: { cardID: string }): Promise<void>
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
        const next = moveCard(board, input.cardID, input.lane, input.index)
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
  }
}

export { BoardError }
