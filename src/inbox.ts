/**
 * Pure inbox logic: a capped notification ring sourced from board and cron
 * events. The inbox is the human surface — agents write card comments, not
 * notifications.
 */

export interface Notification {
  id: string
  ts: string
  source: "card" | "cron"
  /** card: entered_review | failed | blocked | done | cancelled | requeued · cron: fired | caught_up | failed */
  kind: string
  message: string
  cardID?: string
  jobID?: string
  read: boolean
}

export interface InboxState {
  notifications: Notification[]
}

export const INBOX_CAP = 500

export type NotificationIDGen = () => string

function isNotification(value: unknown): value is Notification {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.ts === "string" &&
    (v.source === "card" || v.source === "cron") &&
    typeof v.kind === "string" &&
    typeof v.message === "string"
  )
}

export function createInbox(): InboxState {
  return { notifications: [] }
}

/** Coerce a persisted doc into a valid state; accepts a bare array or {notifications}; drops malformed entries, backfills `read`, trims to cap. */
export function normalizeInbox(value: unknown): InboxState {
  const raw = Array.isArray(value)
    ? value
    : (value as { notifications?: unknown } | null | undefined)?.notifications
  const valid = Array.isArray(raw) ? raw.filter(isNotification) : []
  const list: Notification[] = valid.map((n) => (n.read === true ? n : { ...n, read: false }))
  const notifications = list.length > INBOX_CAP ? list.slice(list.length - INBOX_CAP) : list
  return { notifications }
}

export function pushNotification(
  state: InboxState,
  input: { source: "card" | "cron"; kind: string; message: string; cardID?: string; jobID?: string },
  idgen: NotificationIDGen = () => crypto.randomUUID().slice(0, 8),
  ts: string = new Date().toISOString(),
): { state: InboxState; notification: Notification } {
  const notification: Notification = {
    id: idgen(),
    ts,
    source: input.source,
    kind: input.kind,
    message: input.message,
    ...(input.cardID !== undefined ? { cardID: input.cardID } : {}),
    ...(input.jobID !== undefined ? { jobID: input.jobID } : {}),
    read: false,
  }
  const next = [...state.notifications, notification]
  const notifications = next.length > INBOX_CAP ? next.slice(next.length - INBOX_CAP) : next
  return { state: { notifications }, notification }
}

export function markRead(state: InboxState, id: string): InboxState {
  if (!state.notifications.some((n) => n.id === id)) return state
  return { notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)) }
}

export function markAllRead(state: InboxState): InboxState {
  return { notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })) }
}

export function unreadCount(state: InboxState): number {
  return state.notifications.filter((n) => !n.read).length
}
