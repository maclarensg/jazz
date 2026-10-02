import { describe, expect, it } from "vitest"
import { archiveLane, ARCHIVE_CAP, ARCHIVABLE_LANES, createBoard, createCard, moveCard } from "../../src/board"
import { createArchive, mergeArchive, type ArchiveDoc } from "../../src/board"

const id = (() => { let n = 0; return () => `c${++n}` })()

function boardWithDone(count: number) {
  let out = createBoard()
  const made: ReturnType<typeof createCard>[] = []
  for (let i = 0; i < count; i++) {
    const r = createCard(out, { title: `done ${i}` }, id)
    out = r.board
    made.push(r)
  }
  for (const m of made) out = moveCard(out, m.card.id, "done")
  return { board: out, ids: made.map((m) => m.card.id) }
}

describe("archiveLane", () => {
  it("done and cancelled are the archivable lanes", () => {
    expect([...ARCHIVABLE_LANES]).toEqual(["done", "cancelled"])
  })

  it("stashes all cards from done, empties the lane, stamps history", () => {
    const { board, ids } = boardWithDone(2)
    const { board: next, archived } = archiveLane(board, "done", { actor: "gavin" })
    expect(next.lanes.done).toEqual([])
    expect(next.cards[ids[0]!]).toBeUndefined()
    expect(next.cards[ids[1]!]).toBeUndefined()
    expect(archived.map((c) => c.id)).toEqual(ids)
    const h = archived[0]!.history.at(-1)
    expect(h).toMatchObject({ kind: "note", actor: "gavin", detail: "archived from done" })
  })

  it("archiving an empty lane is a valid no-op returning zero cards", () => {
    const { board: next, archived } = archiveLane(createBoard(), "cancelled")
    expect(archived).toEqual([])
    expect(next.lanes.cancelled).toEqual([])
  })

  it("refuses lanes outside the archive policy", () => {
    expect(() => archiveLane(createBoard(), "triage")).toThrowError(/not archivable|archive/i)
  })

  it("refuses unknown lanes", () => {
    expect(() => archiveLane(createBoard(), "mordor")).toThrowError(/unknown lane/i)
  })
})

describe("archive doc", () => {
  it("createArchive is empty; mergeArchive appends in order and dedupes by id", () => {
    const { board, ids } = boardWithDone(2)
    const { archived } = archiveLane(board, "done", { actor: "gavin" })
    let doc: ArchiveDoc = createArchive()
    doc = mergeArchive(doc, archived, "2026-10-02T00:00:00.000Z")
    expect(doc.order).toEqual(ids)
    expect(Object.keys(doc.cards).sort()).toEqual([...ids].sort())
    // re-merging the same cards must not duplicate
    doc = mergeArchive(doc, archived, "2026-10-02T00:00:01.000Z")
    expect(doc.order).toEqual(ids)
  })

  it("stamps archivedAt on each card", () => {
    const { board } = boardWithDone(1)
    const { archived } = archiveLane(board, "done", { actor: "gavin" })
    const doc = mergeArchive(createArchive(), archived, "2026-10-02T05:00:00.000Z")
    expect(doc.cards[archived[0]!.id]!.archivedAt).toBe("2026-10-02T05:00:00.000Z")
  })

  it("caps the archive at ARCHIVE_CAP keeping the newest", () => {
    const { board } = boardWithDone(3)
    const { archived } = archiveLane(board, "done", { actor: "gavin" })
    let doc = createArchive()
    for (let i = 0; i < Math.ceil((ARCHIVE_CAP + 1) / 3); i++) {
      doc = mergeArchive(doc, archived.map((c) => ({ ...c, id: `${c.id}#${i}` })), `2026-10-02T00:00:${String(i).padStart(2, "0")}.000Z`)
    }
    expect(doc.order.length).toBeLessThanOrEqual(ARCHIVE_CAP)
    expect(doc.order).not.toContain("c1#0")
  })
})
