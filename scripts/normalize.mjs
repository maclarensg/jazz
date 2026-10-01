#!/usr/bin/env node
/**
 * Normalize imported agent profiles into the jazz registry.
 *
 *   node scripts/normalize.mjs --root /tmp/opencode/jazz-profiles --out .
 *
 * Reads every .md under <root>/<source-dir>/ (frontmatter: name, description),
 * quality-filters (description 20-200 chars, body ≥ MIN_BODY_LINES lines),
 * maps to canonical categories, dedupes ids, balances to --max entries across
 * categories, then writes <out>/profiles/<category>/<id>.md (original bytes),
 * <out>/registry.json and <out>/import-report.json.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, statSync } from "node:fs"
import { join, basename } from "node:path"

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const ROOT = arg("root", "/tmp/opencode/jazz-profiles")
const OUT = arg("out", ".")
const MAX = Number(arg("max", 240))
const MIN_BODY_LINES = Number(arg("min-body-lines", 20))
const MIN_DESC = 20
const MAX_DESC = 200

const CATEGORY_RULES = [
  ["security", /security|vulnerab|threat|pentest|exploit|compliance/i],
  ["qa", /\bqa\b|test|quality|regression|reviewer|lint/i],
  ["docs", /doc|writer|writing|content|copy|technical writer|readme/i],
  ["data", /data|analyst|analytics|scientist|ml\b|machine learning|llm|statistic|etl|sql/i],
  ["product", /product|requirements|roadmap|\bpm\b|backlog|user research/i],
  ["design", /design|\bui\b|\bux\b|brand|logo|visual|figma|frontend-design/i],
  ["ops", /ops\b|devops|sre\b|infra|deploy|kubernetes|k8s|terraform|cloud|monitor|incident/i],
  ["marketing", /marketing|seo|growth|social|campaign|ads?\b|copywrit/i],
  ["business", /business|strategy|strategist|finance|legal|sales|hr\b|recruit|negotiat/i],
  ["research", /research|investigat|survey|academic|scientist/i],
  [
    "engineering",
    /engineer|develop|backend|frontend|fullstack|full-stack|\bapi\b|typescript|javascript|python|rust|go\b|java|ruby|php|c\+\+|swift|kotlin|database|refactor|architect|coder|programmer|dev\b/i,
  ],
]

const SOURCE_LICENSES = {
  voltagent: "MIT",
  "zerox-furai": "MIT",
  wshobson: "MIT",
  davepoon: "source-repo",
  "vijaythecoder": "source-repo",
  "iannuttall": "source-repo",
  "webdevtodayjason": "source-repo",
  zhsama: "source-repo",
  "charles-adedotun": "source-repo",
  "anthropic-official": "source-repo",
}

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null
  const end = text.indexOf("\n---", 3)
  if (end < 0) return null
  const block = text.slice(3, end)
  const out = {}
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (value.startsWith(">") || value.startsWith("|")) continue // folded blocks: skip (rare, non-essential)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  out.__body__ = text.slice(end + 4).trim()
  return out
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)

function mapCategory(sourceHint, name, description, theirCategory) {
  const blob = `${sourceHint} ${name} ${description} ${theirCategory ?? ""}`
  for (const [cat, re] of CATEGORY_RULES) if (re.test(blob)) return cat
  return "general"
}

function truncateDesc(d) {
  if (d.length <= MAX_DESC) return d
  const cut = d.slice(0, MAX_DESC)
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "), MIN_DESC)
  return cut.slice(0, stop > MIN_DESC ? stop : MAX_DESC).trim()
}

function walk(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === ".git") continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(p))
    else if (ent.name.endsWith(".md") && !/^(README|ATTRIBUTION|AGENTS_CATALOG|NOTICE|LICENSE|CONTRIBUTING)/i.test(ent.name)) out.push(p)
  }
  return out
}

const report = { scanned: 0, kept: 0, dropped: { frontmatter: 0, name: 0, description: 0, body: 0 }, perCategory: {}, sources: {} }
const byCategory = new Map()
const seenIds = new Set()

for (const sourceDir of readdirSync(ROOT, { withFileTypes: true })) {
  if (!sourceDir.isDirectory() || sourceDir.name.startsWith(".")) continue
  const source = sourceDir.name
  const files = walk(join(ROOT, source))
  let keptForSource = 0
  for (const file of files) {
    report.scanned++
    const text = readFileSync(file, "utf8")
    const fm = parseFrontmatter(text)
    if (!fm || !fm.name) {
      report.dropped[fm ? "name" : "frontmatter"]++
      continue
    }
    if (!fm.description || fm.description.trim().length < MIN_DESC) {
      report.dropped.description++
      continue
    }
    const bodyLines = fm.__body__.split("\n").filter((l) => l.trim()).length
    if (bodyLines < MIN_BODY_LINES) {
      report.dropped.body++
      continue
    }
    const description = truncateDesc(fm.description.trim())
    let id = slug(fm.name)
    if (!id) {
      report.dropped.name++
      continue
    }
    let n = 2
    while (seenIds.has(id)) id = `${slug(fm.name)}-${n++}`
    seenIds.add(id)
    const category = mapCategory(source, fm.name, description, fm.category)
    const entry = {
      id,
      name: fm.name.trim(),
      category,
      tags: [],
      description,
      source: source === "voltagent" ? "voltagent" : `massive1003:${source}`,
      license: SOURCE_LICENSES[source] ?? "source-repo",
      native: false,
      path: `profiles/${category}/${id}.md`,
    }
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category).push({ entry, file, whenBonus: /when\s+(you|to|invoked|analyzing|creating)/i.test(description) ? 1 : 0, bodyLines })
    keptForSource++
  }
  report.sources[source] = { files: files.length, kept: keptForSource }
}

// balance across categories: prefer WHEN-to-use descriptions, then longer bodies
for (const list of byCategory.values()) {
  list.sort((a, b) => b.whenBonus - a.whenBonus || Math.min(b.bodyLines, 120) - Math.min(a.bodyLines, 120) || (a.entry.id < b.entry.id ? -1 : 1))
}
const picked = []
const queues = [...byCategory.entries()].map(([cat, list]) => [cat, [...list]])
while (picked.length < MAX) {
  let took = false
  for (const q of queues) {
    const next = q[1].shift()
    if (next) {
      picked.push(next)
      took = true
      if (picked.length >= MAX) break
    }
  }
  if (!took) break
}

// write outputs
mkdirSync(join(OUT, "profiles"), { recursive: true })
for (const { entry, file } of picked) {
  const dir = join(OUT, "profiles", entry.category)
  mkdirSync(dir, { recursive: true })
  cpSync(file, join(dir, `${entry.id}.md`))
  report.perCategory[entry.category] = (report.perCategory[entry.category] ?? 0) + 1
  report.kept++
}
const registryPath = join(OUT, "registry.json")
let entries = picked.map((p) => p.entry)
if (statSync(registryPath, { throwIfNoEntry: false })) {
  const existing = JSON.parse(readFileSync(registryPath, "utf8"))
  const merged = [...entries]
  for (const e of existing.entries ?? []) if (!merged.some((m) => m.id === e.id)) merged.push(e)
  entries = merged
}
entries.sort((a, b) => (a.id < b.id ? -1 : 1))
writeFileSync(registryPath, JSON.stringify({ entries }, null, 2) + "\n")
writeFileSync(join(OUT, "import-report.json"), JSON.stringify(report, null, 2) + "\n")
console.log(`normalize: scanned=${report.scanned} kept=${report.kept}/${MAX} categories=${JSON.stringify(report.perCategory)}`)
console.log(`normalize: dropped=${JSON.stringify(report.dropped)}`)
