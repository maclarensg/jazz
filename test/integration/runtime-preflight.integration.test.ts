import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { foundationNamespace, startFoundationServer } from "./foundation-harness"

describe("installed-runtime execution prerequisites (inference-free)", () => {
  it("caller IDs are first-write-wins, including conflicting replay; metadata alone is not unique", async () => {
    const root = await foundationNamespace()
    const server = await startFoundationServer(root)
    const nonce = randomBytes(12).toString("hex")
    const id = "ses_" + randomBytes(16).toString("hex")
    try {
      const create = { id, title: nonce, metadata: { nonce } }
      const first = await server.call("POST", "/api/session", create)
      expect(first).toMatchObject({ status: 200, body: { data: { id, title: nonce, metadata: { nonce } } } })
      expect(await server.call("POST", "/api/session", create)).toEqual(first)
      expect(await server.call("POST", "/api/session", { ...create, title: "conflict", metadata: { nonce: "conflict" } })).toEqual(first)
      const concurrentID = "ses_" + randomBytes(16).toString("hex")
      const concurrent = await Promise.all(Array.from({ length: 4 }, () => server.call("POST", "/api/session", { ...create, id: concurrentID })))
      for (const result of concurrent) expect(result).toMatchObject({ status: 200, body: { data: { id: concurrentID } } })
      const duplicated = await Promise.all(Array.from({ length: 2 }, () => server.call("POST", "/api/session", { title: nonce, metadata: { nonce } })))
      expect((duplicated[0]!.body as { data: { id: string } }).data.id).not.toBe((duplicated[1]!.body as { data: { id: string } }).data.id)
      console.log(`runtime creation nonce=${nonce} root=${root}; replay/conflict preserve first record; concurrent calls=4; metadata records=2`)
    } finally { await server.close() }
  }, 45000)

  it("foreground idle and interrupt are not owned shell-child termination evidence", async () => {
    const root = await foundationNamespace()
    const server = await startFoundationServer(root)
    const nonce = randomBytes(12).toString("hex")
    const id = "ses_" + randomBytes(16).toString("hex")
    const marker = path.join(root, "workspace/marker.txt")
    const pidFile = path.join(root, "workspace/child.pid")
    const script = path.join(root, "workspace/owned-child.cjs")
    let childPID: number | undefined
    let shell: Promise<unknown> | undefined
    try {
      await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));fs.writeFileSync(${JSON.stringify(marker)},${JSON.stringify(nonce + "\n")});const timer=setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'tick\\n'),75);setTimeout(()=>{clearInterval(timer);process.exit(0)},3000);`)
      expect(await server.call("POST", "/api/session", { id, title: nonce })).toMatchObject({ status: 200 })
      shell = server.call("POST", `/api/session/${id}/shell`, { command: `node '${script}'` })
      // Attach rejection handling immediately while waiting for the nonce child.
      shell = shell.then((result) => result, (error) => ({ requestError: String(error) }))
      for (let attempt = 0; attempt < 80; attempt++) {
        try { childPID = Number(await readFile(pidFile, "utf8")); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(childPID).toBeGreaterThan(0)
      expect(await readFile(marker, "utf8")).toContain(nonce)
      process.kill(childPID!, 0)
      expect(await server.call("GET", "/api/session/active")).toMatchObject({ status: 200, body: { data: {} } })
      expect(await server.call("POST", `/api/experimental/session/${id}/wait`)).toMatchObject({ status: 204 })
      expect(await server.call("POST", `/api/session/${id}/interrupt`)).toMatchObject({ status: 200, body: { interrupted: false } })
      const before = (await readFile(marker)).length
      await new Promise((resolve) => setTimeout(resolve, 250))
      process.kill(childPID!, 0)
      const growth = (await readFile(marker)).length - before
      expect(growth).toBeGreaterThan(0)
      expect(await shell).toMatchObject({ status: 204 })
      // The bounded owned child has now naturally exited; no orphan remains.
      expect(() => process.kill(childPID!, 0)).toThrow()
      console.log(`runtime child nonce=${nonce} pid=${childPID} root=${root}; idle/wait/interrupt did not stop child; marker grew ${growth} bytes; child exited`)
    } finally {
      if (childPID) {
        try { process.kill(childPID, 0); process.kill(childPID, "SIGTERM") }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
      }
      await shell
      await server.close()
    }
  }, 45000)
})
