import { FulfilmentKind, QualityTier, QuotaMetric, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { z } from 'zod';

/**
 * The wire shapes of catalog management (F-026-d).
 *
 * **`.strict()` on every body.** An unknown key is refused, not dropped: a
 * client sending `tenantId` on an update or `sku` on a variant edit expects it
 * to land. The key, a product's fulfilment kind, a variant's SKU and billing
 * mode are not editable at all (`CatalogAdminService` says why).
 *
 * Decimals are strings (C-02); closed sets come from Prisma enums or a tuple
 * declared here (C-09).
 */

/** How a quota counts again (§4.5): never, every month, every day. */
export const RESET_POLICIES = ['none', 'monthly', 'daily'] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
/** A stable string key referenced elsewhere: `vpn`, `vpn_basic`. */
const KEY = /^[a-z][a-z0-9_]{1,63}$/;
/** An i18n key (§4.3): `catalog.product.vpn_basic.name`. */
const I18N_KEY = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
/** A feature a Grant unlocks: `vpn.access`, `api.public`. */
const FEATURE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** A SKU travels in a link (`?start=buy_<sku>`, F-314). */
const SKU = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

const decimal = (what: string) => z.string({ message: `${what} must be a decimal string` }).regex(DECIMAL, { message: `${what} must be a decimal string` });
const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });
const instant = (what: string) => z.string().datetime({ offset: true, message: `${what} must be an ISO instant` });
const i18nKey = (what: string) => z.string().regex(I18N_KEY, { message: `${what} must be an i18n key` });

/** Quota per metric (§4.5). A metric absent from the map has no quota. */
const quotas = z.record(
  z.nativeEnum(QuotaMetric),
  z.object({ limit: z.number().int().min(0), resetPolicy: z.enum(RESET_POLICIES) }).strict(),
);

const featureKeys = z.array(z.string().regex(FEATURE_KEY, { message: 'a feature key looks like vpn.access' })).max(50);

export const createCategorySchema = z
  .object({ tenantId: uuid('tenantId').nullable().optional(), key: z.string().regex(KEY), nameKey: i18nKey('nameKey') })
  .strict();

export const updateCategorySchema = z.object({ nameKey: i18nKey('nameKey').optional(), isActive: z.boolean().optional() }).strict();

export const listProductsSchema = z.object({
  categoryId: uuid('categoryId').optional(),
  /** Platform owner only: a tenant id, or `platform`. */
  tenantId: z.union([z.literal('platform'), uuid('tenantId')]).optional(),
});

export const createProductSchema = z
  .object({
    tenantId: uuid('tenantId').nullable().optional(),
    categoryId: uuid('categoryId'),
    key: z.string().regex(KEY),
    nameKey: i18nKey('nameKey'),
    descriptionKey: i18nKey('descriptionKey').nullable().optional(),
    fulfilmentKind: z.nativeEnum(FulfilmentKind),
    featureKeys: featureKeys.optional(),
    defaultQuotas: quotas.optional(),
  })
  .strict();

export const updateProductSchema = z
  .object({
    nameKey: i18nKey('nameKey').optional(),
    descriptionKey: i18nKey('descriptionKey').nullable().optional(),
    featureKeys: featureKeys.optional(),
    defaultQuotas: quotas.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const variantFields = {
  nameKey: i18nKey('nameKey').nullable().optional(),
  quotas: quotas.optional(),
  /** Null = permanent; at most ten years. */
  durationDays: z.number().int().min(1).max(3650).nullable().optional(),
  visibility: z.nativeEnum(VariantVisibility).optional(),
  panelGroupId: uuid('panelGroupId').nullable().optional(),
  qualityTier: z.nativeEnum(QualityTier).optional(),
};

export const createVariantSchema = z
  .object({
    ...variantFields,
    sku: z.string().regex(SKU, { message: 'a SKU is 2-40 upper-case letters, digits, _ or -' }),
    billingMode: z.nativeEnum(VariantBillingMode),
    visibility: z.nativeEnum(VariantVisibility),
    price: decimal('price'),
    effectiveFrom: instant('effectiveFrom').optional(),
  })
  .strict();

export const updateVariantSchema = z.object({ ...variantFields, isActive: z.boolean().optional() }).strict();

export const setPriceSchema = z.object({ amount: decimal('amount'), effectiveFrom: instant('effectiveFrom').optional() }).strict();

export type CreateCategoryBody = z.infer<typeof createCategorySchema>;
export type UpdateCategoryBody = z.infer<typeof updateCategorySchema>;
export type ListProductsQuery = z.infer<typeof listProductsSchema>;
export type CreateProductBody = z.infer<typeof createProductSchema>;
export type UpdateProductBody = z.infer<typeof updateProductSchema>;
export type CreateVariantBody = z.infer<typeof createVariantSchema>;
export type UpdateVariantBody = z.infer<typeof updateVariantSchema>;
export type SetPriceBody = z.infer<typeof setPriceSchema>;
