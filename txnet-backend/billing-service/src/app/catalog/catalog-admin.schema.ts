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

/**
 * Kinds kept in the enum for rows that already exist, but never created again
 * (F-111-g, the user's call 2026-09-25): `wallet_topup` paid from the wallet
 * debits and credits the same wallet, and money comes in through one path only
 * — the deposit page (`contract.deposit.md`). A credit bonus is a deposit coupon.
 * `external_order` (F-111-h, the user's call 2026-09-25) until a real provider
 * exists: a generic order API designed with no counterpart would not fit the
 * first one. That provider is a row of its own, and un-retires the kind.
 */
export const RETIRED_FULFILMENT_KINDS = ['wallet_topup', 'external_order'] as const;
const RETIRED: readonly FulfilmentKind[] = RETIRED_FULFILMENT_KINDS;
const CREATABLE_FULFILMENT_KINDS = Object.values(FulfilmentKind).filter(
  (k) => !RETIRED.includes(k),
) as [FulfilmentKind, ...FulfilmentKind[]];

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
/** A language code as locale-service names it: `fa`, `de`, `pt-BR`. Which exist is locale-service's answer, not a list here (§1.1). */
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const lang = z.string().regex(LANG, { message: 'lang must be a language code' });
const text = (max: number) => z.string().trim().min(1, { message: 'text is required' }).max(max);
/**
 * Text by language (F-1533-d/f, ADR-0050 amendments): at least the item's
 * source language, which the service checks along with every language being
 * one locale-service has. The i18n key is the server's: a category or product
 * body carries text, never `nameKey`.
 */
const texts = (max: number) =>
  z.record(lang, text(max)).refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 50, { message: 'text in 1-50 languages' });
const NAME_MAX = 200;
/**
 * F-1533-i (user, 2026-09-25): draft every other language from the source into
 * the review list. Off when absent — then only the languages written change,
 * and a reader falls back to the source for the rest.
 */
const translateAll = z.boolean().optional();
const DESCRIPTION_MAX = 2000;

/** Quota per metric (§4.5). A metric absent from the map has no quota. */
const quotas = z.record(
  z.nativeEnum(QuotaMetric),
  z.object({ limit: z.number().int().min(0), resetPolicy: z.enum(RESET_POLICIES) }).strict(),
);

const featureKeys = z.array(z.string().regex(FEATURE_KEY, { message: 'a feature key looks like vpn.access' })).max(50);

/** The category one sits under (F-026-r); `null` = top level. Depth and cycles are the service's. */
const parentId = uuid('parentId').nullable().optional();

/** A product's categories (F-026-r): one or more, distinct, the first shown first. */
const MAX_CATEGORIES_PER_PRODUCT = 20;
const categoryIds = z
  .array(uuid('categoryIds'))
  .min(1, { message: 'a product sits in at least one category' })
  .max(MAX_CATEGORIES_PER_PRODUCT)
  .refine((ids) => new Set(ids).size === ids.length, 'categoryIds must be distinct');

export const createCategorySchema = z
  .object({ tenantId: uuid('tenantId').nullable().optional(), parentId, key: z.string().regex(KEY), sourceLang: lang.optional(), name: texts(NAME_MAX), translateAll })
  .strict();

export const updateCategorySchema = z
  .object({
    parentId,
    sourceLang: lang.optional(),
    name: texts(NAME_MAX).optional(),
    translateAll,
    isActive: z.boolean().optional(),
    /** Only `false`: back from the archive (F-026-l). Archiving is `POST /categories/remove` with its products. */
    archived: z.literal(false).optional(),
  })
  .strict();

/** `true`: the archived categories alone (F-026-l). */
export const listCategoriesSchema = z.object({ archived: z.literal('true').transform(() => true).optional() }).strict();

export const listProductsSchema = z.object({
  categoryId: uuid('categoryId').optional(),
  /** Platform owner only: a tenant id, or `platform`. */
  tenantId: z.union([z.literal('platform'), uuid('tenantId')]).optional(),
  /** `true`: the archived products alone (F-026-h). */
  archived: z.literal('true').transform(() => true).optional(),
});

export const createProductSchema = z
  .object({
    tenantId: uuid('tenantId').nullable().optional(),
    categoryIds,
    key: z.string().regex(KEY),
    sourceLang: lang.optional(),
    name: texts(NAME_MAX),
    description: texts(DESCRIPTION_MAX).nullable().optional(),
    translateAll,
    fulfilmentKind: z.enum(CREATABLE_FULFILMENT_KINDS),
    featureKeys: featureKeys.optional(),
    defaultQuotas: quotas.optional(),
  })
  .strict();

export const updateProductSchema = z
  .object({
    categoryIds: categoryIds.optional(),
    sourceLang: lang.optional(),
    name: texts(NAME_MAX).optional(),
    description: texts(DESCRIPTION_MAX).nullable().optional(),
    translateAll,
    featureKeys: featureKeys.optional(),
    defaultQuotas: quotas.optional(),
    isActive: z.boolean().optional(),
    /** Only `false`: back from the archive. Archiving is `POST /products/remove`. */
    archived: z.literal(false).optional(),
  })
  .strict();

/** F-026-h: up to 100 distinct products, each answered on its own. F-026-j: the same body for categories. */
export const removeProductsSchema = z
  .object({ ids: z.array(uuid('ids')).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, 'ids must be distinct') })
  .strict();
/** F-026-l: `withProducts` removes each of its own products first, then deletes or archives the category. */
export const removeCategoriesSchema = removeProductsSchema.extend({ withProducts: z.boolean().optional() }).strict();

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

/** Translation review (F-1533-d). Keys are full catalog text keys; the service checks each is the caller's. */
export const listTextDraftsSchema = z.object({ lang: lang.optional() });
export const publishTextsSchema = z.object({ lang, keys: z.array(z.string().max(200)).min(1).max(200) }).strict();
export const editTextsSchema = z
  .object({ lang, texts: z.record(z.string().max(200), text(DESCRIPTION_MAX)) })
  .strict()
  .refine((b) => Object.keys(b.texts).length > 0 && Object.keys(b.texts).length <= 200, { message: 'texts holds 1-200 entries', path: ['texts'] });

/**
 * The same bodies on the named reseller's surface (F-066-w7), without
 * `tenantId`: there the tenant is the path's, so a body or query naming one is
 * refused by `.strict()` rather than silently ignored — a client that sent it
 * expected it to land.
 */
export const createResellerCategorySchema = createCategorySchema.omit({ tenantId: true }).strict();
export const createResellerProductSchema = createProductSchema.omit({ tenantId: true }).strict();
export const listResellerProductsSchema = listProductsSchema.omit({ tenantId: true }).strict();

export type CreateCategoryBody = z.infer<typeof createCategorySchema>;
export type UpdateCategoryBody = z.infer<typeof updateCategorySchema>;
export type ListProductsQuery = z.infer<typeof listProductsSchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesSchema>;
export type CreateProductBody = z.infer<typeof createProductSchema>;
export type UpdateProductBody = z.infer<typeof updateProductSchema>;
export type RemoveProductsBody = z.infer<typeof removeProductsSchema>;
export type RemoveCategoriesBody = z.infer<typeof removeCategoriesSchema>;
export type CreateVariantBody = z.infer<typeof createVariantSchema>;
export type UpdateVariantBody = z.infer<typeof updateVariantSchema>;
export type SetPriceBody = z.infer<typeof setPriceSchema>;
export type ListTextDraftsQuery = z.infer<typeof listTextDraftsSchema>;
export type PublishTextsBody = z.infer<typeof publishTextsSchema>;
export type EditTextsBody = z.infer<typeof editTextsSchema>;
export type CreateResellerCategoryBody = z.infer<typeof createResellerCategorySchema>;
export type CreateResellerProductBody = z.infer<typeof createResellerProductSchema>;
export type ListResellerProductsQuery = z.infer<typeof listResellerProductsSchema>;
