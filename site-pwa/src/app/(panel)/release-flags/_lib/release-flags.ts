import type { Me } from "@/lib/auth-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { holdsPermission } from "@/lib/permissions";
import type { ReleaseFlagRow } from "@/lib/release-flags-api";
import { isPlatformTenant } from "@/lib/tenant-type";

/** The page's strings as generated constants (C-06). */
export const FLAG_KEYS = FrontendI18nKeys.common.releaseFlags;

/** The platform key the routes take (shared-core `PLATFORM_KEYS`). */
export const RELEASE_MANAGE = "platform.release.manage";

/**
 * Who may open the page — the menu entry's rule, for a visitor who typed the
 * path: the key, on the platform's own tenant (ADR-0135). tenant-service
 * refuses anyone else anyway (`not_platform_owner`).
 */
export const canSwitchReleaseFlags = (me: Me | null) => isPlatformTenant(me?.tenant?.type) && holdsPermission(me?.permissions, RELEASE_MANAGE);

/** The resellers a flag can still be given an exception for: listed, and without one already. */
export function resellersWithoutException<R extends { id: string }>(flag: ReleaseFlagRow, resellers: readonly R[]): R[] {
  const taken = new Set(flag.exceptions.map((e) => e.tenantId));
  return resellers.filter((r) => !taken.has(r.id));
}
