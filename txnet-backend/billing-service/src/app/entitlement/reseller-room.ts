import { GrantSource, PanelOwnershipType, Prisma } from '@prisma/client';
import { assertUnderLimit, type ResellerLimitKey, resellerLimitOf, TenantContext } from '@txnet-backend/shared-core';

import { onPlatformPanel } from '../traffic/vpn-wholesale';
import { OPEN_GRANT_STATUSES } from './metered-cap';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a reseller may add on the platform's things (ADR-0106): each check
 * reads the limit in effect for the tenant in scope, takes a per-reseller
 * transaction lock so two writes at once cannot both see room for one, then
 * counts. No limit — or the platform's own tenant (`exempt`) — counts nothing.
 */
async function room(tx: Prisma.TransactionClient, key: ResellerLimitKey, count: (tenantId: string) => Promise<number>): Promise<void> {
  const tenantId = TenantContext.current(`reseller limit ${key}`).id;
  const inEffect = await resellerLimitOf(tx, tenantId, key);
  if (inEffect.limit === null) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_limit:${key}:${tenantId}`}))`;
  assertUnderLimit(key, inEffect, await count(tenantId));
}

/**
 * One more open service on the platform's panels (F-019-o,
 * `platform_open_grants_max`): only for a variant whose group holds a platform
 * panel now (`onPlatformPanel`, the wholesale leg's question); the count is the
 * reseller's open Grants of such variants. A service on its own panels spends
 * nothing of the platform's.
 */
export async function assertPlatformGrantRoom(tx: Prisma.TransactionClient, variantId: string): Promise<void> {
  if (!(await onPlatformPanel(tx, variantId))) return;
  await room(tx, 'platform_open_grants_max', (tenantId) =>
    tx.grant.count({
      where: {
        tenantId,
        status: { in: [...OPEN_GRANT_STATUSES] },
        variant: { panelGroup: { members: { some: { panel: { ownershipType: PanelOwnershipType.platform } } } } },
      },
    }),
  );
}

/**
 * One more service issued by hand (F-019-p, `admin_issues_30d_max`): every
 * `admin_grant` of the tenant created in the last 30 days, whoever issued it
 * — the issuer's tenant is not readable from the reseller's scope. Only the
 * reseller's own people are refused; the caller skips this for platform staff.
 */
export async function assertAdminIssueRoom(tx: Prisma.TransactionClient, now: Date): Promise<void> {
  await room(tx, 'admin_issues_30d_max', (tenantId) =>
    tx.grant.count({ where: { tenantId, source: GrantSource.admin_grant, createdAt: { gt: new Date(now.getTime() - 30 * DAY_MS) } } }),
  );
}
