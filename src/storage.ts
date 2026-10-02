import type { Plugin } from "@opencode/plugin"
import { createArchive, createBoard, migrateBoard, DEFAULT_LANES, type ArchiveDoc, type BoardState, type Card } from "./board"

export class StorageError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/** Minimal structural subset of the plugin StorageDomain we depend on; memory impl and the real one both satisfy it. */
export interface JsonStorage {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export async function readJson(storage: JsonStorage, key: string): Promise<unknown | undefined> {
  return storage.get(key)
}

export async function writeJson(storage: JsonStorage, key: string, value: unknown): Promise<void> {
  await storage.set(key, value)
}

export function createMemoryStorage(): JsonStorage {
  const map = new Map<string, unknown>()
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, structuredClone(value))
    },
    remove: async (key) => {
      map.delete(key)
    },
  }
}

/** The plugin's real StorageDomain satisfies JsonStorage structurally. */
export function asJsonStorage(storage: Plugin.Context["storage"]): JsonStorage {
  return storage as unknown as JsonStorage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateCard(value: unknown, id: string): Card {
  if (!isRecord(value)) throw new StorageError(`card ${id} is not an object`)
  for (const field of ["title", "lane", "created", "updated"] as const) {
    if (typeof value[field] !== "string") throw new StorageError(`card ${id} missing string field ${field}`)
  }
  if (typeof value.id !== "string" || value.id !== id) throw new StorageError(`card ${id} has bad id`)
  // v2 fields are optional on disk (v1 docs predate them); when present they must be sane.
  if (value.priority !== undefined && (typeof value.priority !== "number" || ![0, 1, 2, 3].includes(value.priority))) {
    throw new StorageError(`card ${id} has bad priority`)
  }
  for (const field of ["assignments", "comments", "history"] as const) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new StorageError(`card ${id} field ${field} is not an array`)
    }
  }
  return value as unknown as Card
}

export function validateBoard(value: unknown): BoardState {
  if (!isRecord(value) || !isRecord(value.cards) || !isRecord(value.lanes)) {
    throw new StorageError("board value is not {cards, lanes}")
  }
  const cards: Record<string, Card> = {}
  for (const [id, raw] of Object.entries(value.cards)) cards[id] = validateCard(raw, id)
  const lanes: Record<string, string[]> = {}
  for (const [lane, ids] of Object.entries(value.lanes)) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new StorageError(`lane ${lane} is not a string array`)
    }
    for (const id of ids) {
      if (!(id in cards)) throw new StorageError(`lane ${lane} references missing card ${id}`)
    }
    lanes[lane] = ids
  }
  for (const card of Object.values(cards)) {
    if (!(card.lane in lanes)) throw new StorageError(`card ${card.id} references unknown lane ${card.lane}`)
  }
  return { cards, lanes }
}

export const BOARD_KEY = "board/state"

export async function loadBoard(storage: JsonStorage, defaultLanes?: readonly string[]): Promise<BoardState> {
  const value = await readJson(storage, BOARD_KEY)
  if (value === undefined) return createBoard(defaultLanes)
  // Persisted docs may predate v2 (5 lanes, bare cards) — migrate to current shape on load.
  return migrateBoard(validateBoard(value), defaultLanes ?? DEFAULT_LANES)
}

export async function saveBoard(storage: JsonStorage, board: BoardState): Promise<void> {
  await writeJson(storage, BOARD_KEY, board)
}

export const ARCHIVE_KEY = "board/archive"

/**
 * Archive loads are defensive by design: a corrupted archive doc resolves to
 * an empty archive rather than an error — the archive is a stash of terminal
 * cards and must never brick board operations.
 */
export async function loadArchive(storage: JsonStorage): Promise<ArchiveDoc> {
  const value = await readJson(storage, ARCHIVE_KEY)
  if (value === undefined) return createArchive()
  try {
    return validateArchive(value)
  } catch {
    return createArchive()
  }
}

export async function saveArchive(storage: JsonStorage, doc: ArchiveDoc): Promise<void> {
  await writeJson(storage, ARCHIVE_KEY, doc)
}

function validateArchive(value: unknown): ArchiveDoc {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StorageError("archive value is not a doc")
  const v = value as { order?: unknown; cards?: unknown }
  if (typeof v.cards !== "object" || v.cards === null || Array.isArray(v.cards)) throw new StorageError("archive cards is not a record")
  const rawOrder = Array.isArray(v.order) ? v.order : Object.keys(v.cards)
  const order: string[] = []
  const cards: ArchiveDoc["cards"] = {}
  for (const id of rawOrder) {
    if (typeof id !== "string" || order.includes(id)) continue
    const raw = (v.cards as Record<string, unknown>)[id]
    if (raw === undefined) continue
    const card = validateCard(raw, id)
    const archived = raw as Record<string, unknown>
    if (typeof archived.archivedAt !== "string") continue
    cards[id] = { ...card, archivedAt: archived.archivedAt }
    order.push(id)
  }
  return { order, cards }
}
