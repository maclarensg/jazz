/**
 * Runtime-agent resolution for worker sessions: a card profile is attachable
 * only when it names a real OpenCode agent — anything else dies at prompt
 * time with Session.AgentNotFoundError (run=142330b4, card 6787f497). The
 * routing registry (250 profiles) and the runtime agent set are different
 * corpora, so an unresolvable profile falls back to the default agent: the
 * profile role rides in the prompt instead (hybrid personas) and the card
 * gets a system comment so the miss stays visible. Pure logic; index.ts owns
 * the I/O (ctx.agent.list, service.comment).
 */

export interface AgentResolution {
  /** Agent id to switch the worker session to (undefined → default agent). */
  agent?: string
  /** Card comment body explaining a fallback (undefined → none needed). */
  note?: string
}

/** Resolve a card profile against the runtime agent ids. Exact id match only:
 * mapping a near-miss persona is the router's call, not a guess. */
export function resolveWorkerAgent(profile: string | undefined, runtimeIds: readonly string[]): AgentResolution {
  if (!profile) return {}
  if (runtimeIds.includes(profile)) return { agent: profile }
  return {
    note: `profile "${profile}" has no runtime agent — worker runs the default agent with the profile role in its prompt (native agents: ${runtimeIds.join(", ") || "none"})`,
  }
}
