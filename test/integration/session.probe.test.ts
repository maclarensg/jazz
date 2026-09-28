import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { randomUUID } from "node:crypto"
import { startJazzServer, type JazzServer } from "./harness"

vi.setConfig({ testTimeout: 180_000 })

let server: JazzServer

beforeAll(async () => {
  server = await startJazzServer()
})

afterAll(async () => {
  await server?.close()
})

describe("session capability (isolated serve)", () => {
  it("prompts the default model and gets the nonce back", async () => {
    const word = randomUUID().slice(0, 8)
    const session = await server.client.session.create({ title: `probe-${word}` })
    await server.client.session.prompt({
      sessionID: session.id,
      text: `Reply with exactly this word and nothing else: ${word}`,
    })
    await server.client.session.wait({ sessionID: session.id })

    const messages = await server.client.session.context({ sessionID: session.id })
    const assistantText = messages
      .filter((m) => m.type === "assistant")
      .map((m) => JSON.stringify(m))
      .join("\n")
    expect(assistantText).toContain(word)
  })
})
