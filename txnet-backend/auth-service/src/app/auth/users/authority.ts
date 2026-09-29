import { holdsPermission } from '@txnet-backend/shared-core';

/** Why the rule said no. `self` is rule 1, `owner` rule 2, `not_above` rule 4. */
export type AuthorityRefusal = 'self' | 'owner' | 'not_above';

/** The one acting: their permissions from their claims, and how `ResellerAccess` admitted them. */
export type AuthorityActor = { userId: string; permissions: readonly string[]; as: 'owner' | 'member' | 'staff' };

/** The person acted on: their permissions read from their role at the act, never from a cached view. */
export type AuthorityTarget = { userId: string; permissions: readonly string[] };

/** The tenant both are in: its `ownerUserId`, and whether it is the platform's own. */
export type AuthorityTenant = { ownerUserId: string | null; platform: boolean };

/**
 * Authority over a person (ADR-0103, identity invariant 18): the one rule
 * every act on another person's account asks — block and unblock today; role
 * assignment, password reset, ending sessions, deletion and impersonation
 * when they are built. A guard written per act drifts; this is the only copy.
 *
 * First match wins:
 * 1. the target is the actor — refused;
 * 2. the target is the tenant's owner — refused, to everyone;
 * 3. the actor is the tenant's owner, or platform staff in a **reseller's**
 *    tenant — allowed (authority from structure);
 * 4. otherwise the two are peers of one tenant: allowed only when the actor
 *    holds every key the target holds and at least one the target does not.
 *
 * No rank is stored anywhere: custom roles and new keys fall into the order by
 * what they hold, and two equal admins cannot lock each other out.
 *
 * Returns `null` when the act may go ahead.
 */
export function authorityOver(
  actor: AuthorityActor,
  target: AuthorityTarget,
  tenant: AuthorityTenant,
): AuthorityRefusal | null {
  if (target.userId === actor.userId) return 'self';
  if (target.userId === tenant.ownerUserId) return 'owner';
  if (actor.userId === tenant.ownerUserId) return null;
  // On the platform's own tenant `staff` is how every staffer is admitted, so
  // it is peerage there, not authority.
  if (actor.as === 'staff' && !tenant.platform) return null;
  return strictlyAbove(actor.permissions, target.permissions) ? null : 'not_above';
}

/** Every key of `target` is held by `actor` (`*` covering all), and `actor` holds one `target` does not. */
function strictlyAbove(actor: readonly string[], target: readonly string[]): boolean {
  return (
    target.every((key) => holdsPermission(actor, key)) && actor.some((key) => !holdsPermission(target, key))
  );
}

/** The Prisma `select` fragment that reads a user's keys from their role — the target's half of the rule. */
export const TARGET_PERMISSIONS_SELECT = {
  role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } },
} as const;

/** A row read with {@link TARGET_PERMISSIONS_SELECT}, as a key list. */
export function permissionsOf(row: {
  role: { rolePermissions: { permission: { key: string } }[] } | null;
}): string[] {
  return row.role?.rolePermissions.map((rp) => rp.permission.key) ?? [];
}
