import { describe, expect, it } from "vitest"
import {
  createInbox,
  INBOX_CAP,
  markAllRead,
  markRead,
  normalizeInbox,
  pushNotification,
  unreadCount,
  type InboxState,
  type Notification,
} from "../../src/inbox"

let n = 0
const id = () => `n${++n}`
const push = (state: Notification[], kind: string, cardID?: string) =>
  pushNotification({ notifications: state }, { source: cardID ? "card" : "cron", kind, message: `m ${kind}`, ...(cardID ? { cardID } : { jobID: "j1" }) }, id).state.notifications

describe("inbox", () => {
  it("pushes notifications newest-last, unread by default", () => {
    const s0 = createInbox()
    const { state: s1, notification } = pushNotification(s0, { source: "card", kind: "entered_review", message: "ready", cardID: "c1" }, id)
    expect(notification).toMatchObject({ source: "card", kind: "entered_review", message: "ready", cardID: "c1", read: false })
    expect(s1.notifications).toHaveLength(1)
    expect(unreadCount(s1)).toBe(1)
  })

  it("caps the ring at INBOX_CAP keeping the newest", () => {
    let m = 0
    const gen = () => `x${++m}`
    let s = createInbox()
    for (let i = 0; i < INBOX_CAP + 10; i++) {
      s = pushNotification(s, { source: "cron", kind: "fired", message: "m", jobID: "j1" }, gen).state
    }
    expect(s.notifications).toHaveLength(INBOX_CAP)
    expect(s.notifications[0]!.id).toBe("x11") // x1..x10 dropped
    expect(s.notifications.at(-1)!.id).toBe(`x${INBOX_CAP + 10}`)
  })

  it("marks one read, then all; unreadCount follows", () => {
    let s = createInbox()
    s = { notifications: push(s.notifications, "blocked", "c1") }
    s = { notifications: push(s.notifications, "failed", "c2") }
    expect(unreadCount(s)).toBe(2)
    s = markRead(s, s.notifications[0]!.id)
    expect(unreadCount(s)).toBe(1)
    s = markAllRead(s)
    expect(unreadCount(s)).toBe(0)
    expect(s.notifications.every((x) => x.read)).toBe(true)
  })

  it("markRead on an unknown id is a no-op", () => {
    const s = markRead(createInbox(), "nope")
    expect(s.notifications).toEqual([])
  })

  it("normalizeInbox restores legacy/partial persisted state", () => {
    const raw = [
      { id: "a", ts: "t1", source: "card", kind: "done", message: "m", cardID: "c1" }, // missing read
      { id: "b", ts: "t2", source: "cron", kind: "fired", message: "m", jobID: "j1", read: true },
      "garbage" as unknown as Notification,
    ]
    const s = normalizeInbox({ notifications: raw })
    expect(s.notifications).toHaveLength(2)
    expect(s.notifications[0]!.read).toBe(false)
    expect(s.notifications[1]!.read).toBe(true)
  })

  it("normalizeInbox accepts unknown top-level shapes defensively", () => {
    expect(normalizeInbox(undefined)).toEqual({ notifications: [] })
    expect(normalizeInbox({ notifications: "nope" })).toEqual({ notifications: [] })
  })
})
import { clearNotifications, removeNotification } from "../../src/inbox"

describe("inbox clear", () => {
  const three = (): InboxState => {
    let list: Notification[] = []
    list = push(list, "fired")
    list = push(list, "failed")
    list = push(list, "entered_review", "c9")
    return { notifications: list }
  }

  it("clears one notification by id; others survive", () => {
    const s = three()
    const cleared = removeNotification(s, s.notifications[1]!.id)
    expect(cleared.notifications.map((x) => x.kind)).toEqual(["fired", "entered_review"])
    expect(cleared.notifications).toHaveLength(2)
  })

  it("clearing an unknown id is a no-op", () => {
    const s = three()
    expect(removeNotification(s, "nope")).toBe(s)
  })

  it("clears everything; unread follows", () => {
    const s = clearNotifications(three())
    expect(s.notifications).toHaveLength(0)
    expect(unreadCount(s)).toBe(0)
  })

  it("clearing a read notification still removes it and keeps unread accurate", () => {
    let s = three()
    s = markRead(s, s.notifications[0]!.id)
    const cleared = removeNotification(s, s.notifications[0]!.id)
    expect(cleared.notifications).toHaveLength(2)
    expect(unreadCount(cleared)).toBe(2)
  })
})
