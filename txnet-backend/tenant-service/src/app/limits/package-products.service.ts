import { Injectable } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, QuotaOverageMode, TenantType } from '@prisma/client';
import { lockProductQuotaTerms, overageTermsOf, platformCurrencyOf } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SetPackageProductInput } from './reseller-limits.schema';
import { overageView, ResellerLimitsRefused, type OverageView, type ResellerLimitsActor } from './reseller-limits.service';

/** A listing's sales quota (F-019-v6): included per window (`null` = no bound), and past any of them. */
export type ProductQuotaView = { day: number | null; week: number | null; month: number | null; overage: OverageView };

/** One platform product a package lists, as the platform owner's page reads it. */
export type PackageProductView = { productId: string; key: string; nameKey: string; isActive: boolean; listedAt: Date; quota: ProductQuotaView };

const QUOTA_SELECT = { dayIncluded: true, weekIncluded: true, monthIncluded: true, mode: true, unitPrice: true, currencyCode: true } as const;
type QuotaColumns = Prisma.PackageProductGetPayload<{ select: typeof QUOTA_SELECT }>;

function quotaView(row: QuotaColumns): ProductQuotaView {
  return { day: row.dayIncluded, week: row.weekIncluded, month: row.monthIncluded, overage: overageView(overageTermsOf(row)) };
}

/**
 * Which platform products a package lets its subscribers sell (ADR-0107
 * point 3, F-019-v5), and by what sales quota (F-019-v6):
 * `GET|PUT|DELETE /api/tenants/limits/packages/:packageId/products[/:productId]`.
 * Read by shared-core's `platformProductsSoldBy` and `productQuotaTermsOf`
 * wherever a variant is sold.
 *
 * A change to a listing's terms, or taking it off, first freezes the terms in
 * force for each subscriber's paid period (`lockProductQuotaTerms`, ADR-0107
 * point 8): a cut waits for the next period, a gift applies at once.
 *
 * The platform owner only, as every limit write; on the cross-tenant pool;
 * each change audited in its transaction against the package. Only a
 * platform product is listed — a reseller's own is never bounded by its
 * package (`package_product_is_platform` holds it in the database too).
 */
@Injectable()
export class PackageProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async list(actor: ResellerLimitsActor, packageId: string): Promise<PackageProductView[]> {
    await this.access(actor);
    await this.packageExists(this.all, packageId);
    const rows = await this.all.packageProduct.findMany({
      where: { packageId },
      select: { productId: true, createdAt: true, ...QUOTA_SELECT, product: { select: { key: true, nameKey: true, isActive: true } } },
      orderBy: { product: { key: 'asc' } },
    });
    return rows.map((r) => ({ productId: r.productId, key: r.product.key, nameKey: r.product.nameKey, isActive: r.product.isActive, listedAt: r.createdAt, quota: quotaView(r) }));
  }

  /** Lists the product on the package with these terms; the same terms again write nothing. */
  async set(actor: ResellerLimitsActor, packageId: string, productId: string, input: SetPackageProductInput = {}): Promise<void> {
    await this.access(actor);
    await this.all.$transaction(async (tx) => {
      await this.packageExists(tx, packageId);
      const product = await tx.product.findUnique({ where: { id: productId }, select: { tenantId: true } });
      if (!product || product.tenantId !== null) throw new ResellerLimitsRefused('product_not_found', productId);
      const terms = await this.termsOf(tx, input);
      const where = { packageId_productId: { packageId, productId } };
      const before = await tx.packageProduct.findUnique({ where, select: QUOTA_SELECT });
      if (before && sameTerms(before, terms)) return;
      // The subscribers keep the terms they paid this period for (ADR-0107 point 8).
      if (before) await lockProductQuotaTerms(tx, { packageId }, [productId]);
      const data = { ...terms, updatedByUserId: actor.adminId };
      await tx.packageProduct.upsert({ where, create: { packageId, productId, ...data }, update: data });
      await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.package_product_set, packageId, productId, before ? quotaView(before) : 'unlisted', quotaView(terms)) });
    });
  }

  /** Takes the product off the package; what is not listed writes nothing. */
  async clear(actor: ResellerLimitsActor, packageId: string, productId: string): Promise<void> {
    await this.access(actor);
    await this.all.$transaction(async (tx) => {
      const before = await tx.packageProduct.findUnique({ where: { packageId_productId: { packageId, productId } }, select: QUOTA_SELECT });
      if (!before) return;
      // Taken off, it is still sold to each subscriber until its paid period ends, on these terms (ADR-0107 point 8).
      await lockProductQuotaTerms(tx, { packageId }, [productId]);
      await tx.packageProduct.deleteMany({ where: { packageId, productId } });
      await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.package_product_clear, packageId, productId, quotaView(before), 'unlisted') });
    });
  }

  private async packageExists(db: Pick<Prisma.TransactionClient, 'tenantFeaturePackage'>, packageId: string): Promise<void> {
    if (!(await db.tenantFeaturePackage.findUnique({ where: { id: packageId }, select: { id: true } }))) throw new ResellerLimitsRefused('package_not_found', packageId);
  }

  /** The platform owner's tenant — the same check as every limit write. */
  private async access(actor: ResellerLimitsActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) throw new ResellerLimitsRefused('not_platform_owner', 'package products');
  }

  /** The row's quota columns; an overage price is stamped with the platform's currency, as every overage price. */
  private async termsOf(tx: Prisma.TransactionClient, input: SetPackageProductInput): Promise<QuotaColumns> {
    const windows = { dayIncluded: input.day ?? null, weekIncluded: input.week ?? null, monthIncluded: input.month ?? null };
    if (input.overage?.mode !== 'overage') return { ...windows, mode: QuotaOverageMode.stop, unitPrice: null, currencyCode: null };
    return { ...windows, mode: QuotaOverageMode.overage, unitPrice: new Prisma.Decimal(input.overage.unitPrice), currencyCode: await platformCurrencyOf(tx) };
  }

  private audit(actor: ResellerLimitsActor, action: AdminAction, packageId: string, productId: string, before: Held, after: Held): Prisma.AdminAuditLogUncheckedCreateInput {
    return {
      tenantId: actor.tenantId,
      adminId: actor.adminId,
      action,
      targetEntityType: AuditTargetType.tenant_feature_package,
      targetEntityId: packageId,
      oldValue: { productId, quota: before },
      newValue: { productId, quota: after },
      adminIpAddress: actor.ip,
    };
  }
}

/** What an audit row says a listing held: its quota, or `'unlisted'`. */
type Held = ProductQuotaView | 'unlisted';

function sameTerms(a: QuotaColumns, b: QuotaColumns): boolean {
  const price = (r: QuotaColumns) => r.unitPrice?.toFixed(2) ?? null;
  return (
    a.dayIncluded === b.dayIncluded &&
    a.weekIncluded === b.weekIncluded &&
    a.monthIncluded === b.monthIncluded &&
    a.mode === b.mode &&
    price(a) === price(b) &&
    a.currencyCode === b.currencyCode
  );
}
