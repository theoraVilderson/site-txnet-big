import { GrantSource, GrantStatus, Prisma } from '@prisma/client';

import { sellsTrafficToday } from '../catalog/traffic-quota';
import { deliverableGroupIds } from '../traffic/group-fulfilment';
import { deliveryRouteOf } from './delivery';
import { EntitlementRefused, GrantService } from './grant';
import { assertAdminIssueRoom, assertPlatformGrantRoom } from './reseller-room';

export type AdminIssue = {
  userId: string;
  variantId: string;
  /** The caller's id for this one request: a repeat answers the Grant it issued. */
  requestId: string;
  actorUserId: string;
  at: Date;
  /**
   * The reseller's own people (ADR-0106): its limits on services issued by
   * hand (F-019-p) and on the platform's panels (F-019-o) apply. False for the
   * platform's staff, who are never bounded.
   */
  bounded?: boolean;
};

/** `issued` is false for a repeat of a request that already issued this Grant. */
export type AdminIssued = { grantId: string; variantId: string; status: GrantStatus; startsAt: Date; endsAt: Date | null; issued: boolean };

const issuedOf = (g: { id: string; variantId: string | null; status: GrantStatus; startsAt: Date; endsAt: Date | null }, issued: boolean): AdminIssued => ({
  grantId: g.id,
  variantId: g.variantId as string,
  status: g.status,
  startsAt: g.startsAt,
  endsAt: g.endsAt,
  issued,
});

/**
 * An admin issues a service to a user by hand (F-311-o): a Grant of a variant
 * with `source = admin_grant`, the request as its cause and the admin on it —
 * no invoice, no money. Runs in the caller's transaction and scope; the user
 * being the reseller's is the caller's check.
 *
 * **Provisioned like a purchase.** Born `active` (`grantFromVariant`), it is
 * placed by group fulfilment's sweep as a delivered purchase is. So what
 * invoice create refuses to sell is refused here before a Grant exists
 * (`variant_not_deliverable`): a kind with no handler, a network variant with
 * no group or none that could ever place one (F-111-i), a prepaid network
 * variant stating no traffic (F-111-p). `admin_only` is assignable (F-506).
 *
 * **One request, one Grant.** `(admin_grant, requestId)` is unique, so a
 * repeat answers the Grant it issued with `issued: false`; the same id for
 * another user or variant is `request_reused`, never that Grant.
 */
export async function issueGrantByAdmin(tx: Prisma.TransactionClient, grants: GrantService, input: AdminIssue): Promise<AdminIssued> {
  const prior = await tx.grant.findFirst({ where: { source: GrantSource.admin_grant, sourceReferenceId: input.requestId } });
  if (prior) {
    if (prior.userId !== input.userId || prior.variantId !== input.variantId) throw new EntitlementRefused('request_reused', input.requestId);
    return issuedOf(prior, false);
  }

  const variant = await tx.productVariant.findUnique({
    where: { id: input.variantId },
    select: { panelGroupId: true, billingMode: true, quotas: true, product: { select: { fulfilmentKind: true } } },
  });
  if (!variant) throw new EntitlementRefused('variant_not_found', input.variantId);
  const route = deliveryRouteOf(variant.product.fulfilmentKind, variant.panelGroupId);
  const deliverable =
    route !== null &&
    sellsTrafficToday({ fulfilmentKind: variant.product.fulfilmentKind, billingMode: variant.billingMode, quotas: variant.quotas }) &&
    (route !== 'panel_group' || (await deliverableGroupIds(tx, [variant.panelGroupId as string])).has(variant.panelGroupId as string));
  if (!deliverable) throw new EntitlementRefused('variant_not_deliverable', input.variantId);
  // After the repeat above, so asking again for the same issue is never refused.
  if (input.bounded) {
    await assertAdminIssueRoom(tx, input.at);
    await assertPlatformGrantRoom(tx, input.variantId);
  }

  const { grant, token } = await grants.issue(tx, {
    userId: input.userId,
    variantId: input.variantId,
    source: GrantSource.admin_grant,
    sourceReferenceId: input.requestId,
    startsAt: input.at,
    issuedByAdminId: input.actorUserId,
  });
  return issuedOf(grant, token !== null);
}
