# opencode-jazz — task plan

**Gate passed**: design agreed by Gavin, 2026-09-28. Every task below is
red → green → commit. No task starts before the previous one is committed.
No implementation starts at all until Gavin says go.

Conventions for every task:
- Unit tests: `vitest`, run `npm test`. Integration: `npm run test:integration`
  against a real `opencode2 serve` (v2.0.9).
- The red run must fail for the reason the behavior predicts — read the
  failure, don't just observe non-zero exit.
- Nothing guessable is evidence (see NeoLilith verify rule): integration
  assertions use nonce strings that must round-trip.

---

## Task 0 — Scaffold package + tooling (no behavior, no red gate)

Files: `package.json`, `tsconfig.json`, `.gitignore` (exists).

`package.json`:

```json
{
  "name": "opencode-jazz",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts", "./tui": "./src/tui.tsx" },
  "scripts": {
    "test": "vitest run test/unit",
    "test:integration": "vitest run test/integration"
  },
  "dependencies": { "croner": "^9", "zod": "^4" },
  "peerDependencies": { "@opencode/plugin": "latest" },
  "devDependencies": { "typescript": "^5", "vitest": "^3" }
}
```

TUI peers (`@opentui/core`, `@opentui/solid`, `solid-js`) added in Task 5.

Green: `npm install && npm test` passes with zero tests collected.

Commit: `chore: scaffold package, tsconfig, vitest`

---

## Task 1 — `src/board.ts`: pure board logic

**Red** — `test/unit/board.test.ts` (write first, watch it fail on missing module):

```ts
import { describe, expect, it } from "vitest"
import { BoardError, createBoard, createCard, moveCard, removeCard } from "../../src/board"

const board = () => createBoard(["backlog", "ready", "in_progress", "blocked", "done"])

describe("board", () => {
  it("creates a card in a lane with an id and orders it last", () => {
    let b = board()
    const r = createCard(b, { title: "nonce-card-1", lane: "ready" }, () => "c1")
    expect(r.card.title).toBe("nonce-card-1")
    expect(b.lanes["ready"]).toEqual(["c1"])
  })

  it("moves a card between lanes and reorders within a lane", () => {
    let b = board()
    createCard(b, { title: "a", lane: "backlog" }, () => "c1")
    createCard(b, { title: "b", lane: "ready" }, () => "c2")
    b = moveCard(b, "c1", "ready", 0)
    expect(b.lanes["ready"]).toEqual(["c1", "c2"])
    expect(b.lanes["backlog"]).toEqual([])
    expect(b.cards["c1"]!.updated >= b.cards["c1"]!.created).toBe(true)
  })

  it("throws typed errors for unknown card and unknown lane", () => {
    const b = board()
    expect(() => moveCard(b, "nope", "ready")).toThrowError(BoardError)
    expect(() => createCard(b, { title: "x", lane: "wat" })).toThrowError(/unknown lane/i)
  })

  it("removes a card from lane and index", () => {
    let b = board()
    createCard(b, { title: "a" }, () => "c1")
    b = removeCard(b, "c1")
    expect(b.cards["c1"]).toBeUndefined()
    expect(b.lanes["backlog"]).toEqual([])
  })
})
```

Note: default lanes include `blocked` — the link module (Task 4) parks failed
sessions there. (Amends the design doc's default list; design.md updated.)

**Green** — `src/board.ts`:

```ts
export interface Card { id: string; title: string; lane: string; created: string; updated: string }
export interface BoardState { cards: Record<string, Card>; lanes: Record<string, string[]> }

export class BoardError extends Error {
  constructor(public code: "unknown-card" | "unknown-lane", message: string) { super(message) }
}

export const DEFAULT_LANES = ["backlog", "ready", "in_progress", "blocked", "done"]

export function createBoard(lanes = DEFAULT_LANES): BoardState {
  return { cards: {}, lanes: Object.fromEntries(lanes.map((l) => [l, []])) }
}

export function createCard(
  board: BoardState,
  input: { title: string; lane?: string },
  idgen: () => string = () => crypto.randomUUID().slice(0, 8),
): { board: BoardState; card: Card } {
  const lane = input.lane ?? "backlog"
  if (!(lane in board.lanes)) throw new BoardError("unknown-lane", `unknown lane: ${lane}`)
  const now = new Date().toISOString()
  const card: Card = { id: idgen(), title: input.title, lane, created: now, updated: now }
  return {
    board: { cards: { ...board.cards, [card.id]: card }, lanes: { ...board.lanes, [lane]: [...board.lanes[lane]!, card.id] } },
    card,
  }
}

export function moveCard(board: BoardState, cardID: string, toLane: string, toIndex?: number): BoardState { /* splice out, splice in, bump updated */ }
export function removeCard(board: BoardState, cardID: string): BoardState { /* delete + splice */ }
```

Green: `npm test` passes. Commit: `feat(board): pure board state and mutations`

---

## Task 2 — Server plugin wiring: storage, tools, RPC

**Verify first** (blocks the integration half): on the real binary —
`opencode2 serve --help` and the OpenAPI security schemes
(`curl -s localhost:<port>/openapi.json | jq .components.securitySchemes`) —
to learn how a script authenticates HTTP against `serve`. Record findings in
`docs/notes/serve-auth.md`. Do not guess field names.

**Red (unit)** — `test/unit/storage.test.ts`: serialization guard round-trips
a state doc through a fake `ctx.storage` (in-memory Map) and rejects corrupt
JSON with a typed error.

**Green (impl)**:
- `src/storage.ts` — `loadBoard`, `saveBoard`, generic `readJson/writeJson`
  over `ctx.storage`, key `board/state`.
- `src/tools.ts` — namespace `kanban`; tools `kanban_create_card`,
  `kanban_move_card`, `kanban_list_cards`, `kanban_remove_card`. Each tool
  mutates via `board.ts` then `saveBoard`.
- `src/rpc.ts` — `Rpc.define({ id: "jazz", methods: { "board.get",
  "card.create", "card.move", "card.remove" }, events: { "card.moved" } })`
  per the RPC guide's input/output/error schema shape.
- `src/index.ts` — `Plugin.define({ id: "opencode-jazz", setup })` wires
  storage → board → tools + RPC; emits `card.moved` on every lane change.

**Red (integration)** — `test/integration/board.integration.test.ts`:
harness `test/integration/harness.ts` spawns `opencode2 serve --port <free>`
with cwd = a scratch project whose `opencode.jsonc` lists this repo in
`plugins`; polls readiness; exposes an authed `fetch` (mechanism from the
verify step). Asserts: RPC `card.create` with title `nonce-<random>` →
`board.get` returns exactly one card with that exact title.

Green both. Commit: `feat(server): board tools, RPC, storage persistence`

---

## Task 3 — `src/cron.ts`: scheduler

**Red (unit)** — `test/unit/cron.test.ts`:

- `nextRun("*/5 * * * *", from)` via croner returns expected minute boundary
  (fixed `from` clock).
- `dueJobs(jobs, now)` returns only enabled jobs with `nextRun <= now`.
- `catchup(jobs, now, "fire-missed")` returns every past-due job exactly once;
  policy `"skip-missed"` returns none — both then get `nextRun` recomputed.
- `recordRun(runs, entry)` caps at 100 (push 101, length is 100, oldest gone).
- `leaseAlive({instanceID, expiresAt}, now)`: alive iff `instanceID` matches
  and `now < expiresAt`; `undefined` lease → not alive.

**Green (impl)** — `src/cron.ts` (pure functions above + effectful):
`fireJob(ctx, job)` → `ctx.session.create({ title: \`jazz:${job.name}\` })` →
`ctx.session.prompt({ text: job.prompt, agent: job.agent })` → run record +
`cron.fired` event; failures → `cron.failed`. Tick loop in `setup`:
15s `setInterval` guarded by leader lease (`cron/leader` in storage: instance
ID + 30s expiry, heartbeat each tick). Cleanup returns `clearInterval`.

RPC additions: `cron.upsert`, `cron.list`, `cron.remove`, `cron.runNow`.

**Red (integration)** — `cron.integration.test.ts`: upsert job name
`nonce-<random>`, cron `* * * * *`, prompt "reply with the single word ok";
assert within 75s the server lists a session titled `jazz:nonce-<random>`,
and `cron/runs` shows the run. **Double-instance variant**: boot a second
serve instance against the same storage while the first runs; assert the
second's tick does not fire (job count in runs stays 1 per schedule slot).

Green. Commit: `feat(cron): scheduler, catch-up, leader lease, real-session firing`

---

## Task 4 — `src/link.ts`: session↔card automation

**Verify first**: enumerate actual session lifecycle event names/shapes from
the running server (`/openapi.json` event schemas + one observed live session
event stream). Record in `docs/notes/session-events.md`. Docs prose is not
the contract here.

**Red (unit)** — `test/unit/link.test.ts`: `transition(card, outcome)` —
`started → in_progress`, `completed → done`, `failed → blocked`; unknown
session IDs are no-ops; moving an already-terminal card is a no-op.

**Green (impl)**:
- `kanban_work(cardID, prompt)` tool: `session.create({ title: \`jazz:${card.title}\` })`,
  write `link/session/<sessionID>`, move card `in_progress`, prompt includes
  card context + caller prompt.
- Event subscription in `setup`: map observed lifecycle events →
  `transition()` → persist board, drop link on terminal outcome, emit
  `card.moved`.

**Red (integration)**: RPC/tool `kanban_work` on a fresh card with prompt
"reply with ok" → poll card lane becomes `in_progress`; after the session
completes, poll lane becomes `done` and the link is gone.

Green. Commit: `feat(link): card-bound sessions with lifecycle-driven lane moves`

---

## Task 5 — `src/tui.tsx`: board + cron view

No unit gate (UI verified on the real target). Files: `src/tui.tsx`,
`package.json` gains TUI peers + `exports["./tui"]` (already present).

Scope:
- Route `jazz`: one column per lane (order = board order), cards listed by
  lane order; `context.client.rpc(Jazz)["board.get"]` as source.
- Keymap layer: `/board` slash + palette command opens the route; `h/l` move
  focused card left/right lane (RPC `card.move`); `n` opens text dialog →
  `card.create`; `r` in cron section → `cron.runNow`.
- Cron section: `cron.list` jobs with next fire; live updates via
  `Jazz.events.on("card.moved")` re-fetch (live-only events are fine here).

**Verify**: TUI launched against the real serve instance from Task 2's
harness; manual checklist: board renders, move persists across reopen,
create shows up, cron section lists the Task 3 job. Checklist results
recorded in `docs/notes/tui-checklist.md`.

Commit: `feat(tui): board route, /board command, card ops, cron panel`

---

## Task 6 — Deployment + runbook

- `scripts/deploy-symlink.sh`: `npm install` in repo, then
  `ln -sfn "$PWD" ~/.config/opencode/plugins/jazz`; print resulting path.
- `docs/deploy/opencode-jazz.service` — systemd **user** unit template for
  the dedicated-`serve` topology (`ExecStart=%h/.local/bin/opencode2 serve
  --hostname 127.0.0.1 --port 4096`, `Restart=on-failure`).
- `README.md` runbook: two topologies (shared background service — the
  default, matches existing farsight-v2 usage; dedicated serve unit — for
  24/7), permission pre-authorization for scheduled agents, leader-lease
  behavior note, catch-up policy config.

**Verify**: after symlink + service restart, `opencode api get` (or RPC
`plugin.list`) shows `opencode-jazz` loaded; one real cron fire observed.

Commit: `docs+deploy: runbook, systemd unit, symlink script`

---

## Task 7 — Close: brain + evidence

- Episode through the brain's gate: what was built, integration evidence
  (exact numbers/paths from real runs), divergences from this plan.
- Design decision node (already recorded at plan time) updated with outcome
  links.
- Card/evidence updated in the brain; open gaps listed honestly.

Commit: `chore: close-out, evidence, brain links`

---

## Explicit non-goals for V1

- No multi-board support, no card assignees/due dates, no web UI beyond the
  built-in OpenCode web + RPC access, no recurring-job dependencies/chains,
- No persistence outside `ctx.storage`.
- The scheduler stays prompt-only; it never parses cards.
