# Cron debugging — two real bugs, 2026-09-28/29

Task 3 (cron) integration servers kept dying with SIGKILL ~30s after boot.
What it was NOT: kernel OOM (memory.events oom_kill stayed 0), systemd-oomd
(journal empty), farsight's maintenance scheduler (no kill logic), opencode
single-instance takeover (two serves on one data dir coexist), process-group
cleanup (detached/setsid didn't help), session subsystem crashes (manual
serve + prompt survived).

## Bug 1 — harness startup timer never cleared (the killer)

`test/integration/harness.ts` armed a 30s "boot timeout" timer that called
`child.kill("SIGKILL")` and rejected. On SUCCESS it resolved the promise but
NEVER cleared the timer. Every server that lived longer than 30s was
SIGKILLed by its own harness. Board/probe servers closed young and never
hit it; every long-lived server died at exactly ~30s. Fix: `clearTimeout`
in the success path.

Lesson: when a process dies by external SIGKILL at a suspiciously constant
delay, enumerate YOUR OWN timers first. Five exotic theories cost hours;
the kill call was in the file that spawned the process.

Method that worked: breadcrumb instrumentation (console.error at each await
in the tick + handlers, surfaced via serve stderr through the harness),
plus boot/exit announcements with PIDs in the harness. Theories without
instrumentation were unfalsifiable guessing.

## Bug 2 — re-entrant serialize deadlock

`cronService.upsert()` (running inside the serialize chain) called
`service.list()` — another serialized method. list() queued behind upsert;
upsert awaited list(). Deadlock: every subsequent cron RPC hung forever,
and any test polling behind them starved. Valid cron expressions deadlocked;
invalid ones returned early (threw before the list call) — which made the
suite look half-alive and hid the bug. Fix: `raw*` internal helpers without
the chain; public methods serialize, internals don't, public methods never
await other public methods.

Lesson: a single-writer promise-chain mutex needs its re-entrancy rule
stated at the definition site. The guard is structural now: raw* helpers
are the only things a serialized fn may await.

## Also fixed on the way

- RPC output schemas reject explicit-undefined fields: build response
  objects conditionally (`...(x ? {k: v} : {})`), never `k: v ?? undefined`.
- Test servers share the user data dir by default — stale jobs from prior
  runs fire on catch-up at boot and wreck isolation. Each harness server now
  gets a fresh XDG_DATA_HOME; the double-instance test passes the same dir
  to both servers explicitly.
- The curl/RPC wire format for jazz methods is `{"input": <method input>}`
  (matches @opencode/client's generated call shape).

## Follow-up 2026-10-03 — "sessions never execute" was a stale-table misread

Card 592b2b2c reported cron-fired sessions producing "0 parts in
opencode.db, no model calls, silent failure". Not true — the debugging
queried the LEGACY `session`/`message`/`part` tables (stale since Sep 28).
The live tables in opencode2 are `session_v2` + `session_message`; every
"failing" cron session had full message history there:

- Oct 2 fires (ses_f03171…, ses_f0308b2…): prompt delivered, model stream
  STARTED and hung — completed==interrupted ~3h later. Root cause of the
  silence: a stalled stream with no error AND no bound, which also wedged
  the whole scheduler tick (no other fires, no dispatcher pulls).
- Oct 3 19:16 fire (ses_efe85513…): 16 real model turns on
  zai-coding-plan/glm-5.3-flash. It ran daily_check.py, then flailed —
  glm-5.3-flash never found the kanban.* tools (they live inside the Code
  Mode `execute` catalog) and repeatedly substituted farsight tools
  instead, including a destructive farsight_forget on a real memory node.
  The kanban namespace WAS present (triage-sweep sessions call
  tools.kanban.list_cards every minute; a CLI probe with --agent
  invest-monitor reached it first try).

What actually fixed execution: the model pin (abacus/route-llm 403/hang →
zai-coding-plan/glm-5.3-flash, 19:35) + fc0a2fb6's fire-time agent
resolution. What fixed the kanban hop: (a) exact `execute` syntax in the
invest-monitor agent body + a never-touch-farsight rule, (b) the job
prompt delegating to monitor_dispatch.sh (kanban hop via CLI sub-run —
redundant since the fired session can call kanban, but harmless).

Code changes from the follow-up card:

- `canSubmitReview` (link.ts): cron-sourced cards submit to review from
  `ready` — monitors never enter the work lifecycle, so the old
  in_progress-only guard failed every daily submit ("card is not
  in_progress"). Workers unaffected.
- `fireTimeoutMs` (cron-fire.ts, default 10 min in the plugin): a fire
  that exceeds the budget records exactly one error run ("fire timeout …
  session may still complete"), notifies, and releases the tick. The
  straggler session keeps running but is suppressed from double-recording.
  This converts the Oct-2 3-hour wedge into a bounded, visible failure.

Lesson: before concluding "the session never ran", enumerate the schema —
opencode2 moved message storage to session_v2/session_message and the old
tables go stale. The decisive query was
`session_message WHERE session_id = <fired id>`.
