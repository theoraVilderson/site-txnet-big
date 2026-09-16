import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { Me } from "@/lib/auth-api";
import type {
  BillingMode,
  CatalogPrice,
  CatalogRejection,
  CreateCategoryBody,
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
  text_key_invalid: CATALOG_KEYS.refusals.text_key_invalid,
  texts_unavailable: CATALOG_KEYS.refusals.texts_unavailable,
};

/** The refusal's own sentence key, when billing named one this page knows. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as CatalogRejection] : null;
}

export const isPlatformOwner = (me: Me | null) => me?.tenant?.type === "platform_owner";

// Billing's own shapes (`catalog-admin.schema.ts`), so a refusal is caught before the call.
const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const FEATURE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SKU = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE = /^\d{1,19}$/;

const blank = (v: string) => v.trim() === "";
const list = (text: string) => [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

export type Errors<F> = Partial<Record<keyof F, string>>;

// --------------------------------------------------------------------- names

/** billing's `NAME_MAX` / `DESCRIPTION_MAX`; the inputs cap at these. */
export const NAME_MAX = 200;
export const DESCRIPTION_MAX = 2000;

/** Full catalog text key → text, for one language. */
export type CatalogTexts = Record<string, Record<string, string>>;

/** The read fallback after the asked language (ADR-0050 decision 5), as the locale clients have it. */
const FALLBACK_LANGS = ["en", "fa"] as const;

/** The languages a list fetches the `catalog` namespace in: the viewer's, then the fallback. */
export const textLangs = (lang: string) => [...new Set([lang, ...FALLBACK_LANGS])];

/** `/api/i18n/<lang>/catalog` answers nested JSON; this is its full keys again (`catalog.product.vpn.name`). */
export function flattenTexts(nested: unknown, prefix = "catalog"): Record<string, string> {
  const out: Record<string, string> = {};
  if (nested && typeof nested === "object") {
    for (const [k, v] of Object.entries(nested)) {
      if (typeof v === "string") out[`${prefix}.${k}`] = v;
      else Object.assign(out, flattenTexts(v, `${prefix}.${k}`));
    }
  }
  return out;
}

/** An item's text: the asked language, then en, then fa; `null` when none has it (the list then shows the key). */
export function catalogText(texts: CatalogTexts, lang: string, key: string | null): string | null {
  if (!key) return null;
  for (const l of textLangs(lang)) {
    const v = texts[l]?.[key];
    if (v !== undefined && v !== "") return v;
  }
  return null;
}

/** Names as an admin types them: both languages required; a product's description in both or neither. */
export interface NamesForm {
  fa: string;
  en: string;
  descriptionFa: string;
  descriptionEn: string;
}

export function validateNamesForm(f: NamesForm, kind: "product" | "category"): Errors<NamesForm> {
  const errors: Errors<NamesForm> = {};
  if (blank(f.fa)) errors.fa = E.required;
  if (blank(f.en)) errors.en = E.required;
  if (kind === "product" && blank(f.descriptionFa) !== blank(f.descriptionEn)) {
    errors[blank(f.descriptionFa) ? "descriptionFa" : "descriptionEn"] = E.bothLanguages;
  }
  return errors;
}

/** A rename in billing's shape. A product's description blank in both is removed. */
export function namesBody(f: NamesForm, kind: "product" | "category") {
  const name = { fa: f.fa.trim(), en: f.en.trim() };
  if (kind === "category") return { name };
  return { name, description: blank(f.descriptionFa) ? null : { fa: f.descriptionFa.trim(), en: f.descriptionEn.trim() } };
}

/** Languages a reviewer picks from: every language locale-service has but the two an admin writes. */
export const reviewLanguages = (available: readonly string[]) => available.filter((l) => !(FALLBACK_LANGS as readonly string[]).includes(l));

/** A review edit's id: one draft is one (language, key). A key never holds `|`. */
export const editId = (d: { lang: string; key: string }) => `${d.lang}|${d.key}`;

/**
 * The writes one "publish" makes, per language: a draft left as it is goes out
 * as a publish (billing moves it); one a reviewer changed goes out as their
 * text. A blank edit is never sent.
 */
export function reviewWrites(
  items: readonly { lang: string; key: string; draft: string }[],
  edits: Record<string, string>,
): { lang: string; keys: string[]; texts?: Record<string, string> }[] {
  const byLang = new Map<string, { keys: string[]; texts: Record<string, string> }>();
  for (const d of items) {
    const edit = edits[editId(d)];
    const group = byLang.get(d.lang) ?? { keys: [], texts: {} };
    byLang.set(d.lang, group);
    if (edit === undefined || edit === d.draft) group.keys.push(d.key);
    else if (edit.trim() !== "") group.texts[d.key] = edit.trim();
  }
  const out: { lang: string; keys: string[]; texts?: Record<string, string> }[] = [];
  for (const [lang, g] of byLang) {
    if (g.keys.length) out.push({ lang, keys: g.keys });
    if (Object.keys(g.texts).length) out.push({ lang, keys: Object.keys(g.texts), texts: g.texts });
  }
  return out;
}

// ------------------------------------------------------------------ category

export interface CategoryForm {
  key: string;
  nameFa: string;
  nameEn: string;
  /** The platform owner only: a category every tenant files products in. */
  shared: boolean;
}

export const emptyCategoryForm = (): CategoryForm => ({ key: "", nameFa: "", nameEn: "", shared: false });

export function validateCategoryForm(f: CategoryForm): Errors<CategoryForm> {
  const errors: Errors<CategoryForm> = {};
  if (!KEY.test(f.key.trim())) errors.key = E.key;
  if (blank(f.nameFa)) errors.nameFa = E.required;
  if (blank(f.nameEn)) errors.nameEn = E.required;
  return errors;
}

export function categoryBody(f: CategoryForm, owner: boolean): CreateCategoryBody {
  return { key: f.key.trim(), name: { fa: f.nameFa.trim(), en: f.nameEn.trim() }, ...(owner && f.shared ? { tenantId: null } : {}) };
}

// ------------------------------------------------------------------- product

export type CatalogOwnerChoice = "own" | "platform" | "tenant";

/** The form as typed: every box a string. */
export interface ProductForm {
  /** The platform owner only: whose product it is. */
  owner: CatalogOwnerChoice;
  tenantId: string;
  categoryId: string;
  key: string;
  nameFa: string;
  nameEn: string;
  /** Both or neither. */
  descriptionFa: string;
  descriptionEn: string;
  fulfilmentKind: FulfilmentKind;
  /** One feature key per line or comma. */
  featureKeys: string;
}

export const emptyProductForm = (): ProductForm => ({
  owner: "own",
  tenantId: "",
  categoryId: "",
  key: "",
  nameFa: "",
  nameEn: "",
  descriptionFa: "",
  descriptionEn: "",
  fulfilmentKind: "network_access",
  featureKeys: "",
});

export function validateProductForm(f: ProductForm, me: Me | null): Errors<ProductForm> {
  const errors: Errors<ProductForm> = {};
  if (isPlatformOwner(me) && f.owner === "tenant" && !UUID.test(f.tenantId.trim())) errors.tenantId = E.uuid;
  if (blank(f.categoryId)) errors.categoryId = E.required;
  if (!KEY.test(f.key.trim())) errors.key = E.key;
  if (blank(f.nameFa)) errors.nameFa = E.required;
  if (blank(f.nameEn)) errors.nameEn = E.required;
  if (blank(f.descriptionFa) !== blank(f.descriptionEn)) errors[blank(f.descriptionFa) ? "descriptionFa" : "descriptionEn"] = E.bothLanguages;
  if (list(f.featureKeys).some((k) => !FEATURE_KEY.test(k))) errors.featureKeys = E.featureKey;
  return errors;
}

/** A new product, in billing's wire shape. `tenantId` only for the platform owner's choice. */
export function productBody(f: ProductForm, me: Me | null): CreateProductBody {
  const body: CreateProductBody = {
    categoryId: f.categoryId.trim(),
    key: f.key.trim(),
    name: { fa: f.nameFa.trim(), en: f.nameEn.trim() },
    fulfilmentKind: f.fulfilmentKind,
    featureKeys: list(f.featureKeys),
  };
  if (!blank(f.descriptionFa)) body.description = { fa: f.descriptionFa.trim(), en: f.descriptionEn.trim() };
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
