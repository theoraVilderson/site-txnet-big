import { holdsPermission } from "@/lib/permissions";
import { myResellerUserPath, panelUserPath } from "@/lib/routes";
import { isPlatformTenant, type TenantType } from "@/lib/tenant-type";

/** Whose analytics a view is: the session's own tenant, or a reseller's by the path — its owner's (`self`) or the platform staff's. */
export type AnalyticsViewOf = { tenantId?: string; self?: boolean };

type Session = { permissions: readonly string[]; tenant: { type: TenantType } } | null;

/**
 * Whether the reader may change the renewal window — billing's door for it
 * (`AnalyticsSettingsService`): a reseller's owner on its own workspace, the
 * platform's staff with `platform.tenant.manage` (on a reseller, or on the
 * platform's own tenant), and on a reseller's own tenant its `settings.manage`
 * holders. The form is hidden from the rest; billing still decides.
 */
export function renewalWindowEditable(me: Session, view: AnalyticsViewOf): boolean {
  if (!me) return false;
  if (view.tenantId) return view.self === true || holdsPermission(me.permissions, "platform.tenant.manage");
  return holdsPermission(me.permissions, isPlatformTenant(me.tenant.type) ? "platform.tenant.manage" : "settings.manage");
}

/** Where a top customer's page is: the session's own users, or the workspace's reseller's. */
export function customerHrefOf(view: AnalyticsViewOf): (userId: string) => string {
  const { tenantId, self } = view;
  return tenantId ? (userId) => myResellerUserPath(tenantId, userId, self === true) : panelUserPath;
}
