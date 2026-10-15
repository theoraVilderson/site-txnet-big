import type { RegisteredPermission } from '../http/permission-registry.generated';

/**
 * Every key that opens a reseller's member door (AC-1-e, catalog §3.2): the
 * broad `tenant.manage` split into the nouns a reseller's own staff are given,
 * so a reseller can make "domains only", "support only" or "finance only".
 *
 * A route names its key with `ResellerAccess.for(key)`; a route that names
 * none is the owner's alone. Each key is on `grantable:` in `permissions.yaml`,
 * which is what puts it inside the tenant ceiling (F-018-n2, ADR-0144); a
 * group gives it, never a system role.
 *
 * Three have no reseller route yet — `wallet.manual_adjust`, `credential.manage`,
 * `export.request`. They are grantable now so a role made today already
 * carries them when their route lands. `audit.read` opens the access log (AC-1-p).
 */
export const RESELLER_KEYS = [
  'analytics.read',
  'audit.read',
  'bot.manage',
  'campaign.manage',
  'catalog.manage',
  'credential.manage',
  'domain.manage',
  'export.request',
  'gateway.manage',
  'grant.assign',
  'grant.compensate',
  'grant.read',
  'grant.repair',
  'report.read',
  'restriction.assign',
  'role.manage',
  'settings.manage',
  'staff.manage',
  'theme.manage',
  'user.impersonate',
  'user.read',
  'user.write',
  'user_group.manage',
  'wallet.manual_adjust',
] as const satisfies readonly RegisteredPermission[];

/** A key a reseller route may name for its member door. */
export type ResellerKey = (typeof RESELLER_KEYS)[number];
