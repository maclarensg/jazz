import { decisionsFor, normalizeRouting, recordDecision, setOutcome, type RoutingDecision, type RoutingOutcome, type RoutingLog } from "./routing"
import { readJson, writeJson, type JsonStorage } from "./storage"

export const ROUTING_KEY = "jazz/routing"

/** Single-writer routing log service (same pattern as board/inbox services). */
export function createRoutingService(storage: JsonStorage) {
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn)
    tail = next.catch(() => {})
    return next
  }

  const load = async (): Promise<RoutingLog> => normalizeRouting(await readJson(storage, ROUTING_KEY))
  const save = async (log: RoutingLog): Promise<void> => writeJson(storage, ROUTING_KEY, log)

  return {
    record(input: Omit<RoutingDecision, "ts">): Promise<RoutingDecision> {
      return serialize(async () => {
        const log = recordDecision(await load(), input)
        await save(log)
        return log.decisions[log.decisions.length - 1]!
      })
    },

    list(cardID?: string): Promise<RoutingDecision[]> {
      return serialize(async () => {
        const log = await load()
        return cardID ? decisionsFor(log, cardID) : log.decisions
      })
    },

    setOutcome(cardID: string, outcome: RoutingOutcome): Promise<void> {
      return serialize(async () => {
        await save(setOutcome(await load(), cardID, outcome))
      })
    },
  }
}

export type RoutingService = ReturnType<typeof createRoutingService>
