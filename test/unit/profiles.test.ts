import { describe, expect, it } from "vitest"
import {
  CATEGORIES,
  profileSearchBlob,
  searchProfiles,
  topCandidates,
  validateRegistry,
  type RegistryEntry,
} from "../../src/profiles"

const entry = (id: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id,
  name: id.replace(/-/g, " "),
  category: "engineering",
  tags: [],
  description: `${id} does useful work when you need it done well.`,
  source: "test",
  license: "MIT",
  native: false,
  path: `profiles/engineering/${id}.md`,
  ...over,
})

describe("validateRegistry", () => {
  it("accepts a well-formed registry", () => {
    const entries = validateRegistry([entry("swe-backend"), entry("qa-core", { category: "qa" })])
    expect(entries).toHaveLength(2)
  })

  it("rejects duplicate ids", () => {
    expect(() => validateRegistry([entry("dup"), entry("dup")])).toThrowError(/duplicate/i)
  })

  it("rejects malformed ids", () => {
    expect(() => validateRegistry([entry("Bad_ID")])).toThrowError(/id/i)
    expect(() => validateRegistry([entry("")])).toThrowError(/id/i)
  })

  it("rejects non-canonical categories", () => {
    expect(() => validateRegistry([entry("x", { category: "coding" })])).toThrowError(/category/i)
  })

  it("rejects too-short descriptions (routing corpus quality bar)", () => {
    expect(() => validateRegistry([entry("x", { description: "too short" })])).toThrowError(/description/i)
  })
})

describe("searchProfiles", () => {
  const entries = [
    entry("backend-engineer", { tags: ["api", "typescript"], description: "Builds server APIs and backend services end to end." }),
    entry("qa-core", { category: "qa", description: "Tests features adversarially and writes regression suites." }),
    entry("security-reviewer", { category: "security", description: "Reviews changes for security holes and threats." }),
  ]

  it("matches on name, tags, and description, case-insensitively", () => {
    expect(searchProfiles(entries, { q: "API" }).map((e) => e.id)).toEqual(["backend-engineer"])
    expect(searchProfiles(entries, { q: "regression" }).map((e) => e.id)).toEqual(["qa-core"])
  })

  it("filters by category", () => {
    expect(searchProfiles(entries, { category: "security" }).map((e) => e.id)).toEqual(["security-reviewer"])
  })

  it("returns everything for an empty query", () => {
    expect(searchProfiles(entries, {})).toHaveLength(3)
  })
})

describe("topCandidates", () => {
  const entries = [
    entry("backend-engineer", { description: "Fix flaky API backend server bugs in typescript services." }),
    entry("qa-core", { category: "qa", description: "Writes tests for flaky failing CI pipelines and regressions." }),
    entry("brand-designer", { category: "design", description: "Designs logos, brand identity, and marketing visuals." }),
  ]

  const card = { title: "fix flaky CI test in api service", details: "pipeline fails on backend tests" }

  it("ranks keyword-overlapping profiles above irrelevant ones", () => {
    const ranked = topCandidates(card, entries)
    expect(ranked[0]!.id).not.toBe("brand-designer")
    expect(ranked.map((e) => e.id)).toContain("qa-core")
    expect(ranked.map((e) => e.id)).toContain("backend-engineer")
    expect(ranked.map((e) => e.id)).not.toContain("brand-designer")
  })

  it("caps the candidate list at the Laya choice limit (16)", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      entry(`p${i}`, { description: `general task worker variant ${i} handles assorted jobs` }),
    )
    expect(topCandidates({ title: "general task to handle" }, many)).toHaveLength(16)
  })

  it("scopes to a category when given", () => {
    const ranked = topCandidates(card, entries, { category: "qa" })
    expect(ranked).toHaveLength(1)
    expect(ranked[0]!.id).toBe("qa-core")
  })

  it("profileSearchBlob lowercases name, description, and tags", () => {
    expect(profileSearchBlob(entry("X", { tags: ["TAG"], description: "Desc" }))).toContain("tag")
  })
})

describe("CATEGORIES", () => {
  it("stays within the Laya stage-1 choice limit", () => {
    expect(CATEGORIES.length).toBeLessThanOrEqual(16)
    expect(CATEGORIES).toContain("engineering")
    expect(CATEGORIES).toContain("qa")
  })
})
