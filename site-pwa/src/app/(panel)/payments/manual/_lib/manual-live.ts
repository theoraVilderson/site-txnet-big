import { RealtimeEvents } from "@/generated/wire";
import { userChannel } from "@/lib/realtime";
import { tenantChannelOf } from "@/lib/tenant-channel";

/** What the session's own queue re-reads on (RT-1-j): billing says an open payment this tenant lists appeared, moved or settled. */
export const OPEN_PAYMENT_EVENTS: readonly string[] = [RealtimeEvents.paymentOpenChanged];

/** One channel a queue's page listens on, and which of its events re-read it. */
export interface ManualLive {
  channel: string | null;
  types: readonly string[];
  /** Narrows a shared channel to this reseller's events. */
  accepts?: (payload: Record<string, unknown>) => boolean;
}

/**
 * Where a manual-payments queue hears that an open payment moved (RT-1-j).
 * The session's own queue — no reseller, or a seat on its own reseller — is
 * its `tenant:` channel. Any other reseller is a workspace on the platform's
 * panel: its owner hears `paymentResellerOpenChanged` on their
 * `user:` channel, filtered to this reseller (F-093-v), and the platform's
 * staff the platform's own `paymentOpenChanged`, which billing writes for every
 * payment.
 */
export function manualLiveOf(
  me: { userId: string; tenant: { id: string }; permissions: readonly string[] } | null,
  resellerId: string | null,
): ManualLive[] {
  const own: ManualLive = { channel: tenantChannelOf(me), types: OPEN_PAYMENT_EVENTS };
  if (!me || resellerId === null || resellerId === me.tenant.id) return [own];
  return [
    { channel: userChannel(me.userId), types: [RealtimeEvents.paymentResellerOpenChanged], accepts: (payload) => payload.resellerId === resellerId },
    own,
  ];
}
