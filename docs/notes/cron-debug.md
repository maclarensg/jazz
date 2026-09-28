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
