// Plain-Node replication of the cron integration flow, to isolate whether the
// serve SIGKILL is vitest-specific. Run: node scripts/probe-cron.mjs
import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const stage = "/tmp/opencode/jazz-it/xdg/opencode/plugins/jazz"
const xdgConfig = path.dirname(path.dirname(path.dirname(stage)))
const dataDir = await mkdtemp(path.join(tmpdir(), "jazz-data-"))
const cwd = await mkdtemp(path.join(tmpdir(), "jazz-it-"))
const port = 37792

const child = spawn("opencode2", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd,
  env: { ...process.env, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})

let boot = {}
child.stdout.on("data", (c) => {
  const t = String(c)
  process.stdout.write(`[serve] ${t}`)
  if (/server listening/.test(t)) boot.listening = true
  const m = t.match(/server password (\S+)/)
  if (m) boot.pw = m[1]
})
child.stderr.on("data", (c) => process.stderr.write(`[serve-err] ${c}`))
child.on("exit", (code, signal) => console.log(`\n[serve] EXITED code=${code} signal=${signal}`))

const auth = await new Promise((resolve, reject) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    if (boot.listening && boot.pw) {
      clearInterval(iv)
      resolve("Basic " + Buffer.from(`opencode:${boot.pw}`).toString("base64"))
    } else if (Date.now() - t0 > 30_000) {
      clearInterval(iv)
      reject(new Error("boot timeout"))
    }
  }, 200)
})
const baseUrl = `http://127.0.0.1:${port}`
const call = async (method, input) => {
  const r = await fetch(`${baseUrl}/api/rpc/jazz/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ input }),
  })
  return r.json()
}

console.log("upsert:", JSON.stringify(await call("cron.upsert", { name: `probe-${Date.now() % 10000}`, cronExpr: "* * * * *", prompt: "Reply with the single word ok and nothing else." })))

for (let i = 0; i < 18; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  try {
    const runs = await call("cron.runs", {})
    console.log(`t=${(i + 1) * 5}s runs=${JSON.stringify(runs).slice(0, 200)}`)
    if (runs.runs && runs.runs.length > 0) { console.log("FIRED"); break }
  } catch (e) {
    console.log(`t=${(i + 1) * 5}s FETCH FAILED: ${e.cause?.code ?? e.message}`)
    break
  }
}
child.kill("SIGKILL")
process.exit(0)
