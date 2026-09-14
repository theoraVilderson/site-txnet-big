import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { Me } from "@/lib/auth-api";
import type {
  BillingMode,
  CatalogPrice,
  CatalogRejection,
  CreateProductBody,
  CreateVariantBody,
  FulfilmentKind,
  QualityTier,
  QuotaMetric,
  Quotas,
  ResetPolicy,
  SetPriceBody,
  Visibility,
} from "@/lib/catalog-api";

export { BILLING_MODES, FULFILMENT_KINDS, QUALITY_TIERS, QUOTA_METRICS, RESET_POLICIES, VISIBILITIES } from "@/lib/catalog-api";

/** Every string the catalog page can show (C-06). */
export const CATALOG_KEYS = FrontendI18nKeys.common.catalog;
const E = CATALOG_KEYS.errors;

/** billing's `CATALOG_MANAGE` — the menu entry needs it (F-026-d). */
export const CATALOG_MANAGE = "catalog.manage";

/**
 * One sentence per reason `CatalogAdminService` can refuse with. A `Record`
 * over the union, so a reason added there does not compile here;
 * `catalog.test.ts` reads the service's own union for when both sides forgot.
 */
export const REFUSAL_KEYS: Record<CatalogRejection, string> = {
  not_platform_owner: CATALOG_KEYS.refusals.not_platform_owner,
  tenant_not_found: CATALOG_KEYS.refusals.tenant_not_found,
  category_not_found: CATALOG_KEYS.refusals.category_not_found,
  product_not_found: CATALOG_KEYS.refusals.product_not_found,
  variant_not_found: CATALOG_KEYS.refusals.variant_not_found,
  price_not_found: CATALOG_KEYS.refusals.price_not_found,
  key_taken: CATALOG_KEYS.refusals.key_taken,
  sku_taken: CATALOG_KEYS.refusals.sku_taken,
  price_in_the_past: CATALOG_KEYS.refusals.price_in_the_past,
};

/** The refusal's own sentence key, when billing named one this page knows. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as CatalogRejection] : null;
}

export const isPlatformOwner = (me: Me | null) => me?.tenant?.type === "platform_owner";

// Billing's own shapes (`catalog-admin.schema.ts`), so a refusal is caught before the call.
const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const I18N_KEY = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const FEATURE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SKU = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE = /^\d{1,19}$/;

const blank = (v: string) => v.trim() === "";
const list = (text: string) => [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

export type Errors<F> = Partial<Record<keyof F, string>>;

// ------------------------------------------------------------------- product

export type CatalogOwnerChoice = "own" | "platform" | "tenant";

/** The form as typed: every box a string. */
export interface ProductForm {
  /** The platform owner only: whose product it is. */
  owner: CatalogOwnerChoice;
  tenantId: string;
  categoryId: string;
  key: string;
  nameKey: string;
  descriptionKey: string;
  fulfilmentKind: FulfilmentKind;
  /** One feature key per line or comma. */
  featureKeys: string;
}

export const emptyProductForm = (): ProductForm => ({
  owner: "own",
  tenantId: "",
  categoryId: "",
  key: "",
  nameKey: "",
  descriptionKey: "",
  fulfilmentKind: "network_access",
  featureKeys: "",
});

export function validateProductForm(f: ProductForm, me: Me | null): Errors<ProductForm> {
  const errors: Errors<ProductForm> = {};
  if (isPlatformOwner(me) && f.owner === "tenant" && !UUID.test(f.tenantId.trim())) errors.tenantId = E.uuid;
  if (blank(f.categoryId)) errors.categoryId = E.required;
  if (!KEY.test(f.key.trim())) errors.key = E.key;
  if (!I18N_KEY.test(f.nameKey.trim())) errors.nameKey = E.i18nKey;
  if (!blank(f.descriptionKey) && !I18N_KEY.test(f.descriptionKey.trim())) errors.descriptionKey = E.i18nKey;
  if (list(f.featureKeys).some((k) => !FEATURE_KEY.test(k))) errors.featureKeys = E.featureKey;
  return errors;
}

/** A new product, in billing's wire shape. `tenantId` only for the platform owner's choice. */
export function productBody(f: ProductForm, me: Me | null): CreateProductBody {
  const body: CreateProductBody = {
    categoryId: f.categoryId.trim(),
    key: f.key.trim(),
    nameKey: f.nameKey.trim(),
    fulfilmentKind: f.fulfilmentKind,
    featureKeys: list(f.featureKeys),
  };
  if (!blank(f.descriptionKey)) body.descriptionKey = f.descriptionKey.trim();
  if (isPlatformOwner(me) && f.owner === "platform") body.tenantId = null;
  if (isPlatformOwner(me) && f.owner === "tenant") body.tenantId = f.tenantId.trim();
  return body;
}

// ------------------------------------------------------------------- variant

export interface QuotaRow {
  metric: QuotaMetric;
  limit: string;
  resetPolicy: ResetPolicy;
}

export interface VariantForm {
  sku: string;
  billingMode: BillingMode;
  visibility: Visibility;
  qualityTier: QualityTier;
  /** Blank = permanent. */
  durationDays: string;
  /** The first price, base currency. */
  price: string;
  quotas: QuotaRow[];
}

export const emptyVariantForm = (): VariantForm => ({
  sku: "",
  billingMode: "prepaid",
  visibility: "public",
  qualityTier: "standard",
  durationDays: "",
  price: "",
  quotas: [],
});

export function validateVariantForm(f: VariantForm): Errors<VariantForm> {
  const errors: Errors<VariantForm> = {};
  if (!SKU.test(f.sku.trim().toUpperCase())) errors.sku = E.sku;
  if (!DECIMAL.test(f.price.trim())) errors.price = E.decimal;
  if (!blank(f.durationDays)) {
    const days = Number(f.durationDays.trim());
    if (!/^\d+$/.test(f.durationDays.trim()) || days < 1 || days > 3650) errors.durationDays = E.duration;
  }
  if (f.quotas.some((q) => !WHOLE.test(q.limit.trim()))) errors.quotas = E.quota;
  else if (new Set(f.quotas.map((q) => q.metric)).size !== f.quotas.length) errors.quotas = E.quotaRepeat;
  return errors;
}

const quotasOf = (rows: QuotaRow[]): Quotas =>
  Object.fromEntries(rows.map((q) => [q.metric, { limit: Number(q.limit.trim()), resetPolicy: q.resetPolicy }]));

/** A new variant with its first price, in billing's wire shape. */
export function variantBody(f: VariantForm): CreateVariantBody {
  return {
    sku: f.sku.trim().toUpperCase(),
    billingMode: f.billingMode,
    visibility: f.visibility,
    qualityTier: f.qualityTier,
    durationDays: blank(f.durationDays) ? null : Number(f.durationDays.trim()),
    price: f.price.trim(),
    ...(f.quotas.length ? { quotas: quotasOf(f.quotas) } : {}),
  };
}

// --------------------------------------------------------------------- price

export interface PriceForm {
  amount: string;
  /** `YYYY-MM-DD`, Tehran's day; blank = from now. */
  day: string;
}

/** Tehran has kept +03:30 all year since 2022 — the clock billing's weekday gates read too. */
const TEHRAN_OFFSET = "+03:30";

/** Today in Tehran, `YYYY-MM-DD`. */
export const tehranToday = (now: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** A day already past would reprice an invoice issued under the old price: billing refuses it, so this does first. */
export function validatePriceForm(f: PriceForm, today: string): Errors<PriceForm> {
  const errors: Errors<PriceForm> = {};
  if (!DECIMAL.test(f.amount.trim())) errors.amount = E.decimal;
  if (!blank(f.day) && f.day < today) errors.day = E.pastDay;
  return errors;
}

/**
 * Today means "from now", not today's first instant — that instant has already
 * passed. A later day starts at its first instant in Tehran.
 */
export function priceBody(f: PriceForm, today: string): SetPriceBody {
  const amount = f.amount.trim();
  return blank(f.day) || f.day <= today ? { amount } : { amount, effectiveFrom: `${f.day}T00:00:00${TEHRAN_OFFSET}` };
}

/** Billing's `priceAt`: the newest active price already in effect at `now`, or none. */
export function currentPrice(prices: readonly CatalogPrice[], now: Date = new Date()): CatalogPrice | null {
  let best: CatalogPrice | null = null;
  for (const p of prices) {
    const at = new Date(p.effectiveFrom).getTime();
    if (!p.isActive || at > now.getTime()) continue;
    if (!best || at > new Date(best.effectiveFrom).getTime()) best = p;
  }
  return best;
}
