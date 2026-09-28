import type { Me } from "@/lib/auth-api";
import { holdsPermission } from "@/lib/permissions";

const TENANT_MANAGE = "tenant.manage";

/**
 * Who sees the platform's operating-currency card (F-116-h): the platform's
 * staff holding `tenant.manage`, or `*` (SuperAdmin). Both halves: a reseller
 * can grant itself either key, so the tenant type gates it as well.
 */
export function canSetPlatformCurrency(me: Me | null): boolean {
  return me?.tenant?.type === "platform_owner" && holdsPermission(me.permissions, TENANT_MANAGE);
}
