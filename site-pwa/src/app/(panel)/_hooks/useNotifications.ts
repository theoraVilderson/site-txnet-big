"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notificationApi, type NotificationItem } from "@/lib/notification-api";
import { userChannel } from "@/lib/realtime";
import { isNotificationCreated } from "../_lib/notification-event";
import { usePanelRealtime } from "../_context/PanelRealtimeContext";
import { usePanelSession } from "../_context/PanelSessionContext";

/**
 * How many rows the dropdown holds. It is a peek at the newest, not the inbox:
 * the count beside the bell is `unreadCount` over everything, so a short page
 * never understates what is waiting.
 */
export const DROPDOWN_PAGE_SIZE = 10;

export interface NotificationsState {
  items: NotificationItem[];
  /**
   * Unread over the whole inbox, as `notification-service` answered it. Nothing
   * here counts, adds or subtracts — see the hook's note.
   */
  unreadCount: number;
  isLoading: boolean;
  /** The last ask did not land. There is no server text for it — the caller writes its own line. */
  failed: boolean;
  refresh: () => void;
  /** Mark one row read. Its id, so a row the user actually opened is the one that changes. */
  markRead: (id: string) => Promise<void>;
  /** Mark every unread row read — the route's absent-`ids` meaning. */
  markAllRead: () => Promise<void>;
}

/**
 * The notifications dropdown's data (F-093-h).
 *
 * **The count is the service's, never this app's.** `unreadCount` is over the
 * whole inbox whatever the page or filter (`domains/notification/contract.md`),
 * and this dropdown reads ten rows — so a badge counted from `items` would be
 * short for every user with more unread rows than that, and short in the
 * direction that hides mail. It is the same correction `useWalletBalance` was
 * built around, on a different figure.
 *
 * **Only `notification.created` is a reason to ask again.** This differs from
 * the wallet on purpose: that hook re-reads on *any* event because no payment
 * shape had been agreed when it shipped. This one's shape is agreed and
 * declared (`contracts/realtime/events.json`, C-08), the `user:` channel also
 * carries the payment events of F-067-l/m, and an inbox read on a credit would
 * be work nobody asked for.
 *
 * **A failed read is not an empty inbox.** The last good page stays on screen
 * with a retry beside it: "you have no messages" is a different sentence from
 * "we could not ask", and only one of them is true.
 */
export function useNotifications(): NotificationsState {
  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const client = usePanelRealtime();

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Bumped to ask again. The read lives in one effect keyed to the account and
  // this counter, so a refresh and an account switch cannot race into two
  // in-flight reads whose answers land in the wrong order.
  const [asked, setAsked] = useState(0);
  const refresh = useCallback(() => setAsked((n) => n + 1), []);

  // The socket effect must not re-run when `refresh` does, or every event would
  // also cost a resubscribe — and a channel dropped and re-declared is a window
  // in which the next event is simply lost.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setIsLoading(true);
    (async () => {
      try {
        const answer = await notificationApi.inbox({ page: 1, pageSize: DROPDOWN_PAGE_SIZE });
        if (!alive) return;
        setItems(answer.items);
        setUnreadCount(answer.unreadCount);
        setFailed(false);
      } catch {
        // Nothing translated comes back for a listing — the route raises no
        // domain error at all — so a failure is the limiter or the network.
        if (alive) setFailed(true);
      } finally {
        if (alive) setIsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, asked]);

  useEffect(() => {
    if (!client || !userId) return;
    return client.subscribe(userChannel(userId), {
      onMessage: (payload) => {
        if (isNotificationCreated(payload)) refreshRef.current();
      },
      // A notification created while the socket was down was told to nobody,
      // and the badge would stay short until the next one (F-070-d).
      onMissed: () => refreshRef.current(),
    });
  }, [client, userId]);

  const mark = useCallback(async (ids?: readonly string[]) => {
    try {
      // The answer carries the new count, so the badge is right before the
      // re-read lands — and it is still the service's number, not a decrement.
      const { unreadCount: next } = await notificationApi.markRead(ids);
      setUnreadCount(next);
      setFailed(false);
      // `markRead` answers no rows, so the page is re-read for its `readAt`s
      // rather than patched here from what we hoped the write did.
      refreshRef.current();
    } catch {
      setFailed(true);
    }
  }, []);

  const markOne = useCallback((id: string) => mark([id]), [mark]);
  const markAll = useCallback(() => mark(undefined), [mark]);

  return { items, unreadCount, isLoading, failed, refresh, markRead: markOne, markAllRead: markAll };
}
