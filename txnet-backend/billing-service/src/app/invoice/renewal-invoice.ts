import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { CatalogOffer, renewableOfferById } from '../catalog/catalog-reads';
import { sellsTrafficToday, trafficQuotaOf } from '../catalog/traffic-quota';

/**
 * What a user's renewal invoice may name, and what it adds (F-305-c, billing
 * `contract.renewal.md` rules 1–4 and 6, ADR-0158).
 *
 * A renewal buys **the plan as it is now** — its bag, days and price in
 * effect — on the caller's own Grant: the Grant's own plan, or another of the
 * same product on the Grant's own panel group (entitlement invariant 31) and
 * billing mode. The amount is fixed here, at the invoice, and paid as quoted
 * (F-305-d hands it to `renewGrant`).
 *
 * Nothing that only stops a new service refuses it: visibility, the sales and
 * active caps (F-513, F-514), a product's audience, a reseller's package list
 * or the buyer's limits. A renewal starts none.
 */

export type RenewalRefusal =
  /** Not the caller's Grant — another user's, another tenant's (RLS) or unknown: one neutral 404. */
  | 'grant_not_found'
  /** The Grant is not `active` or `suspended`: nothing to extend. */
  | 'grant_not_renewable'
  /** The plan is gone, off, unpriced, off the Grant's product, group or mode, or of a shape the Grant cannot take. */
  | 'plan_not_renewable';

export class RenewalRefused extends Error {
  constructor(
    readonly reason: RenewalRefusal,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'RenewalRefused';
  }
}

/** A Grant as a renewal reads it; `productId` is its plan's product, `null` for one issued with no plan. */
export type RenewableGrant = {
  id: string;
  status: GrantStatus;
  variantId: string | null;
  productId: string | null;
  panelGroupId: string | null;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  /** Null = permanent. */
  endsAt: Date | null;
};

/** What one renewal adds, and whether it moves the Grant onto another plan. */
export type RenewalAmount = { bytes: bigint; days: number; switched: boolean };

const RENEWABLE: ReadonlySet<GrantStatus> = new Set([GrantStatus.active, GrantStatus.suspended]);

/**
 * The renewal `plan` adds to `grant`, or {@link RenewalRefused}. `plan` is
 * {@link renewableOfferById}'s answer: `null` for one gone, off, unpriced or
 * not this tenant's to read.
 *
 * Only the limited part is sold (rule 6): a metered Grant's bytes are blocks
 * and an unlimited one has no bag, so both buy days; a permanent one buys
 * bytes. A plan whose shape the Grant cannot take — a bag for an unlimited
 * Grant, days for a permanent one — is refused rather than charged for a part
 * `renewGrant` would drop.
 */
export function renewalOf(grant: RenewableGrant, plan: CatalogOffer | null): RenewalAmount {
  if (!RENEWABLE.has(grant.status)) throw new RenewalRefused('grant_not_renewable', `${grant.id} is ${grant.status}`);
  const refuse = (why: string) => new RenewalRefused('plan_not_renewable', `${plan?.variantId ?? 'plan'} for ${grant.id}: ${why}`);
  if (!plan) throw refuse('not live, unpriced or unknown');
  if (grant.productId === null || plan.productId !== grant.productId) throw refuse('another product');
  if (plan.panelGroupId !== grant.panelGroupId) throw refuse('another panel group');
  if (plan.billingMode !== grant.billingMode) throw refuse('another billing mode');
  if ((grant.endsAt === null) !== (plan.durationDays === null)) throw refuse('permanent and dated do not mix');
  if (!sellsTrafficToday(plan)) throw refuse('no traffic stated');

  const days = plan.durationDays ?? 0;
  let bytes = BigInt(0);
  if (grant.billingMode === VariantBillingMode.prepaid) {
    const traffic = trafficQuotaOf(plan.quotas);
    if ((traffic.kind === 'unlimited') !== grant.trafficUnlimited) throw refuse('unlimited and a bag do not mix');
    if (traffic.kind === 'limited') bytes = traffic.bytes;
  }
  if (bytes === BigInt(0) && days === 0) throw refuse('adds nothing');
  return { bytes, days, switched: plan.variantId !== grant.variantId };
}

/** A renewal ready to invoice: the plan priced now, and what it adds to which Grant. */
export type RenewalSale = { offer: CatalogOffer; grantId: string; amount: RenewalAmount };

/**
 * Reads the caller's Grant and the plan at `at` in the caller's
 * `tenantTransaction`, and decides with {@link renewalOf}. Another user's
 * Grant is as absent as another tenant's (RLS): `grant_not_found`.
 */
export async function renewalSaleOf(
  tx: Prisma.TransactionClient,
  input: { userId: string; grantId: string; variantId: string; at: Date },
): Promise<RenewalSale> {
  const grant = await tx.grant.findFirst({
    where: { id: input.grantId, userId: input.userId },
    select: { id: true, status: true, variantId: true, panelGroupId: true, billingMode: true, trafficUnlimited: true, endsAt: true },
  });
  if (!grant) throw new RenewalRefused('grant_not_found', input.grantId);
  const own = grant.variantId ? await tx.productVariant.findUnique({ where: { id: grant.variantId }, select: { productId: true } }) : null;
  const offer = await renewableOfferById(tx, input.variantId, input.at);
  const amount = renewalOf({ ...grant, productId: own?.productId ?? null }, offer);
  // `renewalOf` refused a null plan above; this narrows it for the caller.
  if (!offer) throw new RenewalRefused('plan_not_renewable', input.variantId);
  return { offer, grantId: grant.id, amount };
}
