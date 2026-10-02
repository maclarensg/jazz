/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"

import type { BoardState, Card, HistoryEntry } from "./board"
import type { CronJob } from "./cron"
import type { Notification } from "./inbox"
import { JazzRpc } from "./rpc"

/**
 * opencode-jazz v2 TUI: three-pane dashboard (inbox · cron · kanban) with
 * i/c/k full views and a card detail overlay carrying the review verdict keys
 * (a accept · x cancel · r requeue). One keymap layer owned by the mounted
 * view component — the Keymap Provider doesn't exist in bare plugin setup.
 *
 * Kanban navigation is arrow-only and selection-only: ←/→ lanes, ↑/↓ cards.
 * Moving a card is an explicit shift key (H/L) — navigation can never mutate
 * a board (see tui-checklist-v2.md for the race that motivated this).
 */
type View = "dash" | "inbox" | "cron" | "kanban" | "detail"

export default Plugin.define({
  id: "opencode-jazz-tui",
  setup(context) {
    context.ui.slot({
      append: "app",
      render: () => <GlobalEntry />,
    })

    function GlobalEntry() {
      const ctx = usePlugin()
      onMount(() => {
        ctx.ui.router.register({
          name: "jazz",
          render: () => <Dashboard />,
        })
      })
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "jazz.board",
            title: "Open jazz dashboard",
            group: "Jazz",
            bind: "ctrl+j",
            palette: true,
            slash: { name: "board" },
            run: () => ctx.ui.router.navigate({ type: "plugin", name: "jazz" }),
          },
        ],
      }))
      return null
    }

    function Dashboard() {
      const ctx = usePlugin()
      const jazz = ctx.client.rpc(JazzRpc)

      const [view, setView] = createSignal<View>("dash")
      const [board, setBoard] = createSignal<BoardState | null>(null)
      const [jobs, setJobs] = createSignal<CronJob[]>([])
      const [notifications, setNotifications] = createSignal<Notification[]>([])
      const [unread, setUnread] = createSignal(0)
      const [registryTotal, setRegistryTotal] = createSignal(0)
      const [archiveTotal, setArchiveTotal] = createSignal(0)
      const [sel, setSel] = createSignal({ lane: 0, card: 0 })
      const [inboxSel, setInboxSel] = createSignal(0)
      const [jobSel, setJobSel] = createSignal(0)
      const [detailID, setDetailID] = createSignal<string | null>(null)
      const [toastless, setToastless] = createSignal(true)

      const laneNames = () => Object.keys(board()?.lanes ?? {})
      const cardsIn = (lane: string): Card[] => {
        const b = board()
        if (!b) return []
        return (b.lanes[lane] ?? []).map((id) => b.cards[id]).filter((c): c is Card => !!c)
      }
      const unreadFirst = () => {
        const list = notifications()
        return [...list].reverse().slice(0, 50)
      }
      const currentCard = (): Card | null => {
        const id = detailID()
        const b = board()
        return id && b ? (b.cards[id] ?? null) : null
      }

      const refresh = async () => {
        try {
          const [b, cr, ib, st, ar] = await Promise.all([
            jazz["board.get"]({}),
            jazz["cron.list"]({}),
            jazz["inbox.list"]({}),
            jazz["profiles.stats"]({}),
            jazz["archive.get"]({}),
          ])
          setBoard(b)
          setJobs(cr.jobs)
          setNotifications(ib.notifications as Notification[])
          setUnread(ib.unread)
          setRegistryTotal(st.total)
          setArchiveTotal(ar.total)
        } catch (e) {
          if (toastless()) {
            setToastless(false)
            ctx.ui.toast.show({ message: `jazz: ${e instanceof Error ? e.message : String(e)}`, variant: "error" })
          }
        }
      }

      const moveSelected = async (dir: -1 | 1) => {
        const lanes = laneNames()
        const s = sel()
        const lane = lanes[s.lane]
        if (!lane) return
        const card = cardsIn(lane)[s.card]
        // no card under the cursor → h/l shifts lane focus instead of moving
        if (!card) {
          setSel({ lane: Math.min(Math.max(s.lane + dir, 0), lanes.length - 1), card: 0 })
          return
        }
        const to = Math.min(Math.max(s.lane + dir, 0), lanes.length - 1)
        if (to === s.lane) return
        await jazz["card.move"]({ cardID: card.id, lane: lanes[to]! })
        setSel({ lane: to, card: 0 })
        await refresh()
      }

      /** Arrow navigation is selection-only: no RPC, no mutation. */
      const selectLane = (dir: -1 | 1) => {
        const lanes = laneNames()
        if (!lanes.length) return
        const s = sel()
        const lane = Math.min(Math.max(s.lane + dir, 0), lanes.length - 1)
        const count = cardsIn(lanes[lane] ?? "").length
        setSel({ lane, card: Math.min(s.card, Math.max(0, count - 1)) })
      }

      const selectCard = (dir: -1 | 1) => {
        const count = cardsIn(laneNames()[sel().lane] ?? "").length
        if (!count) return
        setSel((s) => ({ ...s, card: Math.min(Math.max(s.card + dir, 0), count - 1) }))
      }

      const newCard = async () => {
        const title = await ctx.ui.dialog.prompt({ title: "New card", placeholder: "what needs doing?" })
        if (!title?.trim()) return
        const priorityStr = await ctx.ui.dialog.prompt({ title: "Priority", placeholder: "0-3 (enter = 2)" })
        const priority = priorityStr && /^[0-3]$/.test(priorityStr.trim()) ? Number(priorityStr.trim()) : undefined
        await jazz["card.create"]({ title: title.trim(), ...(priority !== undefined ? { priority: priority as 0 | 1 | 2 | 3 } : {}) })
        setView("kanban")
        await refresh()
        ctx.ui.toast.show({ message: `card filed to triage`, variant: "success" })
      }

      const removeSelected = async () => {
        const lanes = laneNames()
        const card = cardsIn(lanes[sel().lane] ?? "")[sel().card]
        if (!card) return
        const yes = await ctx.ui.dialog.confirm({ title: "Remove card", message: `Remove "${card.title}"?` })
        if (!yes) return
        await jazz["card.remove"]({ cardID: card.id })
        setSel({ lane: sel().lane, card: 0 })
        await refresh()
      }

      const openDetail = (cardID: string) => {
        setDetailID(cardID)
        setView("detail")
      }

      const decide = async (decision: "accept" | "cancel" | "requeue") => {
        const card = currentCard()
        if (!card) return
        try {
          const moved = await jazz["review.decide"]({ cardID: card.id, decision })
          ctx.ui.toast.show({ message: `${card.id} → ${moved.lane}`, variant: "success" })
          setView("kanban")
          await refresh()
        } catch (e) {
          ctx.ui.toast.show({ message: `decide failed: ${e instanceof Error ? e.message : String(e)}`, variant: "error" })
        }
      }

      const addComment = async () => {
        const card = currentCard()
        if (!card) return
        const body = await ctx.ui.dialog.prompt({ title: `Comment on ${card.id}`, placeholder: "your note" })
        if (!body?.trim()) return
        await jazz["card.comment"]({ cardID: card.id, author: "gavin", body: body.trim() })
        await refresh()
      }

      const ackSelected = async () => {
        const list = unreadFirst()
        const n = list[inboxSel()]
        if (!n) return
        const r = await jazz["inbox.ack"]({ id: n.id })
        setUnread(r.unread)
        await refresh()
      }

      const ackAll = async () => {
        const r = await jazz["inbox.ackAll"]({})
        setUnread(r.unread)
        await refresh()
      }

      /** Clear = remove from the list entirely (distinct from ack's mark-read). */
      const clearSelected = async () => {
        const list = unreadFirst()
        const n = list[inboxSel()]
        if (!n) return
        await jazz["inbox.clear"]({ id: n.id })
        await refresh()
        const nextLen = Math.max(0, unreadFirst().length - 1)
        setInboxSel((v) => Math.min(v, nextLen))
        ctx.ui.toast.show({ message: `cleared: ${n.kind}`, variant: "success" })
      }

      const clearAllInbox = async () => {
        const list = unreadFirst()
        if (!list.length) return
        const yes = await ctx.ui.dialog.confirm({ title: "Clear inbox", message: `Remove all ${list.length} notifications from the list?` })
        if (!yes) return
        const r = await jazz["inbox.clearAll"]({})
        setUnread(r.unread)
        setInboxSel(0)
        await refresh()
        ctx.ui.toast.show({ message: `cleared ${r.cleared} notifications`, variant: "success" })
      }

      /** Stash every card in the selected done/cancelled lane into the archive. */
      const archiveSelectedLane = async () => {
        const lane = laneNames()[sel().lane]
        if (!lane) return
        const count = cardsIn(lane).length
        if (count === 0) {
          ctx.ui.toast.show({ message: `${lane} is already empty`, variant: "error" })
          return
        }
        const yes = await ctx.ui.dialog.confirm({ title: "Archive lane", message: `Move all ${count} cards from ${lane} to the archive?` })
        if (!yes) return
        try {
          const r = await jazz["board.archiveLane"]({ lane, actor: "gavin" })
          setArchiveTotal(r.archiveTotal)
          setSel((s) => ({ ...s, card: 0 }))
          await refresh()
          ctx.ui.toast.show({ message: `archived ${r.archived} cards (archive: ${r.archiveTotal})`, variant: "success" })
        } catch (e) {
          ctx.ui.toast.show({ message: `archive failed: ${e instanceof Error ? e.message : String(e)}`, variant: "error" })
        }
      }

      const runSelectedJob = async () => {
        const job = jobs()[jobSel()]
        if (!job) return
        const r = await jazz["cron.runNow"]({ jobID: job.id })
        ctx.ui.toast.show({
          message: r.status === "fired" ? `fired ${job.name} → ${r.sessionID}` : `${job.name}: ${r.status}`,
          variant: r.status === "fired" ? "success" : "error",
        })
        await refresh()
      }

      const toggleJob = async () => {
        const job = jobs()[jobSel()]
        if (!job) return
        await jazz["cron.upsert"]({ name: job.name, cronExpr: job.cronExpr, prompt: job.prompt, enabled: !job.enabled })
        await refresh()
        ctx.ui.toast.show({ message: `${job.name} ${job.enabled ? "disabled" : "enabled"}`, variant: "success" })
      }

      const newJob = async () => {
        const name = await ctx.ui.dialog.prompt({ title: "Cron job name", placeholder: "triage-sweep" })
        if (!name?.trim()) return
        const cronExpr = await ctx.ui.dialog.prompt({ title: "Cron expression", placeholder: "*/1 * * * *" })
        if (!cronExpr?.trim()) return
        const prompt = await ctx.ui.dialog.prompt({ title: "Prompt", placeholder: "what should each run do?" })
        if (!prompt?.trim()) return
        try {
          await jazz["cron.upsert"]({ name: name.trim(), cronExpr: cronExpr.trim(), prompt: prompt.trim() })
          await refresh()
          ctx.ui.toast.show({ message: `job ${name.trim()} saved`, variant: "success" })
        } catch (e) {
          ctx.ui.toast.show({ message: `upsert failed: ${e instanceof Error ? e.message : String(e)}`, variant: "error" })
        }
      }

      onMount(() => {
        void refresh()
        const offMoved = jazz.events.on("card.moved", () => void refresh())
        const offInbox = jazz.events.on("inbox.notification", () => void refresh())
        const every = setInterval(() => void refresh(), 30_000)
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            // view switching (c is cron everywhere EXCEPT inbox, where it clears)
            { id: "jazz.inbox", title: "Jazz inbox", group: "Jazz", bind: "i", run: () => { setInboxSel(0); setView("inbox") } },
            { id: "jazz.cron", title: "Jazz cron", group: "Jazz", bind: "c", enabled: () => view() !== "detail" && view() !== "inbox", run: () => { setJobSel(0); setView("cron") } },
            { id: "jazz.kanban", title: "Jazz kanban", group: "Jazz", bind: "k", enabled: () => view() !== "detail", run: () => setView("kanban") },
            { id: "jazz.dash", title: "Jazz dashboard", group: "Jazz", bind: "d", enabled: () => view() !== "dash", run: () => setView("dash") },
            { id: "jazz.back", title: "Jazz back/dashboard", group: "Jazz", bind: "escape", enabled: () => view() !== "dash", run: () => setView("dash") },
            { id: "jazz.home", title: "Close jazz", group: "Jazz", bind: "q", run: () => ctx.ui.router.navigate({ type: "home" }) },
            { id: "jazz.refresh", title: "Refresh jazz", group: "Jazz", bind: "f5", run: () => void refresh() },
            // kanban view — arrows navigate selection only (no mutation)
            { id: "jazz.laneleft", title: "Select lane left", group: "Jazz", bind: "left", enabled: () => view() === "kanban", run: () => selectLane(-1) },
            { id: "jazz.laneright", title: "Select lane right", group: "Jazz", bind: "right", enabled: () => view() === "kanban", run: () => selectLane(1) },
            { id: "jazz.cardup", title: "Previous item", group: "Jazz", bind: "up", enabled: () => view() === "kanban" || view() === "inbox" || view() === "cron", run: () => { if (view() === "kanban") selectCard(-1); else if (view() === "inbox") setInboxSel((v) => Math.max(0, v - 1)); else setJobSel((v) => Math.max(0, v - 1)) } },
            { id: "jazz.carddown", title: "Next item", group: "Jazz", bind: "down", enabled: () => view() === "kanban" || view() === "inbox" || view() === "cron", run: () => { if (view() === "kanban") selectCard(1); else if (view() === "inbox") setInboxSel((v) => v + 1); else setJobSel((v) => v + 1) } },
            // card moves keep dedicated shift keys so arrows stay read-only
            { id: "jazz.moveleft", title: "Move card left", group: "Jazz", bind: "shift+h", enabled: () => view() === "kanban", run: () => void moveSelected(-1) },
            { id: "jazz.moveright", title: "Move card right", group: "Jazz", bind: "shift+l", enabled: () => view() === "kanban", run: () => void moveSelected(1) },
            // archive the selected done/cancelled lane
            { id: "jazz.archive", title: "Archive lane (done/cancelled)", group: "Jazz", bind: "shift+a", enabled: () => view() === "kanban" && (laneNames()[sel().lane] === "done" || laneNames()[sel().lane] === "cancelled"), run: () => void archiveSelectedLane() },
            { id: "jazz.enter", title: "Open card detail", group: "Jazz", bind: "return", enabled: () => view() === "kanban" || view() === "inbox", run: () => { if (view() === "kanban") { const card = cardsIn(laneNames()[sel().lane] ?? "")[sel().card]; if (card) openDetail(card.id) } else { const n = unreadFirst()[inboxSel()]; if (n?.cardID) openDetail(n.cardID) } } },
            { id: "jazz.new", title: "New card", group: "Jazz", bind: "n", enabled: () => view() === "kanban" || view() === "dash", run: () => void newCard() },
            { id: "jazz.remove", title: "Remove card", group: "Jazz", bind: "x", enabled: () => view() === "kanban", run: () => void removeSelected() },
            // inbox view
            { id: "jazz.read", title: "Mark notification read", group: "Jazz", bind: "m", enabled: () => view() === "inbox", run: () => void ackSelected() },
            { id: "jazz.readall", title: "Mark all read", group: "Jazz", bind: "shift+m", enabled: () => view() === "inbox", run: () => void ackAll() },
            { id: "jazz.clear", title: "Clear notification (remove from list)", group: "Jazz", bind: "c", enabled: () => view() === "inbox", run: () => void clearSelected() },
            { id: "jazz.clearall", title: "Clear all notifications", group: "Jazz", bind: "shift+c", enabled: () => view() === "inbox", run: () => void clearAllInbox() },
            // cron view
            { id: "jazz.run", title: "Run cron job now", group: "Jazz", bind: "r", enabled: () => view() === "cron", run: () => void runSelectedJob() },
            { id: "jazz.toggle", title: "Enable/disable cron job", group: "Jazz", bind: "e", enabled: () => view() === "cron", run: () => void toggleJob() },
            { id: "jazz.newjob", title: "New cron job", group: "Jazz", bind: "shift+n", enabled: () => view() === "cron", run: () => void newJob() },
            // card detail: review verdicts
            { id: "jazz.comment", title: "Comment on card", group: "Jazz", bind: "shift+c", enabled: () => view() === "detail", run: () => void addComment() },
            { id: "jazz.accept", title: "Accept card (review → done)", group: "Jazz", bind: "a", enabled: () => view() === "detail" && currentCard()?.lane === "review", run: () => void decide("accept") },
            { id: "jazz.cancelcard", title: "Cancel card (→ cancelled)", group: "Jazz", bind: "shift+x", enabled: () => view() === "detail" && (currentCard()?.lane === "review" || currentCard()?.lane === "failed"), run: () => void decide("cancel") },
            { id: "jazz.requeue", title: "Requeue card (→ triage)", group: "Jazz", bind: "shift+r", enabled: () => view() === "detail" && (currentCard()?.lane === "review" || currentCard()?.lane === "failed"), run: () => void decide("requeue") },
          ],
        }))
        onCleanup(() => {
          offMoved()
          offInbox()
          clearInterval(every)
        })
      })

      const P = (n: number) => `p${n}`

      /** Full-width title: kanban mode names the selected lane in full —
       * column headers abbreviate, this line never clips. */
      const rootTitle = () => {
        if (view() !== "kanban") return ` jazz — ${view()} `
        const lane = laneNames()[sel().lane]
        if (!lane) return " jazz — kanban "
        const total = Object.keys(board()?.cards ?? {}).length
        const archived = archiveTotal() > 0 ? ` · ${archiveTotal()} archived` : ""
        return ` jazz — kanban ▸ ${lane} (${cardsIn(lane).length}) · ${total} cards total${archived} `
      }

      return (
        <box style={{ flexDirection: "column", padding: 1, height: "100%" }} title={rootTitle()} border={true}>
          <Show when={view() === "dash"}>
            <DashboardPanes
              notifications={unreadFirst()}
              unread={unread()}
              jobs={jobs()}
              board={board()}
              cardsIn={cardsIn}
              laneNames={laneNames()}
            />
          </Show>
          <Show when={view() === "inbox"}>
            <InboxView notifications={unreadFirst()} inboxSel={inboxSel()} />
          </Show>
          <Show when={view() === "cron"}>
            <CronView jobs={jobs()} jobSel={jobSel()} />
          </Show>
          <Show when={view() === "kanban"}>
            <KanbanView board={board()} laneNames={laneNames()} cardsIn={cardsIn} sel={sel()} />
          </Show>
          <Show when={view() === "detail" && currentCard()}>
            {(card) => <DetailView card={card()} />}
          </Show>
          <text fg="#666">
            {` i inbox (${unread()}) · c cron · k kanban · d dashboard · q close · registry ${registryTotal()} · ${new Date().toLocaleTimeString()}`}
          </text>
        </box>
      )
    }

    const PRIORITY_COLOR = ["#f85149", "#f0883e", "#d29922", "#8b949e"]

    function DashboardPanes(props: {
      notifications: Notification[]
      unread: number
      jobs: CronJob[]
      board: BoardState | null
      cardsIn: (lane: string) => Card[]
      laneNames: string[]
    }) {
      return (
        <box style={{ flexDirection: "row", flexGrow: 1 }}>
          <box title={` inbox (${props.unread} unread) `} style={{ flexDirection: "column", width: "34%", border: true }}>
            <For each={props.notifications.slice(0, 12)}>
              {(n) => (
                <text fg={n.read ? "#666" : "#7ee787"}>
                  {`${n.read ? "○" : "●"} ${n.kind}: ${n.message.slice(0, 38)}`}
                </text>
              )}
            </For>
            <Show when={props.notifications.length === 0}>
              <text fg="#666"> no notifications</text>
            </Show>
          </box>
          <box title=" cron " style={{ flexDirection: "column", width: "26%", border: true }}>
            <For each={props.jobs.slice(0, 12)}>
              {(job) => <text>{`${job.enabled ? "▸" : "·"} ${job.name} [${job.cronExpr}]`}</text>}
            </For>
            <Show when={props.jobs.length === 0}>
              <text fg="#666"> no cron jobs</text>
            </Show>
          </box>
          <box title=" board " style={{ flexDirection: "column", flexGrow: 1, border: true }}>
            <For each={props.laneNames}>
              {(lane) => {
                const cards = props.cardsIn(lane)
                const head = cards.slice(0, 1).map((c) => ` — ${c.title.slice(0, 24)}`).join("") || " —"
                return (
                  <text>
                    {`${lane.padEnd(12, " ")} ${String(cards.length).padStart(2, " ")}${head}`}
                  </text>
                )
              }}
            </For>
          </box>
        </box>
      )
    }

    function InboxView(props: { notifications: Notification[]; inboxSel: number }) {
      return (
        <box style={{ flexDirection: "column", flexGrow: 1 }} title=" inbox " border={true}>
          <For each={props.notifications}>
            {(n, i) => (
              <text fg={i() === props.inboxSel ? "#7ee787" : n.read ? "#666" : undefined}>
                {`${i() === props.inboxSel ? "▸" : " "}${n.read ? "○" : "●"} ${n.ts.slice(5, 16)} ${n.kind.padEnd(15, " ")} ${n.message.slice(0, 52)}`}
              </text>
            )}
          </For>
          <Show when={props.notifications.length === 0}>
            <text fg="#666"> inbox empty — nothing to review</text>
          </Show>
          <text fg="#666"> ↑/↓ select · c clear · C clear all · m read · M all · return open card · d dashboard</text>
        </box>
      )
    }

    function CronView(props: { jobs: CronJob[]; jobSel: number }) {
      return (
        <box style={{ flexDirection: "column", flexGrow: 1 }} title=" cron jobs " border={true}>
          <For each={props.jobs}>
            {(job, i) => (
              <text fg={i() === props.jobSel ? "#7ee787" : undefined}>
                {`${i() === props.jobSel ? "▸" : " "}${job.enabled ? "●" : "·"} ${job.name.padEnd(20, " ")} [${job.cronExpr}] last ${job.lastRun?.slice(5, 16) ?? "—"} next ${job.nextRun?.slice(5, 16) ?? "—"}`}
              </text>
            )}
          </For>
          <Show when={props.jobs.length === 0}>
            <text fg="#666"> no cron jobs — N to create</text>
          </Show>
          <text fg="#666"> ↑/↓ select · e toggle · r run now · N new · d dashboard</text>
        </box>
      )
    }

    /** Short lane keys for narrow columns; full names live in the root title
     * and the dashboard summary. All distinct at a glance. */
    const LANE_SHORT: Record<string, string> = {
      triage: "TRI",
      backlog: "BKLG",
      ready: "RDY",
      in_progress: "INPR",
      blocked: "BLKD",
      failed: "FAIL",
      review: "REV",
      done: "DONE",
      cancelled: "CNCL",
    }
    const laneShort = (lane: string) => LANE_SHORT[lane] ?? (lane.length <= 6 ? lane.toUpperCase() : `${lane.slice(0, 6).toUpperCase()}…`)
    const ellipsize = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

    function KanbanView(props: {
      board: BoardState | null
      laneNames: string[]
      cardsIn: (lane: string) => Card[]
      sel: { lane: number; card: number }
    }) {
      return (
        <box style={{ flexDirection: "column", flexGrow: 1 }}>
          <box style={{ flexDirection: "row", flexGrow: 1 }}>
            <For each={props.laneNames}>
              {(lane, li) => {
                const laneSel = () => li() === props.sel.lane
                const cards = () => props.cardsIn(lane)
                return (
                  <box
                    style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, border: true }}
                    borderColor={laneSel() ? "#7ee787" : "#30363d"}
                  >
                    <text fg={laneSel() ? "#7ee787" : "#8b949e"} wrapMode="none">{` ${laneShort(lane)}·${cards().length}`}</text>
                    <For each={cards()}>
                      {(card, ci) => {
                        const cardSel = () => laneSel() && ci() === props.sel.card
                        return (
                          <text fg={cardSel() ? "#7ee787" : PRIORITY_COLOR[card.priority] ?? undefined} wrapMode="none">
                            {`${cardSel() ? "▸" : card.priority <= 1 ? "!" : " "}${card.profile ? "*" : " "}${ellipsize(card.title, 16)}`}
                          </text>
                        )
                      }}
                    </For>
                    <Show when={cards().length === 0}>
                      <text fg="#666" wrapMode="none"> (empty)</text>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
          <text fg="#666"> ←/→ lane · ↑/↓ card · return detail · H/L move card · A archive done/cancelled · n new · x remove · ! high prio · * assigned</text>
        </box>
      )
    }

    function DetailView(props: { card: Card }) {
      const c = props.card
      const last = <T,>(arr: T[], n: number) => [...arr].slice(-n).reverse()
      const hist = (h: HistoryEntry) => `${h.ts.slice(5, 16)} ${h.kind.padEnd(9, " ")} ${h.actor.padEnd(12, " ")} ${h.detail ?? ""}${h.from ? ` ${h.from}→${h.to}` : ""}`
      const verdicts =
        c.lane === "review"
          ? "a accept → done · x cancel · r requeue → triage"
          : c.lane === "failed"
            ? "x cancel · r requeue → triage"
            : "verdict keys apply from review (or failed) lane"
      return (
        <box style={{ flexDirection: "row", flexGrow: 1 }}>
          <box style={{ flexDirection: "column", flexGrow: 1, border: true }} title={` ${c.id} · ${c.lane} `}>
            <text fg={PRIORITY_COLOR[c.priority]}>{`[${c.priority}] ${c.title}`}</text>
            <text>{`profile: ${c.profile ?? "unassigned"} · source: ${c.source} · p${c.priority}`}</text>
            <text>{`details: ${c.details ?? "—"}`}</text>
            <text> </text>
            <text fg="#8b949e">assignments:</text>
            <For each={c.assignments}>
              {(a) => <text>{` ${a.profile} ${a.startedAt.slice(5, 16)}→${a.endedAt?.slice(5, 16) ?? "now"} ${a.outcome ?? "working"}`}</text>}
            </For>
            <Show when={c.assignments.length === 0}>
              <text fg="#666"> (none yet)</text>
            </Show>
            <text> </text>
            <text fg="#8b949e">comments (newest first):</text>
            <For each={last(c.comments, 10)}>
              {(m) => <text>{` ${m.author}: ${m.body.slice(0, 70)}`}</text>}
            </For>
            <Show when={c.comments.length === 0}>
              <text fg="#666"> (none)</text>
            </Show>
          </box>
          <box style={{ flexDirection: "column", width: "46%", border: true }} title=" history (newest first) ">
            <For each={last(c.history, 14)}>
              {(h) => <text>{hist(h).slice(0, 74)}</text>}
            </For>
          </box>
          <text fg="#666">{` C comment · ${verdicts} · d dashboard`}</text>
        </box>
      )
    }

    return () => {}
  },
})
