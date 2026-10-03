import { describe, expect, it } from "vitest"
import { resolveWorkerAgent } from "../../src/agent-resolve"

const runtime = ["swe", "qa", "code-reviewer"]

describe("resolveWorkerAgent", () => {
  it("passes an undefined profile through untouched (no switch, no note)", () => {
    expect(resolveWorkerAgent(undefined, runtime)).toEqual({})
  })

  it("resolves a profile that names a real runtime agent", () => {
    expect(resolveWorkerAgent("swe", runtime)).toEqual({ agent: "swe" })
  })

  it("falls back with a note when the profile has no runtime agent", () => {
    const r = resolveWorkerAgent("debugger", runtime)
    expect(r.agent).toBeUndefined()
    expect(r.note).toContain("debugger")
    expect(r.note).toContain("swe")
  })

  it("falls back safely when no runtime agents can be enumerated", () => {
    const r = resolveWorkerAgent("swe", [])
    expect(r.agent).toBeUndefined()
    expect(r.note).toMatch(/none/i)
  })
})
