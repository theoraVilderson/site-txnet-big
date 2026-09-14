import { Injectable, Logger } from '@nestjs/common';
import { FulfilmentKind, Prisma, QualityTier, TenantType, VariantBillingMode, VariantVisibility } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Catalog management (F-026-d; D-34, ADR-0049): categories, products, variants
 * and their price history, behind `catalog.manage`.
 *
 * Reads and writes go through the **cross-tenant** pool, so the boundary is
 * this class's own checks, as in coupon management (ADR-0048 decision 8): the
 * platform owner manages platform items and every tenant's; any other tenant
 * only its own, and another tenant's item — or the platform's — is *not found*.
 *
 * **Nothing is deleted.** A variant may already back a Grant or a coupon scope,
 * so an item is switched off (`isActive`) and a price is too. **A price is
 * history** (F-0602): a change is a new row, and a row effective in the past is
 * refused, because it would reprice an invoice already issued. The database
 * holds both for every writer (`catalog-schema.int.spec.ts`).
 */

export type CatalogActor = { adminId: string; tenantId: string; ip: string };

/** Why a catalog write or read was refused. Closed — the controller gives each a status. */
export type CatalogAdminRejection =
  | 'not_platform_owner'
  | 'tenant_not_found'
  | 'category_not_found'
  | 'product_not_found'
  | 'variant_not_found'
  | 'price_not_found'
  | 'key_taken'
  | 'sku_taken'
  | 'price_in_the_past';

export class CatalogAdminRefused extends Error {
  constructor(
    readonly reason: CatalogAdminRejection,
    detail = '',
  ) {
    super(`catalog refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'CatalogAdminRefused';
  }
}

export type CreateCategoryInput = { tenantId?: string | null; key: string; nameKey: string };
export type UpdateCategoryInput = { nameKey?: string; isActive?: boolean };
export type CreateProductInput = {
  tenantId?: string | null;
  categoryId: string;
  key: string;
  nameKey: string;
  descriptionKey?: string | null;
  fulfilmentKind: FulfilmentKind;
  featureKeys?: string[];
  defaultQuotas?: Record<string, unknown>;
};
export type UpdateProductInput = {
  nameKey?: string;
  descriptionKey?: string | null;
  featureKeys?: string[];
  defaultQuotas?: Record<string, unknown>;
  isActive?: boolean;
};
export type VariantFields = {
  nameKey?: string | null;
  quotas?: Record<string, unknown>;
  durationDays?: number | null;
  visibility?: VariantVisibility;
  panelGroupId?: string | null;
  qualityTier?: QualityTier;
};
export type CreateVariantInput = VariantFields & {
  sku: string;
  billingMode: VariantBillingMode;
  visibility: VariantVisibility;
  /** The first price, base currency (C-02). */
  price: string;
  effectiveFrom?: string;
};
export type UpdateVariantInput = VariantFields & { isActive?: boolean };
export type SetPriceInput = { amount: string; effectiveFrom?: string };
export type ListProductsFilter = { categoryId?: string; tenantId?: string };

export type PriceView = { id: string; variantId: string; amount: string; effectiveFrom: Date; isActive: boolean };
export type CategoryView = { id: string; tenantId: string | null; key: string; nameKey: string; isActive: boolean };
export type ProductView = {
  id: string;
  tenantId: string | null;
  categoryId: string;
  key: string;
  nameKey: string;
  descriptionKey: string | null;
  fulfilmentKind: FulfilmentKind;
  featureKeys: string[];
  defaultQuotas: unknown;
  isActive: boolean;
};
export type VariantView = {
  id: string;
  tenantId: string | null;
  productId: string;
  sku: string;
  nameKey: string | null;
  quotas: unknown;
  durationDays: number | null;
  billingMode: VariantBillingMode;
  visibility: VariantVisibility;
  panelGroupId: string | null;
  qualityTier: QualityTier;
  isActive: boolean;
  /** Newest `effectiveFrom` first. */
  prices: PriceView[];
};

type Row = Record<string, unknown>;

/** Clock skew tolerated between the admin's "now" and ours before a price counts as backdated. */
const PAST_SKEW_MS = 60_000;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const categoryView = (r: Row): CategoryView => ({
  id: r['id'] as string,
  tenantId: (r['tenantId'] as string | null) ?? null,
  key: r['key'] as string,
  nameKey: r['nameKey'] as string,
  isActive: r['isActive'] as boolean,
});

const productView = (r: Row): ProductView => ({
  id: r['id'] as string,
  tenantId: (r['tenantId'] as string | null) ?? null,
  categoryId: r['categoryId'] as string,
  key: r['key'] as string,
  nameKey: r['nameKey'] as string,
  descriptionKey: (r['descriptionKey'] as string | null) ?? null,
  fulfilmentKind: r['fulfilmentKind'] as FulfilmentKind,
  featureKeys: (r['featureKeys'] as string[] | undefined) ?? [],
  defaultQuotas: r['defaultQuotas'] ?? {},
  isActive: r['isActive'] as boolean,
});

const priceView = (r: Row): PriceView => ({
  id: r['id'] as string,
  variantId: r['variantId'] as string,
  amount: new Prisma.Decimal(r['amount'] as Prisma.Decimal.Value).toFixed(2),
  effectiveFrom: r['effectiveFrom'] as Date,
  isActive: r['isActive'] as boolean,
});

const variantView = (r: Row, prices: Row[]): VariantView => ({
  id: r['id'] as string,
  tenantId: (r['tenantId'] as string | null) ?? null,
  productId: r['productId'] as string,
  sku: r['sku'] as string,
  nameKey: (r['nameKey'] as string | null) ?? null,
  quotas: r['quotas'] ?? {},
  durationDays: (r['durationDays'] as number | null) ?? null,
  billingMode: r['billingMode'] as VariantBillingMode,
  visibility: r['visibility'] as VariantVisibility,
  panelGroupId: (r['panelGroupId'] as string | null) ?? null,
  qualityTier: r['qualityTier'] as QualityTier,
  isActive: r['isActive'] as boolean,
  prices: prices
    .map(priceView)
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime()),
});

@Injectable()
export class CatalogAdminService {
  private readonly logger = new Logger(CatalogAdminService.name);

  constructor(
    /** The caller's own tenant, bound by RLS — used for one read: who is asking. */
    private readonly prisma: PrismaService,
    /** Every tenant's catalog rows, by policy. See the class comment. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /** Whether the caller is the platform owner. */
  async access(actor: CatalogActor): Promise<{ owner: boolean }> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    return { owner: tenant?.tenantType === TenantType.platform_owner };
  }

  /** Whose a new item is. Absent = the caller's tenant; `null` = the platform's; another tenant = the owner's alone. */
  async ownerOfNew(actor: CatalogActor, requested: string | null | undefined): Promise<string | null> {
    const tenantId = requested === undefined ? actor.tenantId : requested;
    if (tenantId === actor.tenantId) return tenantId;
    const { owner } = await this.access(actor);
    if (!owner) throw new CatalogAdminRefused('not_platform_owner', tenantId === null ? 'a platform item' : "another tenant's item");
    if (tenantId !== null && !(await this.all.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      throw new CatalogAdminRefused('tenant_not_found', tenantId);
    }
    return tenantId;
  }

  // ---------------------------------------------------------------- categories

  async listCategories(actor: CatalogActor): Promise<CategoryView[]> {
    const { owner } = await this.access(actor);
    // A tenant sees the platform's shared categories beside its own: it files products in either.
    const rows = await this.all.productCategory.findMany({
      where: owner ? {} : { OR: [{ tenantId: null }, { tenantId: actor.tenantId }] },
      orderBy: { key: 'asc' },
    });
    return (rows as unknown as Row[]).map(categoryView);
  }

  async createCategory(actor: CatalogActor, input: CreateCategoryInput): Promise<CategoryView> {
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    return this.all.$transaction(async (tx) => {
      const row = (await this.refuseDuplicate('key_taken', input.key, () =>
        tx.productCategory.create({ data: { tenantId, key: input.key, nameKey: input.nameKey } }),
      )) as unknown as Row;
      const view = categoryView(row);
      await this.audit(tx, actor, tenantId, 'catalog_category_create', 'product_category', view.id, null, view);
      return view;
    });
  }

  async updateCategory(actor: CatalogActor, id: string, patch: UpdateCategoryInput): Promise<CategoryView> {
    const { owner } = await this.access(actor);
    const before = await this.managed('productCategory', 'category_not_found', actor, id, owner);
    return this.all.$transaction(async (tx) => {
      const row = (await tx.productCategory.update({ where: { id }, data: patch })) as unknown as Row;
      const view = categoryView(row);
      await this.audit(tx, actor, view.tenantId, 'catalog_category_update', 'product_category', id, categoryView(before), view);
      return view;
    });
  }

  // ------------------------------------------------------------------ products

  async listProducts(actor: CatalogActor, filter: ListProductsFilter = {}): Promise<ProductView[]> {
    const { owner } = await this.access(actor);
    const tenant = owner ? (filter.tenantId === 'platform' ? null : filter.tenantId) : actor.tenantId;
    const rows = await this.all.product.findMany({
      where: { ...(tenant === undefined ? {} : { tenantId: tenant }), ...(filter.categoryId ? { categoryId: filter.categoryId } : {}) },
      orderBy: { key: 'asc' },
    });
    return (rows as unknown as Row[]).map(productView);
  }

  /** A product with its variants and each variant's whole price history. */
  async getProduct(actor: CatalogActor, id: string): Promise<ProductView & { variants: VariantView[] }> {
    const { owner } = await this.access(actor);
    const product = await this.managed('product', 'product_not_found', actor, id, owner);
    const variants = (await this.all.productVariant.findMany({ where: { productId: id }, orderBy: { sku: 'asc' } })) as unknown as Row[];
    const withPrices = await Promise.all(
      variants.map(async (v) =>
        variantView(v, (await this.all.price.findMany({ where: { variantId: v['id'] as string } })) as unknown as Row[]),
      ),
    );
    return { ...productView(product), variants: withPrices };
  }

  async createProduct(actor: CatalogActor, input: CreateProductInput): Promise<ProductView> {
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    const category = (await this.all.productCategory.findUnique({ where: { id: input.categoryId } })) as unknown as Row | null;
    // The platform's shared category holds anyone's products; a tenant's only its own.
    if (!category || (category['tenantId'] !== null && category['tenantId'] !== tenantId)) {
      throw new CatalogAdminRefused('category_not_found', input.categoryId);
    }
    return this.all.$transaction(async (tx) => {
      const row = (await this.refuseDuplicate('key_taken', input.key, () =>
        tx.product.create({
          data: {
            tenantId,
            categoryId: input.categoryId,
            key: input.key,
            nameKey: input.nameKey,
            descriptionKey: input.descriptionKey ?? null,
            fulfilmentKind: input.fulfilmentKind,
            featureKeys: input.featureKeys ?? [],
            defaultQuotas: (input.defaultQuotas ?? {}) as Prisma.InputJsonValue,
          },
        }),
      )) as unknown as Row;
      const view = productView(row);
      await this.audit(tx, actor, tenantId, 'catalog_product_create', 'product', view.id, null, view);
      return view;
    });
  }

  /** The key and fulfilment kind stay: a key is referenced by string, and a Grant's handler by its kind. */
  async updateProduct(actor: CatalogActor, id: string, patch: UpdateProductInput): Promise<ProductView> {
    const { owner } = await this.access(actor);
    const before = await this.managed('product', 'product_not_found', actor, id, owner);
    return this.all.$transaction(async (tx) => {
      const data: Prisma.ProductUpdateInput = {
        ...(patch.nameKey !== undefined ? { nameKey: patch.nameKey } : {}),
        ...(patch.descriptionKey !== undefined ? { descriptionKey: patch.descriptionKey } : {}),
        ...(patch.featureKeys !== undefined ? { featureKeys: patch.featureKeys } : {}),
        ...(patch.defaultQuotas !== undefined ? { defaultQuotas: patch.defaultQuotas as Prisma.InputJsonValue } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      };
      const view = productView((await tx.product.update({ where: { id }, data })) as unknown as Row);
      await this.audit(tx, actor, view.tenantId, 'catalog_product_update', 'product', id, productView(before), view);
      return view;
    });
  }

  // ------------------------------------------------------------------ variants

  /** A variant takes its product's tenant, and is written with its first price. */
  async createVariant(actor: CatalogActor, productId: string, input: CreateVariantInput): Promise<VariantView> {
    const { owner } = await this.access(actor);
    const product = await this.managed('product', 'product_not_found', actor, productId, owner);
    const tenantId = (product['tenantId'] as string | null) ?? null;
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);

    return this.all.$transaction(async (tx) => {
      const variant = (await this.refuseDuplicate('sku_taken', input.sku, () =>
        tx.productVariant.create({
          data: {
            tenantId,
            productId,
            sku: input.sku,
            nameKey: input.nameKey ?? null,
            quotas: (input.quotas ?? product['defaultQuotas'] ?? {}) as Prisma.InputJsonValue,
            durationDays: input.durationDays ?? null,
            billingMode: input.billingMode,
            visibility: input.visibility,
            panelGroupId: input.panelGroupId ?? null,
            qualityTier: input.qualityTier ?? QualityTier.standard,
          },
        }),
      )) as unknown as Row;
      const price = (await tx.price.create({
        data: {
          tenantId,
          variantId: variant['id'] as string,
          amount: new Prisma.Decimal(input.price),
          effectiveFrom,
          createdByAdminId: actor.adminId,
        },
      })) as unknown as Row;
      const view = variantView(variant, [price]);
      await this.audit(tx, actor, tenantId, 'catalog_variant_create', 'product_variant', view.id, null, view);
      return view;
    });
  }

  /** The SKU and billing mode stay: a link names the SKU, and a Grant copied the mode. */
  async updateVariant(actor: CatalogActor, id: string, patch: UpdateVariantInput): Promise<VariantView> {
    const { owner } = await this.access(actor);
    const before = await this.managed('productVariant', 'variant_not_found', actor, id, owner);
    return this.all.$transaction(async (tx) => {
      const data: Prisma.ProductVariantUpdateInput = {
        ...(patch.nameKey !== undefined ? { nameKey: patch.nameKey } : {}),
        ...(patch.quotas !== undefined ? { quotas: patch.quotas as Prisma.InputJsonValue } : {}),
        ...(patch.durationDays !== undefined ? { durationDays: patch.durationDays } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.panelGroupId !== undefined ? { panelGroupId: patch.panelGroupId } : {}),
        ...(patch.qualityTier !== undefined ? { qualityTier: patch.qualityTier } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      };
      const row = (await tx.productVariant.update({ where: { id }, data })) as unknown as Row;
      const prices = (await tx.price.findMany({ where: { variantId: id } })) as unknown as Row[];
      const view = variantView(row, prices);
      await this.audit(tx, actor, view.tenantId, 'catalog_variant_update', 'product_variant', id, variantView(before, []), { ...view, prices: undefined });
      return view;
    });
  }

  // -------------------------------------------------------------------- prices

  /** A price change is a new row from `effectiveFrom` (default now) on; the old row is never touched. */
  async setPrice(actor: CatalogActor, variantId: string, input: SetPriceInput): Promise<PriceView> {
    const { owner } = await this.access(actor);
    const variant = await this.managed('productVariant', 'variant_not_found', actor, variantId, owner);
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    const tenantId = (variant['tenantId'] as string | null) ?? null;
    return this.all.$transaction(async (tx) => {
      const row = (await tx.price.create({
        data: { tenantId, variantId, amount: new Prisma.Decimal(input.amount), effectiveFrom, createdByAdminId: actor.adminId },
      })) as unknown as Row;
      const view = priceView(row);
      await this.audit(tx, actor, tenantId, 'catalog_price_set', 'price', view.id, null, view);
      return view;
    });
  }

  /** Switches a price off. The row stays: it is what an invoice issued under it was computed at. */
  async deactivatePrice(actor: CatalogActor, priceId: string): Promise<PriceView> {
    const { owner } = await this.access(actor);
    const before = await this.managed('price', 'price_not_found', actor, priceId, owner);
    return this.all.$transaction(async (tx) => {
      const view = priceView((await tx.price.update({ where: { id: priceId }, data: { isActive: false } })) as unknown as Row);
      await this.audit(tx, actor, (before['tenantId'] as string | null) ?? null, 'catalog_price_deactivate', 'price', priceId, priceView(before), view);
      return view;
    });
  }

  // ------------------------------------------------------------------- helpers

  /** A row the caller may manage, or the table's own *not found* — another tenant's and the platform's alike. */
  private async managed(
    model: 'productCategory' | 'product' | 'productVariant' | 'price',
    missing: CatalogAdminRejection,
    actor: CatalogActor,
    id: string,
    owner: boolean,
  ): Promise<Row> {
    const delegate = this.all[model] as unknown as { findUnique(args: { where: { id: string } }): Promise<Row | null> };
    const row = await delegate.findUnique({ where: { id } });
    if (!row || (!owner && row['tenantId'] !== actor.tenantId)) throw new CatalogAdminRefused(missing, id);
    return row;
  }

  /** `effectiveFrom` as given, or now; a backdated one would reprice an issued invoice. */
  private effectiveFrom(requested: string | undefined): Date {
    if (requested === undefined) return new Date();
    const at = new Date(requested);
    if (at.getTime() < Date.now() - PAST_SKEW_MS) throw new CatalogAdminRefused('price_in_the_past', requested);
    return at;
  }

  /** A unique violation as its refusal. Postgres aborts the transaction, so nothing else is tried after it. */
  private async refuseDuplicate<T>(reason: 'key_taken' | 'sku_taken', value: string, create: () => Promise<T>): Promise<T> {
    try {
      return await create();
    } catch (e) {
      if (isUniqueViolation(e)) throw new CatalogAdminRefused(reason, value);
      throw e;
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: CatalogActor,
    tenantId: string | null,
    action: Prisma.AdminAuditLogUncheckedCreateInput['action'],
    targetEntityType: Prisma.AdminAuditLogUncheckedCreateInput['targetEntityType'],
    targetEntityId: string,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        tenantId: tenantId ?? actor.tenantId,
        adminId: actor.adminId,
        action,
        targetEntityType,
        targetEntityId,
        oldValue: oldValue === null ? Prisma.DbNull : (JSON.parse(JSON.stringify(oldValue)) as Prisma.InputJsonValue),
        newValue: JSON.parse(JSON.stringify(newValue)) as Prisma.InputJsonValue,
        adminIpAddress: actor.ip,
      },
    });
    this.logger.log(`${action} ${targetEntityId} by ${actor.adminId}`);
  }
}
