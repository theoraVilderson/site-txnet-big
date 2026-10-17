import { Injectable } from '@nestjs/common';
import { MeterCost, Prisma, VariantCost } from '@prisma/client';
import { METER_KEYS, operatingCurrencyOf } from '@txnet-backend/shared-core';

import { CatalogActor, CatalogAdminRefused, CatalogAdminService } from './catalog-admin.service';

/** The most cost rows one list answers, newest first (C-28): a cost changes a few times a year. */
export const COST_HISTORY_SHOWN = 50;

export type VariantCostView = { id: string; amount: string; currencyCode: string; effectiveFrom: string; createdAt: string };
export type MeterCostView = VariantCostView & { unitSize: string };
/** A variant's new cost, as the route parsed it. */
export type VariantCostInput = { amount: string; effectiveFrom?: string };
/** A meter's new unit cost; `tenantId` on the ambient route only (`ownerOfNew`). */
export type MeterCostInput = { tenantId?: string; meterKey: string; unitSize: string; unitCost: string; effectiveFrom?: string };
/** A meter the tenant may cost, and its cost history (newest first). */
export type MeterCostLine = { meterKey: string; unit: string; nameKey: string; costs: MeterCostView[] };

const NEWEST = [{ effectiveFrom: 'desc' as const }, { createdAt: 'desc' as const }];

const variantCostView = (r: VariantCost): VariantCostView => ({
  id: r.id,
  amount: r.amount.toFixed(2),
  currencyCode: r.currencyCode,
  effectiveFrom: r.effectiveFrom.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

const meterCostView = (r: MeterCost): MeterCostView => ({
  id: r.id,
  amount: r.unitCost.toFixed(),
  unitSize: r.unitSize.toString(),
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
 * tenant's variant, or the platform's to a reseller, is not found.
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
  async setVariantCost(actor: CatalogActor, variantId: string, input: VariantCostInput): Promise<VariantCostView> {
    const { owner } = await this.catalog.access(actor);
    return this.catalog.within(owner, async (tx) => {
      const variant = await this.catalog.managed(tx, 'productVariant', 'variant_not_found', actor, variantId, owner);
      const tenantId = variant['tenantId'] as string;
      const row = await tx.variantCost.create({
        data: {
          tenantId,
          variantId,
          amount: new Prisma.Decimal(input.amount),
          currencyCode: await operatingCurrencyOf(tx, tenantId),
          effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
          createdByAdminId: actor.adminId,
        },
      });
      const view = variantCostView(row);
      await this.catalog.audit(tx, actor, tenantId, 'catalog_variant_cost_set', 'variant_cost', row.id, null, view);
      return view;
    });
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
  async setMeterCost(actor: CatalogActor, input: MeterCostInput): Promise<MeterCostView> {
    const tenantId = await this.catalog.ownerOfNew(actor, input.tenantId);
    const { owner } = await this.catalog.access(actor);
    return this.catalog.within(owner, async (tx) => {
      if (!(await tx.meter.findUnique({ where: { key: input.meterKey }, select: { key: true } }))) throw new CatalogAdminRefused('meter_not_found', input.meterKey);
      const row = await tx.meterCost.create({
        data: {
          tenantId,
          meterKey: input.meterKey,
          unitSize: BigInt(input.unitSize),
          unitCost: new Prisma.Decimal(input.unitCost),
          currencyCode: await operatingCurrencyOf(tx, tenantId),
          effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
          createdByAdminId: actor.adminId,
        },
      });
      const view = meterCostView(row);
      await this.catalog.audit(tx, actor, tenantId, 'catalog_meter_cost_set', 'meter_cost', row.id, null, view);
      return view;
    });
  }
}
