import { Injectable } from '@nestjs/common';
import { MeterCost, Prisma, VariantCost } from '@prisma/client';
import { METER_KEYS, operatingCurrencyOf, moneyText } from '@txnet-backend/shared-core';

import { restateCostsFrom } from '../analytics/analytics-rollup-own-cost';
import { CatalogActor, CatalogAdminRefused, CatalogAdminService, pricedIn } from './catalog-admin.service';

/** The most cost rows one list answers, newest first (C-28): a cost changes a few times a year. */
export const COST_HISTORY_SHOWN = 50;

/** One row of a cost's history; `amount` null is a cost taken back — not set from `effectiveFrom` (F-1002-i). */
export type VariantCostView = { id: string; amount: string | null; currencyCode: string; effectiveFrom: string; createdAt: string };
export type MeterCostView = VariantCostView & { unitSize: string | null };
/** A variant's new cost, as the route parsed it. */
export type VariantCostInput = { amount: string; effectiveFrom?: string };
/** A variant's cost taken back from `effectiveFrom` (absent = now). */
export type VariantCostUnsetInput = { effectiveFrom?: string };
/** A meter's new unit cost; `tenantId` on the ambient route only (`ownerOfNew`). */
export type MeterCostInput = { tenantId?: string; meterKey: string; unitSize: string; unitCost: string; effectiveFrom?: string };
/** A meter's cost taken back; `tenantId` as `MeterCostInput`'s. */
export type MeterCostUnsetInput = { tenantId?: string; meterKey: string; effectiveFrom?: string };

/** What one write puts in a variant's history: a cost, or `null` to take it back. */
type VariantCostWrite = { amount: Prisma.Decimal | null; effectiveFrom?: string; action: 'catalog_variant_cost_set' | 'catalog_variant_cost_unset' };
/** The same for a meter: a unit cost for a unit size, or neither. */
type MeterCostWrite = {
  tenantId?: string;
  meterKey: string;
  per: { unitSize: bigint; unitCost: Prisma.Decimal } | null;
  effectiveFrom?: string;
  action: 'catalog_meter_cost_set' | 'catalog_meter_cost_unset';
};

const startOf = (effectiveFrom?: string) => (effectiveFrom ? new Date(effectiveFrom) : new Date());
/** A meter the tenant may cost, and its cost history (newest first). */
export type MeterCostLine = { meterKey: string; unit: string; nameKey: string; costs: MeterCostView[] };

const NEWEST = [{ effectiveFrom: 'desc' as const }, { createdAt: 'desc' as const }];

const variantCostView = (r: VariantCost): VariantCostView => ({
  id: r.id,
  amount: r.amount ? moneyText(r.amount) : null,
  currencyCode: r.currencyCode,
  effectiveFrom: r.effectiveFrom.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

const meterCostView = (r: MeterCost): MeterCostView => ({
  id: r.id,
  amount: r.unitCost?.toFixed() ?? null,
  unitSize: r.unitSize?.toString() ?? null,
  currencyCode: r.currencyCode,
  effectiveFrom: r.effectiveFrom.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

/**
 * A product's cost (F-1002-d, ADR-0151, catalog `contract.cost.md`): what one
 * sale of a variant, and a unit of a meter, cost the tenant that sells it.
 * History — every write is a new row from `effectiveFrom` — and private to its
 * tenant (RLS). The door is the catalog's own (`CatalogAdminService`): a
 * tenant costs its own items, the platform owner any tenant's; another
 * tenant's variant, or the platform's to a reseller, is not found. A write
 * asks analytics to restate the tenant's cost rows from its day (F-1002-e). A
 * cost is taken back by a row with none (F-1002-i), audited apart.
 */
@Injectable()
export class CatalogCostService {
  constructor(private readonly catalog: CatalogAdminService) {}

  /** A variant's cost history, newest first. */
  async variantCosts(actor: CatalogActor, variantId: string): Promise<VariantCostView[]> {
    const { owner } = await this.catalog.access(actor);
    return this.catalog.within(owner, async (tx) => {
      await this.catalog.managed(tx, 'productVariant', 'variant_not_found', actor, variantId, owner);
      return (await tx.variantCost.findMany({ where: { variantId }, orderBy: NEWEST, take: COST_HISTORY_SHOWN })).map(variantCostView);
    });
  }

  /** A new cost for one sale of a variant, in its tenant's pricing currency, audited. */
  setVariantCost(actor: CatalogActor, variantId: string, input: VariantCostInput): Promise<VariantCostView> {
    return this.writeVariantCost(actor, variantId, { amount: new Prisma.Decimal(input.amount), effectiveFrom: input.effectiveFrom, action: 'catalog_variant_cost_set' });
  }

  /** A variant's cost taken back: "not set" from `effectiveFrom` on — its sales read `noCost`, not a margin of 100% (F-1002-i). */
  unsetVariantCost(actor: CatalogActor, variantId: string, input: VariantCostUnsetInput): Promise<VariantCostView> {
    return this.writeVariantCost(actor, variantId, { amount: null, effectiveFrom: input.effectiveFrom, action: 'catalog_variant_cost_unset' });
  }

  /** Every meter but `vpn.traffic`, each with the tenant's cost history. */
  async meterCosts(actor: CatalogActor, requestedTenant?: string): Promise<MeterCostLine[]> {
    const tenantId = await this.catalog.ownerOfNew(actor, requestedTenant);
    const { owner } = await this.catalog.access(actor);
    return this.catalog.within(owner, async (tx) => {
      const meters = await tx.meter.findMany({ where: { key: { not: METER_KEYS.vpnTraffic } }, orderBy: { key: 'asc' } });
      const costs = await tx.meterCost.findMany({ where: { tenantId }, orderBy: NEWEST, take: COST_HISTORY_SHOWN * meters.length });
      return meters.map((m) => ({
        meterKey: m.key,
        unit: m.unit,
        nameKey: m.nameKey,
        costs: costs.filter((c) => c.meterKey === m.key).slice(0, COST_HISTORY_SHOWN).map(meterCostView),
      }));
    });
  }

  /** A new unit cost for one meter, in the tenant's pricing currency, audited. */
  setMeterCost(actor: CatalogActor, input: MeterCostInput): Promise<MeterCostView> {
    const per = { unitSize: BigInt(input.unitSize), unitCost: new Prisma.Decimal(input.unitCost) };
    return this.writeMeterCost(actor, { tenantId: input.tenantId, meterKey: input.meterKey, per, effectiveFrom: input.effectiveFrom, action: 'catalog_meter_cost_set' });
  }

  /** A meter's cost taken back from `effectiveFrom` on (F-1002-i). */
  unsetMeterCost(actor: CatalogActor, input: MeterCostUnsetInput): Promise<MeterCostView> {
    return this.writeMeterCost(actor, { ...input, per: null, action: 'catalog_meter_cost_unset' });
  }

  /** One new row in a variant's cost history, in its tenant's pricing currency, audited, its days restated. */
  private async writeVariantCost(actor: CatalogActor, variantId: string, write: VariantCostWrite): Promise<VariantCostView> {
    const { owner } = await this.catalog.access(actor);
    return this.catalog.within(owner, async (tx) => {
      const variant = await this.catalog.managed(tx, 'productVariant', 'variant_not_found', actor, variantId, owner);
      const tenantId = variant['tenantId'] as string;
      const row = await tx.variantCost.create({
        data: {
          tenantId,
          variantId,
          amount: write.amount,
          // A cost taken back has no amount; one set is at its currency's places (F-116-r).
          currencyCode: write.amount ? await pricedIn(tx, tenantId, write.amount) : await operatingCurrencyOf(tx, tenantId),
          effectiveFrom: startOf(write.effectiveFrom),
          createdByAdminId: actor.adminId,
        },
      });
      const view = variantCostView(row);
      await this.catalog.audit(tx, actor, tenantId, write.action, 'variant_cost', row.id, null, view);
      await restateCostsFrom(tx, tenantId, row.effectiveFrom);
      return view;
    });
  }

  /** One new row in a meter's cost history — `MeterCostWrite`'s `per`, or neither — audited, its days restated. */
  private async writeMeterCost(actor: CatalogActor, write: MeterCostWrite): Promise<MeterCostView> {
    const tenantId = await this.catalog.ownerOfNew(actor, write.tenantId);
    const { owner } = await this.catalog.access(actor);
    return this.catalog.within(owner, async (tx) => {
      if (!(await tx.meter.findUnique({ where: { key: write.meterKey }, select: { key: true } }))) throw new CatalogAdminRefused('meter_not_found', write.meterKey);
      const row = await tx.meterCost.create({
        data: {
          tenantId,
          meterKey: write.meterKey,
          unitSize: write.per?.unitSize ?? null,
          unitCost: write.per?.unitCost ?? null,
          currencyCode: await operatingCurrencyOf(tx, tenantId),
          effectiveFrom: startOf(write.effectiveFrom),
          createdByAdminId: actor.adminId,
        },
      });
      const view = meterCostView(row);
      await this.catalog.audit(tx, actor, tenantId, write.action, 'meter_cost', row.id, null, view);
      await restateCostsFrom(tx, tenantId, row.effectiveFrom);
      return view;
    });
  }
}
