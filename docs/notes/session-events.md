# Session lifecycle events — verified 2026-09-29 (v2.0.9, live capture)

Sources: `@opencode/client` generated types (contract) AND a live SSE capture
(`scripts/probe-events.mjs`, one real session run). Both agree.

## The link module's contract

| Event | data payload | link action |
|---|---|---|
| `session.execution.started` | `{sessionID}` | card → `in_progress` (no-op if already there) |
| `session.execution.succeeded` | `{sessionID}` | card → `done`, drop link |
| `session.execution.failed` | `{sessionID, error}` | card → `blocked`, drop link |
| `session.execution.interrupted` | `{sessionID}` | card → `blocked`, drop link |

Live capture of one tiny session observed, in order: `session.created`,
`session.instructions.updated`, `session.inbox.enqueued`, `session.inbox.delivered`,
`session.execution.started`, `session.step.started/streamed/ended`,
`session.reasoning.*`, `session.text.*`, `session.usage.updated`,
`session.execution.succeeded`.

Notes:
- Events arrive on the server-wide SSE stream (`GET /api/event`), which is
  what `ctx.event.subscribe()` wraps in a plugin.
- `session.idle` did NOT appear in the capture window (it may require an
  explicit idle signal). Do not build on it; execution events are sufficient.
- Payload shapes are typed in `@opencode/client/dist/promise/generated/types.d.ts`
  (`SessionExecutionStarted` etc.); the OpenAPI document hides event payloads
  behind an opaque string — do not rely on it for event shapes.
