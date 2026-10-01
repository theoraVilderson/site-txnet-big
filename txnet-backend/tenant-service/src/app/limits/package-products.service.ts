import { Injectable } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, TenantType } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResellerLimitsRefused, type ResellerLimitsActor } from './reseller-limits.service';

/** One platform product a package lists, as the platform owner's page reads it. */
export type PackageProductView = { productId: string; key: string; nameKey: string; isActive: boolean; listedAt: Date };

/**
 * Which platform products a package lets its subscribers sell (ADR-0107
 * point 3, F-019-v5): `GET|PUT|DELETE /api/tenants/limits/packages/:packageId/products[/:productId]`.
 * Read by shared-core's `platformProductsSoldBy` wherever a variant is sold.
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
      select: { productId: true, createdAt: true, product: { select: { key: true, nameKey: true, isActive: true } } },
      orderBy: { product: { key: 'asc' } },
    });
    return rows.map((r) => ({ productId: r.productId, key: r.product.key, nameKey: r.product.nameKey, isActive: r.product.isActive, listedAt: r.createdAt }));
  }

  /** Lists the product on the package; listing it again writes nothing. */
  async set(actor: ResellerLimitsActor, packageId: string, productId: string): Promise<void> {
    await this.access(actor);
    await this.all.$transaction(async (tx) => {
      await this.packageExists(tx, packageId);
      const product = await tx.product.findUnique({ where: { id: productId }, select: { tenantId: true } });
      if (!product || product.tenantId !== null) throw new ResellerLimitsRefused('product_not_found', productId);
      if (await tx.packageProduct.findUnique({ where: { packageId_productId: { packageId, productId } }, select: { productId: true } })) return;
      await tx.packageProduct.create({ data: { packageId, productId, updatedByUserId: actor.adminId } });
      await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.package_product_set, packageId, productId, false, true) });
    });
  }

  /** Takes the product off the package; what is not listed writes nothing. */
  async clear(actor: ResellerLimitsActor, packageId: string, productId: string): Promise<void> {
    await this.access(actor);
    await this.all.$transaction(async (tx) => {
      const { count } = await tx.packageProduct.deleteMany({ where: { packageId, productId } });
      if (count === 0) return;
      await tx.adminAuditLog.create({ data: this.audit(actor, AdminAction.package_product_clear, packageId, productId, true, false) });
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

  private audit(actor: ResellerLimitsActor, action: AdminAction, packageId: string, productId: string, before: boolean, after: boolean): Prisma.AdminAuditLogUncheckedCreateInput {
    return {
      tenantId: actor.tenantId,
      adminId: actor.adminId,
      action,
      targetEntityType: AuditTargetType.tenant_feature_package,
      targetEntityId: packageId,
      oldValue: { productId, listed: before },
      newValue: { productId, listed: after },
      adminIpAddress: actor.ip,
    };
  }
}
