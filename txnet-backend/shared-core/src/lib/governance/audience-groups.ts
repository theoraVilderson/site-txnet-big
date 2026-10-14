import type { Prisma } from '@prisma/client';

import { holdsPermission } from '../http/permissions';
import { PERMISSION_REGISTRY } from '../http/permission-registry.generated';
import { RESELLER_KEYS, type ResellerKey } from '../tenant/reseller-keys';

/** The key that lets a caller see a tenant's groups and pick a keyless one as an audience (ADR-0143 (2)). */
export const USER_GROUP_READ_KEY = 'user_group.read';

/**
 * The features that aim at an audience — a discount, a gateway, a product, a
 * lottery, a wheel, a campaign. A manager of any one may ask which groups they
 * may pick; the list is the same for each, since the rule never reads the feature.
 */
export const AUDIENCE_FEATURE_KEYS = ['coupon.manage', 'gateway.manage', 'catalog.manage', 'engagement.manage', 'campaign.manage'] as const;

/** Those of {@link AUDIENCE_FEATURE_KEYS} a reseller's door admits its own member by. */
export const AUDIENCE_DOOR_KEYS: readonly ResellerKey[] = AUDIENCE_FEATURE_KEYS.filter((key): key is ResellerKey & typeof key =>
  (RESELLER_KEYS as readonly string[]).includes(key),
);

/** Every key a group or tenant-made role may give: the registry less the platform's own set (ADR-0144 (2)). */
export const TENANT_CEILING: readonly string[] = PERMISSION_REGISTRY.filter((row) => !row.platformOnly).map((row) => row.permission);

/**
 * The keys a caller acts with in a reseller, by how its door admitted them
 * (ADR-0103's authority by structure): the owner holds the whole ceiling, the
 * platform's staff the part of it they hold, a member their own keys. `*` is
 * never one of them, so a reseller's rules never meet the platform owner's wildcard.
 */
export function keysActingIn(as: 'owner' | 'member' | 'staff', held: readonly string[]): readonly string[] {
  if (as === 'member') return held;
  if (as === 'owner') return TENANT_CEILING;
  return TENANT_CEILING.filter((key) => holdsPermission(held, key));
}

/**
 * ADR-0143 (2) and (3): a group that gives no keys (a set of customers) needs
 * `user_group.read`; a group that gives keys needs every one of them — the
 * rule a member add already holds (`key_not_held`). "Every user" is no group
 * and never asks.
 */
export function mayPickAudienceGroup(acting: readonly string[], groupKeys: readonly string[]): boolean {
  if (groupKeys.length === 0) return holdsPermission(acting, USER_GROUP_READ_KEY);
  return groupKeys.every((key) => holdsPermission(acting, key));
}

/** The one read the rule needs: a group, its own keys and its role's. */
export type AudienceGroupReader = Pick<Prisma.TransactionClient, 'userGroup'>;

const WITH_KEYS = {
  id: true,
  name: true,
  allTenants: true,
  role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } },
  permissions: { select: { permission: { select: { key: true } } } },
} as const;

type GroupWithKeys = {
  id: string;
  name: string;
  allTenants: boolean;
  role: { rolePermissions: { permission: { key: string } }[] } | null;
  permissions: { permission: { key: string } }[];
};

const keysOf = (g: GroupWithKeys): string[] => [
  ...(g.role?.rolePermissions.map((rp) => rp.permission.key) ?? []),
  ...g.permissions.map((p) => p.permission.key),
];

/** Why a feature write was refused a group, and which one. */
export type AudienceGroupRefusal = { reason: 'group_not_found' | 'audience_not_allowed'; groupId: string };

/**
 * The feature write's half of ADR-0143 (4): the first group of `groupIds` that
 * is not there or the caller may not pick, or `null`. Read on the writer's own
 * transaction, so RLS (or `tenantId`, where the writer reads across tenants)
 * keeps it to the record's tenant. `kept` are the groups the record already
 * has: they are not weighed again, so a manager holding less can still edit
 * the rest, or take one off.
 */
export async function refusedAudienceGroup(
  db: AudienceGroupReader,
  acting: readonly string[],
  groupIds: readonly string[],
  opts: { kept?: readonly string[]; tenantId?: string } = {},
): Promise<AudienceGroupRefusal | null> {
  const kept = new Set(opts.kept ?? []);
  const added = [...new Set(groupIds)].filter((id) => !kept.has(id));
  if (added.length === 0) return null;
  const rows: GroupWithKeys[] = await db.userGroup.findMany({
    where: { id: { in: added }, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) },
    select: WITH_KEYS,
  });
  const byId = new Map(rows.map((g) => [g.id, g]));
  for (const id of added) {
    const g = byId.get(id);
    if (!g || g.allTenants) return { reason: 'group_not_found', groupId: id };
    if (!mayPickAudienceGroup(acting, keysOf(g))) return { reason: 'audience_not_allowed', groupId: id };
  }
  return null;
}

/** The most groups the picker lists (C-28): far above any tenant's real count, a bound on a runaway one. */
export const AUDIENCE_GROUPS_MAX = 500;

/** A group the picker offers: whether it gives keys is shown, never which. */
export type AudienceGroupOption = { id: string; name: string; givesKeys: boolean };

/**
 * The picker's half of ADR-0143 (4): the scope's groups this caller may pick,
 * by name. "Every reseller" is no audience of a person (GR-1-n) and is left out.
 */
export async function pickableAudienceGroups(db: AudienceGroupReader, acting: readonly string[]): Promise<AudienceGroupOption[]> {
  const rows: GroupWithKeys[] = await db.userGroup.findMany({ where: { allTenants: false }, select: WITH_KEYS, orderBy: { name: 'asc' }, take: AUDIENCE_GROUPS_MAX });
  return rows
    .filter((g) => !g.allTenants)
    .map((g) => ({ g, keys: keysOf(g) }))
    .filter(({ keys }) => mayPickAudienceGroup(acting, keys))
    .map(({ g, keys }) => ({ id: g.id, name: g.name, givesKeys: keys.length > 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
