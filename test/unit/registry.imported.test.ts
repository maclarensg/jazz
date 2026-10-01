import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CATEGORIES, ID_PATTERN, MIN_DESCRIPTION, MAX_DESCRIPTION, normalizeRegistry, validateRegistry } from "../../src/profiles"

/**
 * Counted assertions over the imported corpus (design §12): these FAIL, not
 * skip, when the import has not been run — the registry is part of delivery.
 * Refresh with: scripts/import-profiles.sh
 */
describe("imported registry (registry.json)", () => {
  const registryPath = new URL("../../registry.json", import.meta.url)

  it("exists — run scripts/import-profiles.sh if this fails", () => {
    expect(existsSync(registryPath)).toBe(true)
  })

  const raw: unknown = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : { entries: [] }
  const entries = normalizeRegistry(raw)

  it("carries at least 200 profiles (curated 200-250 target)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(200)
    expect(entries.length).toBeLessThanOrEqual(260)
  })

  it("has zero duplicate ids and only slug ids", () => {
    const ids = entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(ID_PATTERN.test(id)).toBe(true)
  })

  it("uses only canonical categories", () => {
    for (const e of entries) expect(CATEGORIES).toContain(e.category)
  })

  it("meets the description quality bar (routing corpus)", () => {
    for (const e of entries) {
      expect(e.description.trim().length).toBeGreaterThanOrEqual(MIN_DESCRIPTION)
      expect(e.description.trim().length).toBeLessThanOrEqual(MAX_DESCRIPTION)
    }
  })

  it("every registry path exists on disk with the profile markdown", () => {
    for (const e of entries) {
      expect(existsSync(new URL(`../../${e.path}`, import.meta.url))).toBe(true)
    }
  })

  it("soul roles are present and native", () => {
    const soul = entries.filter((e) => e.source === "soul")
    expect(soul.length).toBeGreaterThanOrEqual(10)
    expect(soul.every((e) => e.native)).toBe(true)
  })

  it("passes full validation", () => {
    expect(() => validateRegistry(entries)).not.toThrow()
  })
})
