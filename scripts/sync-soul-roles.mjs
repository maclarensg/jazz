#!/usr/bin/env node
/**
 * Sync NeoLilith soul roles (profile/agents/*.md) into the jazz registry as
 * first-class native profiles. Soul entries always win on id collisions.
 *
 *   node scripts/sync-soul-roles.mjs [--soul ~/Workspace/NeoLilith] [--out .]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const SOUL = arg("soul", `${process.env.HOME}/Workspace/NeoLilith`)
const OUT = arg("out", ".")

const ROLE_CATEGORIES = {
  architect: "engineering",
  swe: "engineering",
  "code-reviewer": "qa",
  qa: "qa",
  security: "security",
  "tech-writer": "docs",
  researcher: "research",
  "product-manager": "product",
  artist: "design",
  vision: "general",
  "sre-devops": "ops",
  orchestrator: "general",
}

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null
  const end = text.indexOf("\n---", 3)
  if (end < 0) return null
  const out = {}
  for (const line of text.slice(3, end).split("\n")) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const agentsDir = join(SOUL, "profile", "agents")
let synced = 0
const soulEntries = []
for (const f of readdirSync(agentsDir, { withFileTypes: true })) {
  if (!f.isFile() || !f.name.endsWith(".md")) continue
  const id = f.name.replace(/\.md$/, "")
  const fm = parseFrontmatter(readFileSync(join(agentsDir, f.name), "utf8")) ?? {}
  const name = fm.name ?? id
  let description = (fm.description ?? `${name} role from the NeoLilith soul profile.`).trim()
  if (description.length > 200) description = description.slice(0, 197) + "..."
  const category = ROLE_CATEGORIES[id] ?? "general"
  const entry = {
    id,
    name,
    category,
    tags: ["soul"],
    description,
    source: "soul",
    license: "personal",
    native: true,
    path: `profiles/${category}/${id}.md`,
  }
  soulEntries.push(entry)
  const dir = join(OUT, "profiles", category)
  mkdirSync(dir, { recursive: true })
  cpSync(join(agentsDir, f.name), join(dir, `${id}.md`))
  synced++
}

const registryPath = join(OUT, "registry.json")
let existing = { entries: [] }
try {
  existing = JSON.parse(readFileSync(registryPath, "utf8"))
} catch {
  // fresh registry
}
const merged = [...soulEntries]
for (const e of existing.entries ?? []) if (!merged.some((m) => m.id === e.id)) merged.push(e)
merged.sort((a, b) => (a.id < b.id ? -1 : 1))
writeFileSync(registryPath, JSON.stringify({ entries: merged }, null, 2) + "\n")
console.log(`sync-soul-roles: synced=${synced} registry=${merged.length}`)
