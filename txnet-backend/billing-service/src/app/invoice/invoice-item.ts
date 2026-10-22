import { GrantSource, Prisma, VariantBillingMode } from '@prisma/client';
import { admitProductSale } from '@txnet-backend/shared-core';

import { CatalogOffer, sellableOfferById } from '../catalog/catalog-reads';
import { sellsTrafficToday } from '../catalog/traffic-quota';
import { deliveryRouteOf } from '../entitlement/delivery';
import { assertPurchaseRoom } from '../entitlement/purchase-limits';
import { assertPlatformGrantRoom } from '../entitlement/reseller-room';
import { assertBuyerRoom } from '../entitlement/user-restrictions';
import { deliverableGroupIds } from '../traffic/group-fulfilment';
import { CustomAmount, customRenewalSaleOf } from './custom-renewal';
import type { InvoiceCreateRequest } from './invoice.service';
import { renewalSaleOf } from './renewal-invoice';

/** Not for sale to this caller: unknown, another tenant's, `admin_only`, switched off, or no price in effect — never told apart. */
export class InvoiceVariantNotFound extends Error {
  constructor(readonly variantId: string) {
    super(`variant ${variantId} is not for sale to this tenant`);
    this.name = 'InvoiceVariantNotFound';
  }
}

/**
 * What an invoice is for, priced by the server, before any discount (F-111-a,
 * F-305-c, F-305-e): one shape for a purchase, a plan renewal and a renewal of
 * GiB and days typed, so `InvoiceService.create` discounts and stores them the
 * same way. Each kind asks its own gates here: a purchase every limit a new
 * service is asked; a renewal only its own rules (ADR-0158 (2)).
 */

/** What an invoice is for, priced by the server: a variant bought, a plan renewed (F-305-c), or GiB and days typed (F-305-e). */
export type InvoiceItem = {
  variantId: string;
  productId: string;
  sku: string;
  nameKey: string;
  amount: Prisma.Decimal;
  currencyCode: string;
  /** Exactly one of the two (CHECK `invoice_priced_once`). */
  priceId: string | null;
  renewalRateId: string | null;
  renewal: { grantId: string; bytes: bigint; days: number } | null;
};

/** The item `request` names, priced at `at`, or the refusal its kind answers. */
export async function invoiceItemOf(tx: Prisma.TransactionClient, request: InvoiceCreateRequest, tenantId: string, at: Date): Promise<InvoiceItem> {
  const { userId, grantId, variantId, custom } = request;
  if (grantId && custom) return customRenewalItem(tx, { userId, grantId, typed: custom, at });
  if (!variantId) throw new InvoiceVariantNotFound('none');
  if (grantId) {
    const sale = await renewalSaleOf(tx, { userId, grantId, variantId, at });
    return { ...offerItem(sale.offer), renewal: { grantId: sale.grantId, bytes: sale.amount.bytes, days: sale.amount.days } };
  }
  return offerItem(await purchasableOffer(tx, { tenantId, userId, variantId, at }));
}

const offerItem = (offer: CatalogOffer): InvoiceItem => ({
  variantId: offer.variantId,
  productId: offer.productId,
  sku: offer.sku,
  nameKey: offer.nameKey,
  amount: new Prisma.Decimal(offer.price.amount),
  currencyCode: offer.price.currencyCode,
  priceId: offer.price.id,
  renewalRateId: null,
  renewal: null,
});

/** GiB and days typed (F-305-e): named by the Grant's own variant, priced by its product's rate. */
async function customRenewalItem(tx: Prisma.TransactionClient, input: { userId: string; grantId: string; typed: CustomAmount; at: Date }): Promise<InvoiceItem> {
  const { grant, variantId, rate, priced } = await customRenewalSaleOf(tx, input);
  const variant = await tx.productVariant.findUniqueOrThrow({
    where: { id: variantId },
    select: { id: true, sku: true, nameKey: true, product: { select: { id: true, nameKey: true } } },
  });
  return {
    variantId: variant.id,
    productId: variant.product.id,
    sku: variant.sku,
    nameKey: variant.nameKey ?? variant.product.nameKey,
    amount: priced.amount,
    currencyCode: rate.currencyCode,
    priceId: null,
    renewalRateId: rate.id,
    renewal: { grantId: grant.id, bytes: priced.bytes, days: priced.days },
  };
}

/** The invoice columns a renewal fills (F-305-c): the Grant, and what the plan added when quoted. */
export const renewalColumns = (renewal: InvoiceItem['renewal']) =>
  renewal ? { grantId: renewal.grantId, renewBytes: renewal.bytes, renewDays: renewal.days } : {};

/**
 * The variant as a purchase may buy it (F-111-a), or a refusal: for sale to
 * this tenant and buyer, deliverable, and within every limit a new service is
 * asked — the buyer's, the reseller's room and its package quota.
 */
async function purchasableOffer(tx: Prisma.TransactionClient, input: { tenantId: string; userId: string; variantId: string; at: Date }): Promise<CatalogOffer> {
  const { tenantId, userId, variantId, at } = input;
  // A product sold to chosen groups is not sold to anyone else (PT-1-b): the same neutral refusal.
  const offer = await sellableOfferById(tx, variantId, at, userId);
  if (!offer) throw new InvoiceVariantNotFound(variantId);
  // Nothing is sold that nothing can deliver (F-111-d, the user's call
  // 2026-09-25): a paid Grant with no handler could only be refunded.
  const routed = await tx.productVariant.findUnique({ where: { id: offer.variantId }, select: { panelGroupId: true, billingMode: true } });
  const groupId = routed?.panelGroupId ?? null;
  const route = deliveryRouteOf(offer.fulfilmentKind, groupId);
  // ...nor a prepaid network Grant with no traffic to fill it (F-111-p).
  if (route === null || !sellsTrafficToday(offer)) throw new InvoiceVariantNotFound(variantId);
  // ...nor what no panel of its group could ever place (F-111-i).
  if (route === 'panel_group' && groupId && !(await deliverableGroupIds(tx, [groupId])).has(groupId)) {
    throw new InvoiceVariantNotFound(variantId);
  }

  // A buy past the buyer's metered cap (F-118-ao) or a restriction staff set on them (F-030-e) is
  // refused before an invoice exists, and again at issue under the same lock.
  await assertBuyerRoom(tx, userId, { source: GrantSource.purchase, metered: routed?.billingMode === VariantBillingMode.metered });
  // ...nor past the buyer's purchases in a day, week or month (F-019-t7), told before paying and again at issue.
  await assertPurchaseRoom(tx, userId);
  // ...nor past its reseller's room on the platform's panels (F-019-o), told before paying.
  await assertPlatformGrantRoom(tx, groupId);
  // ...nor past its reseller's package quota for the product, or overage it cannot pay (F-019-v6):
  // asked now, consumed at issue.
  await admitProductSale(tx, { tenantId, product: { id: offer.productId, tenantId: offer.tenantId }, now: at });
  return offer;
}
