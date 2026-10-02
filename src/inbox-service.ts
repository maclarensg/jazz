import { clearNotifications, markAllRead, markRead, normalizeInbox, pushNotification, removeNotification, unreadCount, type InboxState, type Notification } from "./inbox"
import { readJson, writeJson, type JsonStorage } from "./storage"

export const INBOX_KEY = "inbox/notifications"

/**
 * Single-writer inbox service (same serialization pattern as the board
 * service): load→mutate→save must be atomic per operation.
 */
export function createInboxService(storage: JsonStorage, opts: { idgen?: () => string } = {}) {
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn)
    tail = next.catch(() => {})
    return next
  }
  const idgen = opts.idgen ?? (() => crypto.randomUUID().slice(0, 8))

  const load = async (): Promise<InboxState> => normalizeInbox(await readJson(storage, INBOX_KEY))
  const save = async (state: InboxState): Promise<void> => writeJson(storage, INBOX_KEY, state.notifications)

  return {
    notify(input: { source: "card" | "cron"; kind: string; message: string; cardID?: string; jobID?: string }): Promise<Notification> {
      return serialize(async () => {
        const { state, notification } = pushNotification(await load(), input, idgen)
        await save(state)
        return notification
      })
    },

    list(input: { unreadOnly?: boolean } = {}): Promise<{ notifications: Notification[]; unread: number }> {
      return serialize(async () => {
        const state = await load()
        const notifications = input.unreadOnly ? state.notifications.filter((n) => !n.read) : state.notifications
        return { notifications, unread: unreadCount(state) }
      })
    },

    ack(id: string): Promise<{ unread: number }> {
      return serialize(async () => {
        const state = markRead(await load(), id)
        await save(state)
        return { unread: unreadCount(state) }
      })
    },

    ackAll(): Promise<{ unread: number }> {
      return serialize(async () => {
        const state = markAllRead(await load())
        await save(state)
        return { unread: unreadCount(state) }
      })
    },

    /** Remove one notification from the list entirely (clear, not ack). */
    clear(id: string): Promise<{ cleared: number; unread: number }> {
      return serialize(async () => {
        const before = await load()
        const state = removeNotification(before, id)
        await save(state)
        return { cleared: before.notifications.length - state.notifications.length, unread: unreadCount(state) }
      })
    },

    /** Empty the inbox list. */
    clearAll(): Promise<{ cleared: number; unread: number }> {
      return serialize(async () => {
        const before = await load()
        await save(clearNotifications(before))
        return { cleared: before.notifications.length, unread: 0 }
      })
    },
  }
}

export type InboxService = ReturnType<typeof createInboxService>
