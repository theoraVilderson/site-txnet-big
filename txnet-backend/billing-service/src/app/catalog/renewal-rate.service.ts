import { Injectable } from '@nestjs/common';
import { Prisma, RenewalRate } from '@prisma/client';
import { operatingCurrencyOf } from '@txnet-backend/shared-core';

import { CatalogActor, CatalogAdminService } from './catalog-admin.service';
import type { OffRenewalRateBody, SetRenewalRateBody } from './renewal-rate.schema';

/** The most rows one history answers, newest first (C-28): a rate changes a few times a year. */
const RENEWAL_RATE_HISTORY_SHOWN = 50;

/** One row of a product's renewal-rate history; every rate field null is custom renewal switched off (`isOff`). */
export type RenewalRateView = {
  id: string;
  pricePerGib: string | null;
  pricePerDay: string | null;
  minGib: number | null;
  maxGib: number | null;
  minDays: number | null;
  maxDays: number | null;
  isOff: boolean;
  currencyCode: string;
  effectiveFrom: string;
  createdAt: string;
};
/** The rate a renewal would be priced at now — `null`: custom renewal is off — and the history behind it. */
export type RenewalRates = { inEffect: RenewalRateView | null; history: RenewalRateView[] };

/** The prices and bounds one row stores; `null` switches custom renewal off. */
type RenewalRateTerms = Omit<SetRenewalRateBody, 'effectiveFrom'>;

const NEWEST = [{ effectiveFrom: 'desc' as const }, { createdAt: 'desc' as const }];

const renewalRateView = (r: RenewalRate): RenewalRateView => ({
  id: r.id,
  pricePerGib: r.pricePerGib?.toFixed() ?? null,
  pricePerDay: r.pricePerDay?.toFixed() ?? null,
  minGib: r.minGib,
  maxGib: r.maxGib,
  minDays: r.minDays,
  maxDays: r.maxDays,
  // `renewal_rate_off_whole`: a row is priced whole or not at all, so one column answers.
  isOff: r.pricePerGib === null,
  currencyCode: r.currencyCode,
  effectiveFrom: r.effectiveFrom.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

/**
 * The renewal rate in effect for a product at `at`: the newest row from then
 * or before **in `currencyCode`** (catalog invariant 11 — a row in another
 * currency is no rate). An off row in effect, or none, is `null`: custom
 * renewal is off (ADR-0158 (4)). Never an older rate behind an off row.
 */
export async function renewalRateAt(db: Prisma.TransactionClient, productId: string, at: Date, currencyCode: string): Promise<RenewalRate | null> {
  const row = await db.renewalRate.findFirst({ where: { productId, currencyCode, effectiveFrom: { lte: at } }, orderBy: NEWEST });
  return row && row.pricePerGib !== null ? row : null;
}

/**
 * A product's renewal rate (F-305-b, ADR-0158, catalog `contract.renewal-rate.md`):
 * what the GiB and days a user types on their own Grant cost. History — every
 * write is a new row from `effectiveFrom`, never in the past — and switching
 * off is a row with no rate. The door is the catalog's (`CatalogAdminService`):
 * a tenant prices its own products, the platform owner any tenant's; another
 * tenant's product, or the platform's to a reseller, is not found.
 */
@Injectable()
export class RenewalRateService {
  constructor(private readonly catalog: CatalogAdminService) {}

  /** The rate in effect now, in the product's tenant's currency, and the history newest first. */
  async rates(actor: CatalogActor, productId: string): Promise<RenewalRates> {
    const { owner } = await this.catalog.access(actor);
    return this.catalog.within(owner, async (tx) => {
      const product = await this.catalog.managed(tx, 'product', 'product_not_found', actor, productId, owner);
      const currencyCode = await operatingCurrencyOf(tx, product['tenantId'] as string);
      const inEffect = await renewalRateAt(tx, productId, new Date(), currencyCode);
      const history = await tx.renewalRate.findMany({ where: { productId }, orderBy: NEWEST, take: RENEWAL_RATE_HISTORY_SHOWN });
      return { inEffect: inEffect && renewalRateView(inEffect), history: history.map(renewalRateView) };
    });
  }

  /** A new rate from `effectiveFrom` (absent = now), in the tenant's pricing currency, audited. */
  set(actor: CatalogActor, productId: string, input: SetRenewalRateBody): Promise<RenewalRateView> {
    const { effectiveFrom, ...terms } = input;
    return this.write(actor, productId, terms, effectiveFrom);
  }

  /** Custom renewal switched off from `effectiveFrom` (absent = now): a row with no rate, audited apart. */
  off(actor: CatalogActor, productId: string, input: OffRenewalRateBody): Promise<RenewalRateView> {
    return this.write(actor, productId, null, input.effectiveFrom);
  }

  /** One new row in a product's history — `terms`, or none — audited by which it is. */
  private async write(actor: CatalogActor, productId: string, terms: RenewalRateTerms | null, effectiveFrom: string | undefined): Promise<RenewalRateView> {
    const { owner } = await this.catalog.access(actor);
    const from = this.catalog.effectiveFrom(effectiveFrom);
    return this.catalog.within(owner, async (tx) => {
      const product = await this.catalog.managed(tx, 'product', 'product_not_found', actor, productId, owner);
      const tenantId = product['tenantId'] as string;
      const row = await tx.renewalRate.create({
        data: {
          tenantId,
          productId,
          pricePerGib: terms && new Prisma.Decimal(terms.pricePerGib),
          pricePerDay: terms && new Prisma.Decimal(terms.pricePerDay),
          minGib: terms?.minGib ?? null,
          maxGib: terms?.maxGib ?? null,
          minDays: terms?.minDays ?? null,
          maxDays: terms?.maxDays ?? null,
          // A unit rate is not rounded to the currency's places: the total is, once (ADR-0153).
          currencyCode: await operatingCurrencyOf(tx, tenantId),
          effectiveFrom: from,
          createdByAdminId: actor.adminId,
        },
      });
      const view = renewalRateView(row);
      await this.catalog.audit(tx, actor, tenantId, terms ? 'catalog_renewal_rate_set' : 'catalog_renewal_rate_off', 'renewal_rate', row.id, null, view);
      return view;
    });
  }
}
