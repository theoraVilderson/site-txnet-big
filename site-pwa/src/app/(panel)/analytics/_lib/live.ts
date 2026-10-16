import { RealtimeEvents } from "@/generated/wire";
import { userChannel } from "@/lib/realtime";
import { tenantChannelOf } from "@/lib/tenant-channel";

/** Where a view of one tenant's analytics hears that its figures changed. */
export interface AnalyticsLive {
  /** At most two channels; null where the gateway would refuse one. */
  channels: readonly [string | null, string | null];
  types: readonly string[];
  /** Narrows a shared channel to this tenant's events. */
  accepts?: (payload: Record<string, unknown>) => boolean;
}

/**
 * The session's own tenant: its `tenant:` channel, as F-1001-d built it. Any
 * other tenant is a reseller on its workspace, on the platform's panel: its
 * owner's `user:` and the platform staff's `tenant:` carry
 * `billing.analytics.reseller_refreshed` for every reseller, so only this
 * one's re-reads (F-1001-p, realtime `contract.live-events.md`). `everyReseller`:
 * the platform's own Resellers or Profit read, which any reseller's pass changes.
 */
export function analyticsLiveOf(
  me: { userId: string; tenant: { id: string }; permissions: readonly string[] } | null,
  tenantId: string | null,
  how: { everyReseller?: boolean } = {},
): AnalyticsLive {
  if (!me || !tenantId) return { channels: [null, null], types: [] };
  // The platform's leaderboard (F-1001-i) moves with any reseller's pass, told on the platform's own channel.
  if (tenantId === me.tenant.id && how.everyReseller) return { channels: [tenantChannelOf(me), null], types: [RealtimeEvents.analyticsRefreshed, RealtimeEvents.analyticsResellerRefreshed] };
  if (tenantId === me.tenant.id) return { channels: [tenantChannelOf(me), null], types: [RealtimeEvents.analyticsRefreshed] };
  return {
    channels: [userChannel(me.userId), tenantChannelOf(me)],
    types: [RealtimeEvents.analyticsResellerRefreshed],
    accepts: (payload) => payload.resellerId === tenantId,
  };
}
