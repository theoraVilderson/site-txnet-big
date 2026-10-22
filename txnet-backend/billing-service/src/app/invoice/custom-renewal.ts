import { Prisma, VariantBillingMode } from '@prisma/client';
import { currencyPlacesOf, operatingCurrencyOf, roundCharge, TenantContext } from '@txnet-backend/shared-core';

import { renewalRateAt } from '../catalog/renewal-rate.service';
import { assertGrantRenewable, callersGrant, RenewableGrant, RenewalRefused } from './renewal-invoice';

/**
 * A renewal of GiB and days typed, at the product's renewal rate (F-305-e,
 * billing `contract.renewal.md` rules 5, 6 and 8, ADR-0158 (4)): an invoice
 * with `grantId` and `{gib, days}` in place of a plan.
 *
 * The rate is the one in effect at the invoice, in the reader's currency
 * (catalog invariant 11), and the invoice names it, so paying charges what was
 * quoted even if a newer rate took effect in between (rule 9). A part typed as
 * 0 is not bought; a part bought sits within its bounds; both 0 buys nothing.
 */

const GIB = BigInt(1024 ** 3);

/** A renewal rate in effect, as the invoice prices with it: both parts sold or not (`renewal_rate_off_whole`). */
export type RenewalRateTerms = {
  id: string;
  pricePerGib: Prisma.Decimal;
  pricePerDay: Prisma.Decimal;
  minGib: number;
  maxGib: number;
  minDays: number;
  maxDays: number;
  currencyCode: string;
};

/** How few and how many GiB and days one renewal of this Grant may buy. */
export type CustomBounds = { minGib: number; maxGib: number; minDays: number; maxDays: number };

/** GiB and days as typed; whole numbers, checked at the edge. */
export type CustomAmount = { gib: number; days: number };

/** What a typed renewal adds, and what it costs before any discount. */
export type CustomPriced = { bytes: bigint; days: number; amount: Prisma.Decimal };

/**
 * The rate's bounds for this Grant (rule 6): a metered Grant's bytes are
 * blocks and an unlimited one has no bag, so neither buys GiB; a permanent
 * one buys no days. A part the Grant cannot take has a most of 0.
 */
export function customBoundsFor(grant: RenewableGrant, rate: RenewalRateTerms): CustomBounds {
  const takesGib = grant.billingMode === VariantBillingMode.prepaid && !grant.trafficUnlimited;
  const takesDays = grant.endsAt !== null;
  return {
    minGib: takesGib ? rate.minGib : 0,
    maxGib: takesGib ? rate.maxGib : 0,
    minDays: takesDays ? rate.minDays : 0,
    maxDays: takesDays ? rate.maxDays : 0,
  };
}

/** A part typed as 0 is not bought; one bought is within `[min, max]`. */
const withinBounds = (part: number, min: number, max: number) => part === 0 || (part >= min && part <= max);

/**
 * What `typed` adds to `grant` and costs at `rate`, rounded once, up, to the
 * currency's `places` (rule 8, ADR-0153) — or {@link RenewalRefused}.
 */
export function customRenewalOf(grant: RenewableGrant, rate: RenewalRateTerms | null, typed: CustomAmount, places: number): CustomPriced {
  assertGrantRenewable(grant);
  if (!rate) throw new RenewalRefused('custom_renewal_off', `${grant.id}: no renewal rate in effect`);
  const bounds = customBoundsFor(grant, rate);
  if (bounds.maxGib === 0 && bounds.maxDays === 0) throw new RenewalRefused('custom_renewal_off', `${grant.id} can take no part of rate ${rate.id}`);
  const nothing = typed.gib === 0 && typed.days === 0;
  if (nothing || !withinBounds(typed.gib, bounds.minGib, bounds.maxGib) || !withinBounds(typed.days, bounds.minDays, bounds.maxDays)) {
    throw new RenewalRefused('custom_out_of_bounds', `${typed.gib} GiB, ${typed.days} days for ${grant.id}`, bounds);
  }
  const amount = roundCharge(rate.pricePerGib.times(typed.gib).plus(rate.pricePerDay.times(typed.days)), places);
  return { bytes: BigInt(typed.gib) * GIB, days: typed.days, amount };
}

/**
 * The renewal rate in effect for the Grant's product at `at`, in the
 * reader's currency, or `null` (custom renewal off). A Grant issued with no
 * plan (an import) has no product, so no rate.
 */
export async function renewalRateFor(tx: Prisma.TransactionClient, grant: RenewableGrant, at: Date): Promise<RenewalRateTerms | null> {
  if (!grant.productId) return null;
  const currencyCode = await operatingCurrencyOf(tx, TenantContext.current('renewal rate').id);
  const row = await renewalRateAt(tx, grant.productId, at, currencyCode);
  // `renewalRateAt` answers only a priced row; `renewal_rate_off_whole` makes all six set together.
  if (!row?.pricePerGib || !row.pricePerDay) return null;
  return {
    id: row.id,
    pricePerGib: row.pricePerGib,
    pricePerDay: row.pricePerDay,
    minGib: row.minGib ?? 0,
    maxGib: row.maxGib ?? 0,
    minDays: row.minDays ?? 0,
    maxDays: row.maxDays ?? 0,
    currencyCode: row.currencyCode,
  };
}

/** A typed renewal ready to invoice: the caller's Grant, the rate it was priced at, and what it adds and costs. */
export type CustomRenewalSale = { grant: RenewableGrant; variantId: string; rate: RenewalRateTerms; priced: CustomPriced };

/** Reads the caller's Grant and its product's rate at `at`, and prices `typed` with {@link customRenewalOf}. */
export async function customRenewalSaleOf(
  tx: Prisma.TransactionClient,
  input: { userId: string; grantId: string; typed: CustomAmount; at: Date },
): Promise<CustomRenewalSale> {
  const grant = await callersGrant(tx, input.userId, input.grantId);
  const rate = await renewalRateFor(tx, grant, input.at);
  const places = rate ? await currencyPlacesOf(tx, rate.currencyCode) : 0;
  const priced = customRenewalOf(grant, rate, input.typed, places);
  // `customRenewalOf` refused a null rate above, and a rate needs a product, so a plan; this narrows both.
  if (!rate || !grant.variantId) throw new RenewalRefused('custom_renewal_off', grant.id);
  return { grant, variantId: grant.variantId, rate, priced };
}

/** The typed renewal as the sheet offers it (F-305-e): the rate and this Grant's bounds; prices as decimal strings (C-02). */
export type CustomRenewalView = CustomBounds & { rateId: string; pricePerGib: string; pricePerDay: string; currencyCode: string };

/** What the sheet's typed form shows, or null when custom renewal is off for this Grant (no rate, or no part it can take). */
export function customRenewalView(grant: RenewableGrant, rate: RenewalRateTerms | null): CustomRenewalView | null {
  if (!rate) return null;
  const bounds = customBoundsFor(grant, rate);
  if (bounds.maxGib === 0 && bounds.maxDays === 0) return null;
  return { rateId: rate.id, pricePerGib: rate.pricePerGib.toFixed(), pricePerDay: rate.pricePerDay.toFixed(), currencyCode: rate.currencyCode, ...bounds };
}
