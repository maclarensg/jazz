// Live capture of session lifecycle events. Run: node scripts/probe-events.mjs
// Records every event.type seen while one real session runs a tiny prompt.
import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const stage = "/tmp/opencode/jazz-it/xdg/opencode/plugins/jazz"
const xdgConfig = path.dirname(path.dirname(path.dirname(stage)))
const dataDir = await mkdtemp(path.join(tmpdir(), "jazz-data-"))
const cwd = await mkdtemp(path.join(tmpdir(), "jazz-it-"))
const port = 37811

const child = spawn("opencode2", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd,
  env: { ...process.env, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})

let boot = {}
child.stdout.on("data", (c) => {
  const t = String(c)
  if (/server listening/.test(t)) boot.listening = true
  const m = t.match(/server password (\S+)/)
  if (m) boot.pw = m[1]
})

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
const base = `http://127.0.0.1:${port}`
const h = { authorization: auth, "content-type": "application/json" }

// subscribe to the SSE stream FIRST
const seen = new Map()
const controller = new AbortController()
const stream = fetch(`${base}/api/event`, { headers: { authorization: auth, accept: "text/event-stream" }, signal: controller.signal })
const recorder = (async () => {
  try {
    const res = await stream
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith("data:")) continue
        try {
          const evt = JSON.parse(line.slice(5).trim())
          if (evt.type?.startsWith("session.")) {
            seen.set(evt.type, (seen.get(evt.type) ?? 0) + 1)
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") console.error("stream error:", e.message)
  }
})()

// run one tiny session
const sres = await fetch(`${base}/api/session`, { method: "POST", headers: h, body: JSON.stringify({ title: "evt-probe" }) })
const sess = await sres.json()
const sid = sess.data?.id ?? sess.id
console.log("session:", sid)
await fetch(`${base}/api/session/${sid}/prompt`, { method: "POST", headers: h, body: JSON.stringify({ text: "Reply with exactly: ok" }) })

// wait for the run to finish (poll session until idle via sse-side effects; simple wait)
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const ctx = await fetch(`${base}/api/session/${sid}/context`, { headers: h }).then((r) => r.json())
  const msgs = ctx.data ?? ctx
  const idle = Array.isArray(msgs) && msgs.some((m) => m.type === "idle")
  if (idle) break
}
await new Promise((r) => setTimeout(r, 2000))
controller.abort()
await recorder
console.log("session event types observed:")
for (const [type, count] of [...seen.entries()].sort()) console.log(`  ${type} x${count}`)
child.kill("SIGKILL")
process.exit(0)
