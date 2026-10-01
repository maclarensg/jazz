/**
 * Profile registry: the normalized corpus of subagent profiles (imported
 * collections + soul roles) that Laya routing picks from. Pure logic; the
 * registry.json on disk is the source of truth (docs/design/v2-orchestrator.md §5).
 */

/** Canonical categories — stage-1 Laya choice must stay ≤16 options. */
export const CATEGORIES = [
  "engineering",
  "qa",
  "security",
  "docs",
  "data",
  "product",
  "design",
  "ops",
  "marketing",
  "business",
  "research",
  "general",
] as const

export type Category = (typeof CATEGORIES)[number]

export interface RegistryEntry {
  id: string
  name: string
  category: Category | string
  tags: string[]
  description: string
  /** origin: "voltagent", "massive1003:<sub>", "soul", … */
  source: string
  license: string
  /** materialized as a native OpenCode agent definition (hybrid personas) */
  native: boolean
  /** path to the profile markdown, relative to the package root */
  path: string
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
export const MIN_DESCRIPTION = 20
export const MAX_DESCRIPTION = 200

export class RegistryError extends Error {}

export function validateRegistry(entries: RegistryEntry[]): RegistryEntry[] {
  const seen = new Set<string>()
  for (const e of entries) {
    if (!ID_PATTERN.test(e.id)) throw new RegistryError(`bad profile id: ${JSON.stringify(e.id)}`)
    if (seen.has(e.id)) throw new RegistryError(`duplicate profile id: ${e.id}`)
    seen.add(e.id)
    if (!CATEGORIES.includes(e.category as Category)) {
      throw new RegistryError(`profile ${e.id} has non-canonical category: ${e.category}`)
    }
    const d = e.description.trim()
    if (d.length < MIN_DESCRIPTION || d.length > MAX_DESCRIPTION) {
      throw new RegistryError(`profile ${e.id} description must be ${MIN_DESCRIPTION}-${MAX_DESCRIPTION} chars (got ${d.length})`)
    }
    if (!e.path || typeof e.name !== "string" || e.name.length === 0) {
      throw new RegistryError(`profile ${e.id} missing name or path`)
    }
  }
  return entries
}

/** Safe loader for a parsed registry.json value; drops malformed entries, keeps the valid rest. */
export function normalizeRegistry(value: unknown): RegistryEntry[] {
  const raw = (value as { entries?: unknown } | null | undefined)?.entries
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is RegistryEntry => {
    if (typeof e !== "object" || e === null) return false
    const v = e as Record<string, unknown>
    return typeof v.id === "string" && typeof v.name === "string" && typeof v.description === "string" && typeof v.path === "string"
  })
}

export function profileSearchBlob(e: RegistryEntry): string {
  return `${e.name} ${e.description} ${e.tags.join(" ")}`.toLowerCase()
}

export function searchProfiles(entries: RegistryEntry[], query: { q?: string; category?: string } = {}): RegistryEntry[] {
  let out = entries
  if (query.category) out = out.filter((e) => e.category === query.category)
  if (query.q) {
    const q = query.q.toLowerCase()
    out = out.filter((e) => profileSearchBlob(e).includes(q))
  }
  return out
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "be", "it",
  "this", "that", "fix", "add", "make", "need", "needs", "work", "card", "please", "into", "from", "at", "by",
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

/**
 * Stage-2 Laya prefilter: rank registry entries by keyword overlap with the
 * card text (title + details + comments) and return the top `limit` (≤16 —
 * the choice cap). Pure and deterministic; ties break by id for stability.
 */
export function topCandidates(
  card: { title: string; details?: string; comments?: Array<{ body: string }> },
  entries: RegistryEntry[],
  opts: { category?: string; limit?: number } = {},
): RegistryEntry[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 16, 16))
  const text = `${card.title} ${card.details ?? ""} ${(card.comments ?? []).map((c) => c.body).join(" ")}`
  const tokens = new Set(tokenize(text))
  const pool = opts.category ? entries.filter((e) => e.category === opts.category) : entries
  const scored = pool.map((e) => {
    const blob = new Set(tokenize(profileSearchBlob(e)))
    let score = 0
    for (const t of tokens) if (blob.has(t)) score++
    return { e, score }
  })
  // Zero-score entries are noise for a choice question — the router falls
  // back to a plain category listing when nothing scores above zero.
  scored.sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : 1))
  return scored
    .filter((s) => s.score > 0)
    .slice(0, limit)
    .map((s) => s.e)
}
