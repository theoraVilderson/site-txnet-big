import { holdsPermission } from "@/lib/permissions";
import { tenantChannel } from "@/lib/realtime";

/** gateway-service's `TENANT_CHANNEL_PERMISSION`: the `tenant:` channel needs it. */
export const REALTIME_TENANT_READ = "realtime.tenant.read";

/**
 * The reader's own `tenant:` channel (F-027-bs, RT-1-g), or null when the
 * gateway would refuse it — then the page reads on load, as it always did.
 * `*` holds every permission (`holdsPermission`).
 */
export function tenantChannelOf(me: { tenant: { id: string }; permissions: readonly string[] } | null): string | null {
  if (!me) return null;
  return holdsPermission(me.permissions, REALTIME_TENANT_READ) ? tenantChannel(me.tenant.id) : null;
}
