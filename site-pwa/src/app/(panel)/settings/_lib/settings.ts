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

const CURRENCY_PIN = "currency.pin";

/**
 * Who sees the manual-rate card (F-116-l): anyone holding `currency.pin`, or
 * `*`, on any tenant. No tenant-type gate: currency-service scopes a pin to
 * the session's own books (a reseller's to its own), so the key is enough.
 */
export function canPinRates(me: Me | null): boolean {
  return !!me && holdsPermission(me.permissions, CURRENCY_PIN);
}
