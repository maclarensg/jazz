import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, mkdir, cp, copyFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = fileURLToPath(new URL("../../", import.meta.url))
export async function foundationNamespace() {
  return mkdtemp("/tmp/opencode/jazz-foundation-it-")
}

/** Owned inference-free runtime. Never copies provider/auth config or discovers the shared service. */
export async function startFoundationServer(root: string, options: { seed?: unknown; legacy?: boolean } = {}) {
  if (!root.startsWith("/tmp/opencode/jazz-foundation-it-")) throw new Error("Unowned integration namespace")
  const plugin = path.join(root, "config/opencode/plugins/jazz")
  await Promise.all([plugin, ...["workspace", "data", "state", "cache"].map((part) => path.join(root, part))]
    .map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })))
  await cp(path.join(REPO, "src"), path.join(plugin, "src"), { recursive: true })
  await copyFile(path.join(REPO, "registry.json"), path.join(plugin, "registry.json"))
  await symlink(path.join(REPO, "node_modules"), path.join(plugin, "node_modules"))
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
  if (options.seed !== undefined) await writeFile(path.join(plugin, "seed.json"), JSON.stringify(options.seed), { mode: 0o600 })
  await writeFile(path.join(plugin, "index.ts"), `
import Jazz from "./src/index.ts"
import { Rpc } from "@opencode/plugin/rpc"
import { readFileSync, existsSync } from "node:fs"
const Probe = Rpc.define({ id: "foundation-fixture", methods: {
  stats: { input: { type: "object" }, output: { type: "object" }, errors: {} },
  tool: { input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, output: { type: "object" }, errors: {} },
}, events: {} })
export default { ...Jazz, async setup(ctx) {
  // Private deployed test fixture only. Production exposes no seed/receipt API.
  const seedPath = ${JSON.stringify(path.join(plugin, "seed.json"))}
  if (existsSync(seedPath) && await ctx.storage.get("fixture/seeded") === undefined) {
    await ctx.storage.set("factory/state/v1", JSON.parse(readFileSync(seedPath, "utf8")))
    await ctx.storage.set("fixture/seeded", true)
  }
  const tools = new Map(); let writes = 0; let runtimeCalls = 0;
  const storage = { ...ctx.storage,
    get: (key) => ctx.storage.get(key),
    set: (key, value) => { writes++; return ctx.storage.set(key, value) },
    remove: (key) => { writes++; return ctx.storage.remove(key) },
  }
  const session = new Proxy(ctx.session, { get(target, key) {
    const value = target[key]; return typeof value === "function" ? (...args) => { runtimeCalls++; return value(...args) } : value
  } })
  const wrapped = { ...ctx, storage, session, options: { ...ctx.options, factory: { mode: ${JSON.stringify(options.legacy ? "legacy" : "foundation")} } },
    tool: { ...ctx.tool, transform: (fn) => ctx.tool.transform((editor) => fn({ ...editor,
      namespace: (...args) => editor.namespace(...args),
      add: (definition) => { tools.set(definition.options.namespace + "_" + definition.name, definition); return editor.add(definition) },
    })) },
  }
  const cleanup = await Jazz.setup(wrapped)
  const registration = await ctx.rpc.register(Probe, {
    stats: async () => ({ writes, runtimeCalls, raw: await ctx.storage.get("factory/state/v1") ?? null,
      legacyBoard: await ctx.storage.get("board/state") ?? null }),
    tool: async ({ name }) => {
      const tool = tools.get(name); if (!tool) return { missing: true }
      try { return { result: await tool.execute({ actor: "gavin" }, { sessionID: "fixture-session", agent: "swe", messageID: "fixture-message", id: "fixture-call", signal: new AbortController().signal }) } }
      catch (error) { return { code: error.code ?? null, message: String(error.message) } }
    },
  })
  return async () => { await registration.dispose(); await cleanup?.() }
} }
`)
  const env: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "TERM"]
    .filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  Object.assign(env, { XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), JAZZ_DISPATCH: "0" })
  const bin = process.env.OPENCODE_BIN ?? "opencode2"
  const db = execFileSync(bin, ["debug", "paths", "db"], { env, cwd: path.join(root, "workspace"), encoding: "utf8" }).trim()
  if (!db.startsWith(root + "/")) throw new Error("Database isolation failed")
  const listener = createServer()
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve) })
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(root, "workspace"), env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let closed = false
  let password = "", log = ""
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  async function close() {
    if (closed) return
    closed = true
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, "SIGTERM") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000) })])
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, "SIGKILL") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
        await exit
      }
    }
    await writeFile(path.join(root, "server-redacted.log"), log)
    try { process.kill(child.pid!, 0) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        console.log(`owned foundation server stopped pid=${child.pid} root=${root}`)
        return
      }
      throw error
    }
    throw new Error(`Owned server ${child.pid} is still alive after cleanup`)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      let listening = false
      const timer = setTimeout(() => reject(new Error("Owned serve did not become ready")), 30000)
      const consume = (chunk: Buffer) => {
        const text = String(chunk); log += text.replace(/server password \S+/g, "server password [REDACTED]")
        listening ||= text.includes("server listening")
        password ||= text.match(/server password (\S+)/)?.[1] ?? ""
        if (listening && password) { clearTimeout(timer); resolve() }
      }
      child.stdout.on("data", consume); child.stderr.on("data", consume)
      child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Owned serve exited ${code}/${signal}`)) })
    })
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000),
      })
      const text = await response.text()
      let value: unknown
      try { value = JSON.parse(text) } catch { value = text }
      return { status: response.status, body: value }
    }
    const info = await call("GET", "/api/info")
    if ((info.body as { pid: number }).pid !== child.pid) throw new Error("Nonce target is not owned server")
    console.log(`owned foundation server pid=${child.pid} version=${(info.body as { version: string }).version} db=${db}`)
    return { root, pid: child.pid!, db, close, call,
      rpc: (method: string, input: unknown = {}) => call("POST", `/api/rpc/jazz/${method}`, { input }),
      fixture: (method: string, input: unknown = {}) => call("POST", `/api/rpc/foundation-fixture/${method}`, { input }),
    }
  } catch (error) { await close(); throw error }
}
