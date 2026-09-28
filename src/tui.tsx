/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"

import type { BoardState, Card } from "./board"
import type { CronJob } from "./cron"
import { JazzRpc } from "./rpc"

/**
 * opencode-jazz TUI: /board route (lane columns, h/l move, n/x cards) +
 * cron section (tab focus, r run-now). Keymap layers live INSIDE components —
 * the Keymap Provider doesn't exist in bare plugin setup (observed failure:
 * "Keymap.Provider is missing").
 */
export default Plugin.define({
  id: "opencode-jazz-tui",
  setup(context) {
    // Global navigation command + route, mounted via the app slot so they
    // exist from TUI start. Router/keymap registrations need component
    // ownership (bare-setup registration silently failed to land).
    context.ui.slot({
      append: "app",
      render: () => <GlobalEntry />,
    })

    function GlobalEntry() {
      const ctx = usePlugin()
      onMount(() => {
        ctx.ui.router.register({
          name: "jazz",
          render: () => <BoardView />,
        })
      })
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "jazz.board",
            title: "Open kanban board",
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

    function BoardView() {
      const ctx = usePlugin()
      const jazz = ctx.client.rpc(JazzRpc)

      const [board, setBoard] = createSignal<BoardState | null>(null)
      const [jobs, setJobs] = createSignal<CronJob[]>([])
      const [zone, setZone] = createSignal<"board" | "cron">("board")
      const [sel, setSel] = createSignal({ lane: 0, card: 0 })
      const [jobSel, setJobSel] = createSignal(0)

      const laneNames = () => Object.keys(board()?.lanes ?? {})
      const cardsIn = (lane: string): Card[] => {
        const b = board()
        if (!b) return []
        return (b.lanes[lane] ?? []).map((id) => b.cards[id]).filter((c): c is Card => !!c)
      }

      const refresh = async () => {
        try {
          setBoard(await jazz["board.get"]({}))
          setJobs((await jazz["cron.list"]({})).jobs)
        } catch (e) {
          ctx.ui.toast.show({ message: `jazz: ${e instanceof Error ? e.message : String(e)}`, variant: "error" })
        }
      }

      const moveSelected = async (dir: -1 | 1) => {
        const lanes = laneNames()
        const s = sel()
        const lane = lanes[s.lane]
        if (!lane) return
        const card = cardsIn(lane)[s.card]
        if (!card) return
        const to = Math.min(Math.max(s.lane + dir, 0), lanes.length - 1)
        if (to === s.lane) return
        await jazz["card.move"]({ cardID: card.id, lane: lanes[to]! })
        setSel({ lane: to, card: 0 })
        await refresh()
      }

      const newCard = async () => {
        const title = await ctx.ui.dialog.prompt({ title: "New card", placeholder: "what needs doing?" })
        if (!title?.trim()) return
        const lanes = laneNames()
        const lane = lanes[sel().lane] ?? "backlog"
        await jazz["card.create"]({ title: title.trim(), lane })
        await refresh()
        ctx.ui.toast.show({ message: `card created in ${lane}`, variant: "success" })
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

      onMount(() => {
        void refresh()
        const off = jazz.events.on("card.moved", () => void refresh())
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            { id: "jazz.left", title: "Move card left", group: "Jazz", bind: "h", run: () => void moveSelected(-1) },
            { id: "jazz.right", title: "Move card right", group: "Jazz", bind: "l", run: () => void moveSelected(1) },
            { id: "jazz.next", title: "Next card", group: "Jazz", bind: "down", run: () => { setSel((s) => ({ ...s, card: s.card + 1 })) } },
            { id: "jazz.prev", title: "Previous card", group: "Jazz", bind: "up", run: () => { setSel((s) => ({ ...s, card: Math.max(0, s.card - 1) })) } },
            { id: "jazz.jobnext", title: "Next job", group: "Jazz", bind: "j", enabled: () => zone() === "cron", run: () => { setJobSel((v) => v + 1) } },
            { id: "jazz.jobprev", title: "Previous job", group: "Jazz", bind: "k", enabled: () => zone() === "cron", run: () => { setJobSel((v) => Math.max(0, v - 1)) } },
            { id: "jazz.zone", title: "Toggle board/cron", group: "Jazz", bind: "tab", run: () => { setZone((z) => (z === "board" ? "cron" : "board")) } },
            { id: "jazz.new", title: "New card", group: "Jazz", bind: "n", run: () => void newCard() },
            { id: "jazz.remove", title: "Remove card", group: "Jazz", bind: "x", run: () => void removeSelected() },
            { id: "jazz.run", title: "Run cron job now", group: "Jazz", bind: "r", enabled: () => zone() === "cron", run: () => void runSelectedJob() },
            { id: "jazz.refresh", title: "Refresh board", group: "Jazz", bind: "f5", run: () => void refresh() },
            { id: "jazz.home", title: "Close board", group: "Jazz", bind: "q", run: () => ctx.ui.router.navigate({ type: "home" }) },
          ],
        }))
        onCleanup(off)
      })

      return (
        <box style={{ flexDirection: "column", padding: 1 }} title=" jazz — kanban " border={true}>
          <box style={{ flexDirection: "row", flexGrow: 1 }}>
            <For each={laneNames()}>
              {(lane, li) => (
                <box title={` ${lane} `} style={{ flexDirection: "column", width: "20%", border: true }}>
                  <For each={cardsIn(lane)}>
                    {(card, ci) => {
                      const selected = () => zone() === "board" && li() === sel().lane && ci() === sel().card
                      return (
                        <text fg={selected() ? "#7ee787" : undefined}>
                          {`${selected() ? "▸ " : "  "}${card.title}`}
                        </text>
                      )
                    }}
                  </For>
                  <Show when={cardsIn(lane).length === 0}>
                    <text fg="#666"> (empty)</text>
                  </Show>
                </box>
              )}
            </For>
          </box>
          <box
            style={{ flexDirection: "column", height: 8, marginTop: 1, border: true }}
            title={zone() === "cron" ? " cron (tab: board, j/k: select, r: run now) " : " cron (tab to focus) "}
          >
            <For each={jobs()}>
              {(job, ji) => (
                <text fg={zone() === "cron" && ji() === jobSel() ? "#7ee787" : undefined}>
                  {` ${job.enabled ? "▸" : "·"} ${job.name}  [${job.cronExpr}]  next: ${job.nextRun ?? "—"}`}
                </text>
              )}
            </For>
            <Show when={jobs().length === 0}>
              <text fg="#666"> no cron jobs yet</text>
            </Show>
          </box>
          <text fg="#666"> h/l move · n new · x remove · tab cron · r run · j/k job · q close</text>
        </box>
      )
    }

    return () => {}
  },
})
