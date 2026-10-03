import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import path from "node:path"

import { OpenCode } from "@opencode/client"

import { JazzRpc } from "../../src/rpc"

export interface JazzServer {
  baseUrl: string
  dataDir: string
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
export interface JazzServerOptions {
  /**
   * XDG_DATA_HOME for the server. Defaults to a fresh temp dir per server so
   * test runs never inherit stale jobs/cards from the shared data dir or from
   * each other. Pass the SAME dir to two servers to test shared-storage
   * leader election (double-instance).
   */
  dataDir?: string
  /**
   * Enable the card dispatcher. Default false: most tests move cards through
   * ready deliberately and must not race a dispatcher grabbing them. Only the
   * dispatcher integration test turns this on.
   */
  dispatch?: boolean
}

export async function startJazzServer(opts: JazzServerOptions = {}): Promise<JazzServer> {
  const bin = process.env.OPENCODE_BIN ?? "opencode2"
  const stage = process.env.JAZZ_STAGE_DIR ?? "/tmp/opencode/jazz-it/xdg/opencode/plugins/jazz"
  const xdgConfig = path.dirname(path.dirname(path.dirname(stage)))
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(tmpdir(), "jazz-data-")))
  const cwd = await mkdtemp(path.join(tmpdir(), "jazz-it-"))
  const port = await freePort()

  // serve has no --model flag; when the heavy-model pool is dry, patch the
  // staged config instead: JAZZ_TEST_MODEL=zai-coding-plan/glm-5.3-flash
  if (process.env.JAZZ_TEST_MODEL) {
    const cfgPath = path.join(xdgConfig, "opencode", "config", "opencode.json")
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { model?: string }
    cfg.model = process.env.JAZZ_TEST_MODEL
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    console.error(`[harness] test model override: ${cfg.model}`)
  }

  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: dataDir, ...(opts.dispatch ? {} : { JAZZ_DISPATCH: "0" }) },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group: worker teardown must not take the server down with it.
    detached: true,
  })

  const stderr: string[] = []
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)))
  child.on("exit", (code, signal) => {
    // Surfaced late-exits: a serve dying mid-test must not be silent.
    console.error(`[harness] serve on port ${port} exited (code=${code} signal=${signal})\nstderr:\n${stderr.join("")}`)
  })

  let password: string | undefined

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let listening = false
    const finish = () => {
      if (listening && password) {
        clearTimeout(timer)
        console.error(`[harness] serve booted on port ${port} (pid ${child.pid})`)
        resolve(`http://127.0.0.1:${port}`)
      }
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
    dataDir,
    client,
    jazz: client.rpc(JazzRpc),
    close: async () => {
      child.removeAllListeners("exit")
      child.kill("SIGTERM")
      const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()))
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      await Promise.race([exited, timeout])
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGKILL")
        await new Promise<void>((resolve) => child.on("exit", () => resolve()))
      }
    },
  }
}
