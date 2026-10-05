import { describe, expect, it, vi } from "vitest"
import { parseFactoryMode } from "../../src/factory-mode"

describe("explicit factory mode", () => {
  it("leaves omitted or explicit legacy mode unchanged", () => {
    expect(parseFactoryMode(undefined)).toEqual({ mode: "legacy" })
    expect(parseFactoryMode({ mode: "legacy" })).toEqual({ mode: "legacy" })
  })

  it("accepts only a nonexecuting foundation, not caller-supplied prerequisites", () => {
    expect(parseFactoryMode({ mode: "foundation" })).toEqual({ mode: "foundation" })
    expect(parseFactoryMode({ mode: "foundation", namespaceDirectory: "/tmp/opencode/probe/controller" }))
      .toEqual({ mode: "foundation", namespaceDirectory: "/tmp/opencode/probe/controller" })
  })

  it.each([null, true, "foundation", {}, { mode: "factory" }, { mode: "legacy", launch: true },
    { mode: "foundation", verified: true }, { mode: "foundation", human: true },
    { mode: "foundation", namespaceDirectory: "/home/user/live" },
    { mode: "foundation", namespaceDirectory: "/tmp/opencode/../live" }])
  ("invalid configuration never silently falls through to legacy: %j", (config) => {
    expect(() => parseFactoryMode(config)).toThrow()
  })

  it("rejects an invalid mode before touching legacy storage, tools or sessions", async () => {
    const { default: Jazz } = await import("../../src/index")
    const access = vi.fn(() => { throw new Error("legacy accessed") })
    const ctx = { options: { factory: { mode: "typo" } }, storage: new Proxy({}, { get: access }) }
    await expect(Jazz.setup(ctx as never)).rejects.toMatchObject({ name: "ZodError" })
    expect(access).not.toHaveBeenCalled()
  })
})
