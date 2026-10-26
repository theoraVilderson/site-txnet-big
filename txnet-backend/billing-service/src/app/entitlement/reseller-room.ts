import { Prisma } from '@prisma/client';
import { assertUnderLimit, RESELLER_LIMIT_USAGE, resellerLimitOf, TenantContext } from '@txnet-backend/shared-core';

import { onPlatformPanel } from '../traffic/vpn-wholesale';

/**
 * What a reseller may add on the platform's things (ADR-0106): each check
 * reads the limit in effect for the tenant in scope, takes a per-reseller
 * transaction lock so two writes at once cannot both see room for one, then
 * counts — with shared-core's `RESELLER_LIMIT_USAGE`, the figure the
 * reseller's workspace shows (F-019-s). No limit — or the platform's own
 * tenant (`exempt`) — counts nothing.
 */
async function room(tx: Prisma.TransactionClient, key: 'platform_open_grants_max' | 'admin_issues_30d_max' | 'panels_max', at: { now: Date; tenantId?: string }): Promise<void> {
  const { now, tenantId = TenantContext.current(`reseller limit ${key}`).id } = at;
  const inEffect = await resellerLimitOf(tx, tenantId, key);
  if (inEffect.limit === null) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_limit:${key}:${tenantId}`}))`;
  assertUnderLimit(key, inEffect, await RESELLER_LIMIT_USAGE[key](tx, tenantId, now));
}

/**
 * One more open service on the platform's panels (F-019-o,
 * `platform_open_grants_max`): only for a sale whose group — the variant's —
 * holds a platform panel now (`onPlatformPanel`, the wholesale leg's
 * question); the count is the reseller's open Grants on such groups. A
 * service on its own panels spends nothing of the platform's.
 */
export async function assertPlatformGrantRoom(tx: Prisma.TransactionClient, panelGroupId: string | null): Promise<void> {
  if (!(await onPlatformPanel(tx, panelGroupId))) return;
  const now = new Date();
  await room(tx, 'platform_open_grants_max', { now });
  await trafficRoom(tx, now);
}

/**
 * One more panel of a reseller's own (BYO-1-a, `panels_max`, ADR-0166 point
 * 4): the owner is named, not read from the context, because the import's
 * door and the systems door both register under the path's tenant.
 */
export function assertPanelRoom(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  return room(tx, 'panels_max', { now: new Date(), tenantId });
}

/**
 * The month's traffic on the platform's panels (F-019-t6,
 * `platform_traffic_gib_monthly_max`): past it, no new service and no renewal
 * on a group holding a platform panel until the month ends — a renewal asks
 * the Grant's own group (F-027-er).
 * Nothing already open is cut (ADR-0106 point 3). No lock: the act being
 * checked adds no traffic.
 */
export async function assertPlatformTrafficRoom(tx: Prisma.TransactionClient, panelGroupId: string | null, now = new Date()): Promise<void> {
  if (!(await onPlatformPanel(tx, panelGroupId))) return;
  await trafficRoom(tx, now);
}

async function trafficRoom(tx: Prisma.TransactionClient, now: Date): Promise<void> {
  const key = 'platform_traffic_gib_monthly_max';
  const tenantId = TenantContext.current(`reseller limit ${key}`).id;
  const inEffect = await resellerLimitOf(tx, tenantId, key);
  if (inEffect.limit === null) return;
  assertUnderLimit(key, inEffect, await RESELLER_LIMIT_USAGE[key](tx, tenantId, now));
}

/**
 * One more service issued by hand (F-019-p, `admin_issues_30d_max`): every
 * `admin_grant` of the tenant created in the last 30 days, whoever issued it
 * — the issuer's tenant is not readable from the reseller's scope. Only the
 * reseller's own people are refused; the caller skips this for platform staff.
 */
export async function assertAdminIssueRoom(tx: Prisma.TransactionClient, now: Date): Promise<void> {
  await room(tx, 'admin_issues_30d_max', { now });
}
