import { describe, expect, it } from "vitest"
import { createBoard, createCard, DEFAULT_LANES } from "../../src/board"
import {
  createMemoryStorage,
  loadBoard,
  readJson,
  saveBoard,
  StorageError,
  type JsonStorage,
} from "../../src/storage"

describe("storage", () => {
  it("round-trips a board doc through ctx.storage", async () => {
    const storage = createMemoryStorage()
    const { board } = createCard(createBoard(), { title: "nonce-abc" }, () => "c1")
    await saveBoard(storage, board)
    const loaded = await loadBoard(storage)
    expect(loaded).toEqual(board)
  })

  it("returns a fresh default board when the key is missing", async () => {
    const storage = createMemoryStorage()
    const loaded = await loadBoard(storage)
    expect(loaded).toEqual(createBoard())
    expect(Object.keys(loaded.lanes)).toEqual([...DEFAULT_LANES])
  })

  it("loadBoard migrates a persisted v1 board to v2 lanes and card shape", async () => {
    const storage = createMemoryStorage()
    const v1 = {
      cards: {
        a: {
          id: "a",
          title: "old work",
          lane: "backlog",
          created: "2026-09-28T10:00:00.000Z",
          updated: "2026-09-29T11:00:00.000Z",
        },
      },
      lanes: { backlog: ["a"], ready: [], in_progress: [], blocked: [], done: [] },
    }
    await storage.set("board/state", v1)
    const board = await loadBoard(storage)
    expect(Object.keys(board.lanes)).toEqual([
      "triage",
      "backlog",
      "ready",
      "in_progress",
      "blocked",
      "failed",
      "review",
      "done",
      "cancelled",
    ])
    expect(board.cards["a"]!.priority).toBe(2)
    expect(board.cards["a"]!.history).toEqual([
      expect.objectContaining({ kind: "created", ts: "2026-09-28T10:00:00.000Z" }),
    ])
  })

  it("returns undefined from readJson for missing keys", async () => {
    const storage = createMemoryStorage()
    expect(await readJson(storage, "board/state")).toBeUndefined()
  })

  it("rejects a non-object board value with StorageError", async () => {
    const storage = createMemoryStorage()
    await storage.set("board/state", 42)
    await expect(loadBoard(storage)).rejects.toThrowError(StorageError)
  })

  it("rejects a board with a lane entry pointing at a missing card", async () => {
    const storage = createMemoryStorage()
    await storage.set("board/state", {
      cards: {},
      lanes: { backlog: ["ghost"], ready: [], in_progress: [], blocked: [], done: [] },
    })
    await expect(loadBoard(storage)).rejects.toThrowError(StorageError)
  })

  it("rejects a card whose lane is not a known lane", async () => {
    const storage = createMemoryStorage()
    await storage.set("board/state", {
      cards: { c1: { id: "c1", title: "x", lane: "nowhere", created: "t", updated: "t" } },
      lanes: { backlog: [], ready: [], in_progress: [], blocked: [], done: [] },
    })
    await expect(loadBoard(storage)).rejects.toThrowError(StorageError)
  })

  it("memory storage stores and returns the same reference-free value", async () => {
    const storage: JsonStorage = createMemoryStorage()
    await storage.set("k", { a: 1 })
    expect(await storage.get("k")).toEqual({ a: 1 })
  })
})
