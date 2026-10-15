import { AdminAction, AuditTargetType, FreezeMode, Prisma, VariantBillingMode } from '@prisma/client';

import { EntitlementRefused } from './entitlement-refusals';
import { Freeze, freezeGrant, Unfreeze, unfreezeOwnGrant } from './freeze';
import { freezeSettingsOf } from './freeze-settings';
import { lockOwnGrant, nextAllowedAt, OWNER_DAY_MS } from './owner-acts';

/** How often the user freezes one Grant in any 24 hours (catalog F-0401); how long it stays frozen is not bounded. */
export const SELF_FREEZES_PER_DAY = 3;

/** The user's freeze past the bound: nothing frozen, and `nextAt` says when one is allowed. */
export class SelfFreezeLimited extends EntitlementRefused {
  constructor(
    readonly limit: number,
    readonly nextAt: Date,
  ) {
    super('self_freeze_limit', `${limit} in 24h, next at ${nextAt.toISOString()}`);
  }
}

/**
 * The user freezes their own Grant (F-0401-c), in the caller's transaction:
 * a `self` freeze whose clock is the tenant's setting, copied onto the Grant
 * now. Only a `metered` Grant — a prepaid package frozen by its user would buy
 * free days — and only while the tenant allows it (`self_freeze_off`).
 *
 * The day's count is this Grant's `grant_self_freeze` audit rows — the caller
 * writes one per freeze, in the same transaction — taken under the Grant's
 * lock, so two freezes at once cannot both see room for the third.
 */
export async function freezeOwnGrant(tx: Prisma.TransactionClient, grantId: string, userId: string, at: Date): Promise<Freeze> {
  const grant = await lockOwnGrant(tx, grantId, userId);
  if (grant.billingMode !== VariantBillingMode.metered) throw new EntitlementRefused('grant_not_metered', grantId);
  const settings = await freezeSettingsOf(tx, grant.tenantId);
  if (!settings.selfFreezeEnabled) throw new EntitlementRefused('self_freeze_off', grant.tenantId);

  const taken = await tx.adminAuditLog.findMany({
    where: { action: AdminAction.grant_self_freeze, targetEntityType: AuditTargetType.grant, targetEntityId: grantId, createdAt: { gt: new Date(at.getTime() - OWNER_DAY_MS) } },
    orderBy: { createdAt: 'desc' },
    take: SELF_FREEZES_PER_DAY,
    select: { createdAt: true },
  });
  const nextAt = nextAllowedAt(
    taken.map((r) => r.createdAt),
    at,
    SELF_FREEZES_PER_DAY,
  );
  if (nextAt) throw new SelfFreezeLimited(SELF_FREEZES_PER_DAY, nextAt);
  return freezeGrant(tx, grantId, { at, mode: FreezeMode.self, stopsClock: settings.selfFreezeStopsClock });
}

/**
 * The user unfreezes their own Grant (F-0401-c): a soft or self freeze, never
 * a hard or a system one (`unfreezeOwnGrant`). Not gated on the tenant's
 * switch — turned off after the freeze, it must not trap the Grant frozen.
 */
export async function unfreezeOwn(tx: Prisma.TransactionClient, grantId: string, userId: string, at: Date): Promise<Unfreeze> {
  await lockOwnGrant(tx, grantId, userId);
  return unfreezeOwnGrant(tx, grantId, at);
}
