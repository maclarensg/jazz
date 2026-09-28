import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import path from "node:path"

import { OpenCode } from "@opencode/client"

import { JazzRpc } from "../../src/rpc"

export interface JazzServer {
  baseUrl: string
  client: ReturnType<typeof OpenCode.make>
  jazz: ReturnType<ReturnType<typeof OpenCode.make>["rpc"]>
  close(): Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      if (address && typeof address === "object") {
        const port = address.port
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error("no port"))
      }
    })
  })
}

/**
 * Boots a real `opencode2 serve` against the staged plugin (isolated
 * XDG_CONFIG_HOME so the daily environment is untouched), discovers the
 * password from stdout, and returns an authed client.
 *
 * Ground truth established empirically (see docs/notes/serve-auth.md):
 *   - auth is HTTP Basic, username `opencode`, password as printed by serve
 *   - the plugin auto-scan loads <config>/plugins/<dir>/index.* (root entry)
 */
export async function startJazzServer(): Promise<JazzServer> {
  const bin = process.env.OPENCODE_BIN ?? "opencode2"
  const stage = process.env.JAZZ_STAGE_DIR ?? "/tmp/opencode/jazz-it/xdg/opencode/plugins/jazz"
  const xdgConfig = path.dirname(path.dirname(path.dirname(stage)))
  const cwd = await mkdtemp(path.join(tmpdir(), "jazz-it-"))
  const port = await freePort()

  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: xdgConfig },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const stderr: string[] = []
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)))

  let password: string | undefined

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let listening = false
    const finish = () => {
      if (listening && password) resolve(`http://127.0.0.1:${port}`)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`serve: no listening+password in 30s. stderr:\n${stderr.join("")}`))
    }, 30_000)

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk)
      if (/server listening/.test(text)) listening = true
      const pw = text.match(/server password (\S+)/)
      if (pw) password = pw[1]
      finish()
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`serve exited early (code ${code}). stderr:\n${stderr.join("")}`))
    })
  })

  const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
  const client = OpenCode.make({ baseUrl, headers: { authorization: auth } })

  return {
    baseUrl,
    client,
    jazz: client.rpc(JazzRpc),
    close: async () => {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => child.on("exit", () => resolve()))
    },
  }
}
