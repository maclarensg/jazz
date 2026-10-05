import { describe, expect, it } from "vitest"

describe("server plugin entrypoint", () => {
  it("imports the actual deployed entrypoint without compilation errors", async () => {
    // Helper-only tests missed duplicate setup declarations in the watchdog
    // change: those tests passed while OpenCode could not load Jazz at all.
    const { default: plugin } = await import("../../index")
    expect(plugin.id).toBe("opencode-jazz")
    expect(plugin.setup).toBeTypeOf("function")
  })
})
