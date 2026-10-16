import { holdsPermission } from "@/lib/permissions";
import { isPlatformTenant, type TenantType } from "@/lib/tenant-type";

/** The platform key billing's figures door admits its staff by (`ResellerAccess`, "figures"). */
const REPORT_KEY = "platform.report.read";

/** The Overview's top resellers: this many, the rest on the tab. */
export const TOP_RESELLERS = 5;

/**
 * Whether the Resellers tab and the Overview's top five are the reader's
 * (F-1001-i): only the platform's own view, never a workspace, and only to its
 * staff holding the report key — billing refuses everyone else, so the page
 * neither offers the tab nor asks for it.
 */
export function resellersVisible(me: { tenant: { type: TenantType }; permissions: readonly string[] } | null, pathTenant: string | undefined): boolean {
  return !!me && !pathTenant && isPlatformTenant(me.tenant.type) && holdsPermission(me.permissions, REPORT_KEY);
}
