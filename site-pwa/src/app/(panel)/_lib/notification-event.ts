/**
 * The one event the notifications control listens for (F-093-h).
 *
 * `automation`'s `NotificationCreatedConsumer` republishes
 * `{type:'notification.created', userId, notification}` on `user:<userId>`
 * (`domains/automation/contract.outbox.md`, "the third consumer"), and that
 * channel also carries the payment events of F-067-l/m. So this is a filter,
 * not a parser: what it confirms is that an inbox row was written, and the
 * control then re-reads the route — the payload's `notification` is never
 * rendered, because the number beside the bell is `unreadCount` over the whole
 * inbox and no event carries it.
 */
import { RealtimeEvents } from "@/generated/wire";

export function isNotificationCreated(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as Record<string, unknown>).type === RealtimeEvents.notificationCreated;
}
