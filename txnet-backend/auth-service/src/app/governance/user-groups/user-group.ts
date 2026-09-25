import { UserGroupMemberType } from '@prisma/client';

/**
 * User groups (F-114-j, governance): who is in one, and what one may hold.
 *
 * A group is one tenant's own. A reseller's group holds that reseller's users
 * and nothing else. The platform owner's group may also hold another tenant's
 * user, a reseller as such, or every reseller at once (`allTenants`) — the
 * platform is the one party whose customers are other tenants.
 *
 * **Two questions, never one.** A reseller member is the reseller, not its
 * customers: `admitsUser` answers for a person, `admitsTenant` for a reseller,
 * and a consumer asks the one it means. A discount rule prices a person's
 * purchase, so it asks `admitsUser` (billing `discount-rule.ts`).
 *
 * Consumers ask these, never the member rows' shape: membership is `manual`
 * today, and a computed kind is a new `UserGroupKind`, not a new consumer.
 */

export type UserGroupRejection =
  | 'group_not_found'
  | 'name_taken'
  | 'platform_only'
  | 'user_not_found'
  | 'tenant_not_found'
  | 'not_a_reseller'
  | 'all_tenants_conflict'
  | 'member_not_found'
  | 'group_in_use';

export type MemberRow = { memberType: UserGroupMemberType; userId: string | null; memberTenantId: string | null };

/** Whether the person `userId` is in the group. Only a user member admits a user. */
export function admitsUser(members: readonly MemberRow[], userId: string): boolean {
  return members.some((m) => m.memberType === UserGroupMemberType.user && m.userId === userId);
}

/** Whether the reseller `tenantId` is in the group: named, or every reseller — never the group's own tenant. */
export function admitsTenant(group: { tenantId: string; allTenants: boolean }, members: readonly MemberRow[], tenantId: string): boolean {
  if (tenantId === group.tenantId) return false;
  if (group.allTenants) return true;
  return members.some((m) => m.memberType === UserGroupMemberType.tenant && m.memberTenantId === tenantId);
}

/** A group's own shape: only the platform owner's holds every reseller. */
export function groupRefusal(ownerIsPlatform: boolean, group: { allTenants: boolean }): UserGroupRejection | null {
  return group.allTenants && !ownerIsPlatform ? 'platform_only' : null;
}

/**
 * A member about to be added, as the caller's pool found it. `userTenantId`
 * null is a user not found; a reseller's pool never finds another tenant's.
 */
export type MemberCandidate =
  | { type: 'user'; userTenantId: string | null }
  | { type: 'tenant'; tenantId: string; exists: boolean };

export function memberRefusal(
  group: { tenantId: string; platform: boolean; allTenants: boolean },
  c: MemberCandidate,
): UserGroupRejection | null {
  if (c.type === 'user') {
    if (c.userTenantId === null) return 'user_not_found';
    // Another tenant's user reads as missing — the answer RLS gives a reseller.
    if (!group.platform && c.userTenantId !== group.tenantId) return 'user_not_found';
    return null;
  }
  if (!group.platform) return 'platform_only';
  if (!c.exists) return 'tenant_not_found';
  if (c.tenantId === group.tenantId) return 'not_a_reseller';
  // Every reseller is already in it; naming one more would be a second answer to one question.
  if (group.allTenants) return 'all_tenants_conflict';
  return null;
}
