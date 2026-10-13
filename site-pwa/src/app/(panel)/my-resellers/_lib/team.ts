import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { TenantRole } from "@/lib/auth-api";
import { holdsEveryPermission } from "@/lib/permissions";

const K = FrontendI18nKeys.common.tenantTeam;

/**
 * The refusals the Team page meets beyond the door's (`userRefusalKey`):
 * auth's role assignment (F-1201-a) and tenant's seats (F-018-j, F-1201-b).
 */
export type TeamRefusal = keyof typeof K.refusals;

export const TEAM_REFUSAL_KEYS: Record<TeamRefusal, string> = K.refusals;

export function teamRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in TEAM_REFUSAL_KEYS ? TEAM_REFUSAL_KEYS[reason as TeamRefusal] : null;
}

/** The roles this caller may give: every key of the role is one they may grant (identity invariant 18). */
export function assignableRoles(roles: readonly TenantRole[], grantable: readonly string[]): TenantRole[] {
  return roles.filter((role) => role.permissions.length === 0 || holdsEveryPermission(grantable, role.permissions));
}
