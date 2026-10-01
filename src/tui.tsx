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
          const [b, cr, ib, st] = await Promise.all([
            jazz["board.get"]({}),
            jazz["cron.list"]({}),
            jazz["inbox.list"]({}),
            jazz["profiles.stats"]({}),
          ])
          setBoard(b)
          setJobs(cr.jobs)
          setNotifications(ib.notifications as Notification[])
          setUnread(ib.unread)
          setRegistryTotal(st.total)
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
            // view switching
            { id: "jazz.inbox", title: "Jazz inbox", group: "Jazz", bind: "i", run: () => { setInboxSel(0); setView("inbox") } },
            { id: "jazz.cron", title: "Jazz cron", group: "Jazz", bind: "c", enabled: () => view() !== "detail", run: () => { setJobSel(0); setView("cron") } },
            { id: "jazz.kanban", title: "Jazz kanban", group: "Jazz", bind: "k", enabled: () => view() !== "detail", run: () => setView("kanban") },
            { id: "jazz.dash", title: "Jazz dashboard", group: "Jazz", bind: "d", enabled: () => view() !== "dash", run: () => setView("dash") },
            { id: "jazz.back", title: "Jazz back/dashboard", group: "Jazz", bind: "escape", enabled: () => view() !== "dash", run: () => setView("dash") },
            { id: "jazz.home", title: "Close jazz", group: "Jazz", bind: "q", run: () => ctx.ui.router.navigate({ type: "home" }) },
            { id: "jazz.refresh", title: "Refresh jazz", group: "Jazz", bind: "f5", run: () => void refresh() },
            // kanban view
            { id: "jazz.left", title: "Move card left", group: "Jazz", bind: "h", enabled: () => view() === "kanban", run: () => void moveSelected(-1) },
            { id: "jazz.right", title: "Move card right", group: "Jazz", bind: "l", enabled: () => view() === "kanban", run: () => void moveSelected(1) },
            { id: "jazz.cardnext", title: "Next card", group: "Jazz", bind: "j", enabled: () => view() === "kanban" || view() === "inbox" || view() === "cron", run: () => { if (view() === "kanban") setSel((s) => ({ ...s, card: s.card + 1 })); else if (view() === "inbox") setInboxSel((v) => v + 1); else setJobSel((v) => v + 1) } },
            { id: "jazz.cardprev", title: "Previous item", group: "Jazz", bind: "K", enabled: () => view() === "kanban" || view() === "inbox" || view() === "cron", run: () => { if (view() === "kanban") setSel((s) => ({ ...s, card: Math.max(0, s.card - 1) })); else if (view() === "inbox") setInboxSel((v) => Math.max(0, v - 1)); else setJobSel((v) => Math.max(0, v - 1)) } },
            { id: "jazz.enter", title: "Open card detail", group: "Jazz", bind: "return", enabled: () => view() === "kanban" || view() === "inbox", run: () => { if (view() === "kanban") { const card = cardsIn(laneNames()[sel().lane] ?? "")[sel().card]; if (card) openDetail(card.id) } else { const n = unreadFirst()[inboxSel()]; if (n?.cardID) openDetail(n.cardID) } } },
            { id: "jazz.new", title: "New card", group: "Jazz", bind: "n", enabled: () => view() === "kanban" || view() === "dash", run: () => void newCard() },
            { id: "jazz.remove", title: "Remove card", group: "Jazz", bind: "x", enabled: () => view() === "kanban", run: () => void removeSelected() },
            // inbox view
            { id: "jazz.read", title: "Mark notification read", group: "Jazz", bind: "m", enabled: () => view() === "inbox", run: () => void ackSelected() },
            { id: "jazz.readall", title: "Mark all read", group: "Jazz", bind: "M", enabled: () => view() === "inbox", run: () => void ackAll() },
            // cron view
            { id: "jazz.run", title: "Run cron job now", group: "Jazz", bind: "r", enabled: () => view() === "cron", run: () => void runSelectedJob() },
            { id: "jazz.toggle", title: "Enable/disable cron job", group: "Jazz", bind: "e", enabled: () => view() === "cron", run: () => void toggleJob() },
            { id: "jazz.newjob", title: "New cron job", group: "Jazz", bind: "N", enabled: () => view() === "cron", run: () => void newJob() },
            // card detail: review verdicts
            { id: "jazz.comment", title: "Comment on card", group: "Jazz", bind: "C", enabled: () => view() === "detail", run: () => void addComment() },
            { id: "jazz.accept", title: "Accept card (review → done)", group: "Jazz", bind: "a", enabled: () => view() === "detail" && currentCard()?.lane === "review", run: () => void decide("accept") },
            { id: "jazz.cancelcard", title: "Cancel card (→ cancelled)", group: "Jazz", bind: "X", enabled: () => view() === "detail" && (currentCard()?.lane === "review" || currentCard()?.lane === "failed"), run: () => void decide("cancel") },
            { id: "jazz.requeue", title: "Requeue card (→ triage)", group: "Jazz", bind: "R", enabled: () => view() === "detail" && (currentCard()?.lane === "review" || currentCard()?.lane === "failed"), run: () => void decide("requeue") },
          ],
        }))
        onCleanup(() => {
          offMoved()
          offInbox()
          clearInterval(every)
        })
      })

      const P = (n: number) => `p${n}`

      return (
        <box style={{ flexDirection: "column", padding: 1 }} title={` jazz — ${view()} `} border={true}>
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
          <text fg="#666"> j/k select · m read · M all · return open card · d dashboard</text>
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
          <text fg="#666"> j/k select · e toggle · r run now · N new · d dashboard</text>
        </box>
      )
    }

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
              {(lane, li) => (
                <box
                  title={` ${lane} (${props.cardsIn(lane).length})${li() === props.sel.lane ? " ▾" : ""} `}
                  style={{ flexDirection: "column", width: `${Math.floor(100 / props.laneNames.length)}%`, border: true }}
                >
                  <For each={props.cardsIn(lane)}>
                    {(card, ci) => {
                      const selected = () => li() === props.sel.lane && ci() === props.sel.card
                      return (
                        <text fg={selected() ? "#7ee787" : PRIORITY_COLOR[card.priority] ?? undefined}>
                          {`${selected() ? "▸" : " "}${card.profile ? "*" : " "}${card.title.slice(0, 14)}`}
                        </text>
                      )
                    }}
                  </For>
                  <Show when={props.cardsIn(lane).length === 0}>
                    <text fg="#666"> (empty)</text>
                  </Show>
                </box>
              )}
            </For>
          </box>
          <text fg="#666"> h/l move lane · j/k card · return detail · n new · x remove · d dashboard · * = assigned profile</text>
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
