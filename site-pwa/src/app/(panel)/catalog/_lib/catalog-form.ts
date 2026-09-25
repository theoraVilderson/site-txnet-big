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
  ProductRemoval,
  CategoryRemoval,
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
  panel_group_not_found: CATALOG_KEYS.refusals.panel_group_not_found,
  text_key_invalid: CATALOG_KEYS.refusals.text_key_invalid,
  texts_unavailable: CATALOG_KEYS.refusals.texts_unavailable,
  lang_unknown: CATALOG_KEYS.refusals.lang_unknown,
  source_text_missing: CATALOG_KEYS.refusals.source_text_missing,
};

/** The refusal's own sentence key, when billing named one this page knows. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as CatalogRejection] : null;
}

export const isPlatformOwner = (me: Me | null) => me?.tenant?.type === "platform_owner";

/**
 * Who the forms may treat as the caller on this surface (F-066-w8). On a
 * reseller's screen nobody is an owner: billing runs the work **as** the
 * reseller and its `.strict()` schema refuses a `tenantId`, so platform staff
 * signed in to the platform owner's tenant must not be offered — or send — a
 * platform item's powers there.
 */
export const surfaceActor = (me: Me | null, tenantId: string | null): Me | null => (tenantId === null ? me : null);

// Billing's own shapes (`catalog-admin.schema.ts`), so a refusal is caught before the call.
const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const FEATURE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SKU = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE = /^\d{1,19}$/;

const blank = (v: string) => v.trim() === "";
const unique = (items: readonly string[]) => [...new Set(items.map((x) => x.trim()).filter(Boolean))];

export const isFeatureKey = (k: string) => FEATURE_KEY.test(k);

// --------------------------------------------------------------- suggestions

/**
 * Every capability the caller's products already grant — the picker's list, so
 * nobody types `vpn.premium_nodes` from memory. No registry exists: a product's
 * `featureKeys` is the only place these live (ADR-0049).
 */
export const featureKeysIn = (products: readonly { featureKeys: readonly string[] }[]) =>
  unique(products.flatMap((p) => p.featureKeys)).sort();

/** Persian letters in Latin, so a name written in Persian still gives a readable key. */
const LATIN: Record<string, string> = {
  ا: "a", آ: "a", أ: "a", إ: "e", ب: "b", پ: "p", ت: "t", ث: "s", ج: "j", چ: "ch", ح: "h", خ: "kh", د: "d", ذ: "z",
  ر: "r", ز: "z", ژ: "zh", س: "s", ش: "sh", ص: "s", ض: "z", ط: "t", ظ: "z", ع: "a", غ: "gh", ف: "f", ق: "gh",
  ک: "k", ك: "k", گ: "g", ل: "l", م: "m", ن: "n", و: "v", ه: "h", ة: "h", ی: "i", ي: "i", ئ: "i", ء: "", ؤ: "o",
};
const DIGITS = "۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩";

/** A key in billing's shape (`^[a-z][a-z0-9_]{1,63}$`) from a name, or `""` when the name gives too little. */
export function slugKey(text: string): string {
  const latin = [...text.normalize("NFKD").toLowerCase()]
    .map((c) => {
      const d = DIGITS.indexOf(c);
      if (d >= 0) return String(d % 10);
      return LATIN[c] ?? c;
    })
    .join("");
  let key = latin.replace(/[^a-z0-9]+/g, "_").replace(/^[_0-9]+|_+$/g, "");
  if (!key) {
    const digits = latin.replace(/[^0-9]+/g, "_").replace(/^_+|_+$/g, "");
    key = digits ? `n_${digits}` : "";
  }
  key = key.slice(0, 64).replace(/_+$/, "");
  return KEY.test(key) ? key : "";
}

/** The name's key, numbered past every key already taken; `<fallback>_<time>` when the name gives none. */
export function suggestKey(name: string, taken: Iterable<string>, fallback: string): string {
  const used = new Set(taken);
  const root = slugKey(name) || `${fallback}_${Date.now().toString(36)}`;
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const tail = `_${n}`;
    const candidate = `${root.slice(0, 64 - tail.length)}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** `VPN_PRO-30D` / `VPN_PRO-PERM` — a SKU billing accepts, from the product key and the duration. */
export function suggestSku(productKey: string, durationDays: string): string {
  const days = durationDays.trim();
  const tail = /^\d+$/.test(days) ? `-${days}D` : "-PERM";
  const head = productKey.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40 - tail.length) || "ITEM";
  return `${head}${tail}`;
}

export type Errors<F> = Partial<Record<keyof F, string>>;

// --------------------------------------------------------------------- names

/** billing's `NAME_MAX` / `DESCRIPTION_MAX`; the inputs cap at these. */
export const NAME_MAX = 200;
export const DESCRIPTION_MAX = 2000;

/** Language → full catalog text key → text. */
export type CatalogTexts = Record<string, Record<string, string>>;

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

/**
 * An item's text: the asked language, then the item's source language
 * (ADR-0050 amendment 2); `null` when neither has it (the list then shows the key).
 */
export function catalogText(texts: CatalogTexts, lang: string, key: string | null, sourceLang: string): string | null {
  if (!key) return null;
  for (const l of [lang, sourceLang]) {
    const v = texts[l]?.[key];
    if (v !== undefined && v !== "") return v;
  }
  return null;
}

/** A rename as an admin types it: one name (and a product's description) in the source language picked. */
export interface NamesForm {
  sourceLang: string;
  name: string;
  description: string;
}

export function validateNamesForm(f: NamesForm): Errors<NamesForm> {
  const errors: Errors<NamesForm> = {};
  if (blank(f.sourceLang)) errors.sourceLang = E.required;
  if (blank(f.name)) errors.name = E.required;
  return errors;
}

/** A rename in billing's shape. Every other language is billing's to draft; a product's blank description is removed. */
export function namesBody(f: NamesForm, kind: "product" | "category") {
  const sourceLang = f.sourceLang.trim();
  const name = { [sourceLang]: f.name.trim() };
  if (kind === "category") return { sourceLang, name };
  return { sourceLang, name, description: blank(f.description) ? null : { [sourceLang]: f.description.trim() } };
}

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
  /** The language the name is written in; drafts come from it, readers fall back to it. */
  sourceLang: string;
  name: string;
  /** The platform owner only: a category every tenant files products in. */
  shared: boolean;
}

/** `defaultLang` is the deployment's `DEFAULT_LOCALE`: billing's default source language too. */
export const emptyCategoryForm = (defaultLang: string): CategoryForm => ({ key: "", sourceLang: defaultLang, name: "", shared: false });

export function validateCategoryForm(f: CategoryForm): Errors<CategoryForm> {
  const errors: Errors<CategoryForm> = {};
  if (!KEY.test(f.key.trim())) errors.key = E.key;
  if (blank(f.sourceLang)) errors.sourceLang = E.required;
  if (blank(f.name)) errors.name = E.required;
  return errors;
}

export function categoryBody(f: CategoryForm, owner: boolean): CreateCategoryBody {
  const sourceLang = f.sourceLang.trim();
  return { key: f.key.trim(), sourceLang, name: { [sourceLang]: f.name.trim() }, ...(owner && f.shared ? { tenantId: null } : {}) };
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
  sourceLang: string;
  name: string;
  /** Blank = none. */
  description: string;
  fulfilmentKind: FulfilmentKind;
  /** What a Grant of this product unlocks, picked from the ones in use or added. */
  featureKeys: string[];
}

export const emptyProductForm = (defaultLang: string): ProductForm => ({
  owner: "own",
  tenantId: "",
  categoryId: "",
  key: "",
  sourceLang: defaultLang,
  name: "",
  description: "",
  fulfilmentKind: "network_access",
  featureKeys: [],
});

export function validateProductForm(f: ProductForm, me: Me | null): Errors<ProductForm> {
  const errors: Errors<ProductForm> = {};
  if (isPlatformOwner(me) && f.owner === "tenant" && !UUID.test(f.tenantId.trim())) errors.tenantId = E.uuid;
  if (blank(f.categoryId)) errors.categoryId = E.required;
  if (!KEY.test(f.key.trim())) errors.key = E.key;
  if (blank(f.sourceLang)) errors.sourceLang = E.required;
  if (blank(f.name)) errors.name = E.required;
  if (unique(f.featureKeys).some((k) => !FEATURE_KEY.test(k))) errors.featureKeys = E.featureKey;
  return errors;
}

/** A new product, in billing's wire shape. `tenantId` only for the platform owner's choice. */
export function productBody(f: ProductForm, me: Me | null): CreateProductBody {
  const body: CreateProductBody = {
    categoryId: f.categoryId.trim(),
    key: f.key.trim(),
    sourceLang: f.sourceLang.trim(),
    name: { [f.sourceLang.trim()]: f.name.trim() },
    fulfilmentKind: f.fulfilmentKind,
    featureKeys: unique(f.featureKeys),
  };
  if (!blank(f.description)) body.description = { [f.sourceLang.trim()]: f.description.trim() };
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

const GIB = 1024 ** 3;

/** What the admin types for a quota: traffic in whole GB, the rest as is. The form keeps billing's unit. */
export function quotaFromInput(metric: QuotaMetric, typed: string): string {
  const v = typed.trim();
  return metric === "traffic_bytes" && /^\d{1,9}$/.test(v) ? String(Number(v) * GIB) : v;
}

export function quotaToInput(metric: QuotaMetric, limit: string): string {
  if (metric !== "traffic_bytes" || !/^\d+$/.test(limit)) return limit;
  const gb = Number(limit) / GIB;
  return Number.isInteger(gb) ? String(gb) : limit;
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

// -------------------------------------------------------------------- wizard

/** A new product, one question at a time: where it goes, what it is called, what it unlocks, how it sells. */
export const WIZARD_STEPS = ["category", "names", "access", "variant", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface ProductWizard {
  categoryMode: "existing" | "new";
  categoryId: string;
  newCategory: CategoryForm;
  product: ProductForm;
  /** A product with no variant cannot be sold; skipping is allowed, and the list says so. */
  withVariant: boolean;
  variant: VariantForm;
}

export const emptyWizard = (defaultLang: string): ProductWizard => ({
  categoryMode: "existing",
  categoryId: "",
  newCategory: emptyCategoryForm(defaultLang),
  product: emptyProductForm(defaultLang),
  withVariant: true,
  variant: emptyVariantForm(),
});

const pick = <T extends object>(errors: T, keys: readonly (keyof T)[]) =>
  Object.fromEntries(Object.entries(errors).filter(([k]) => keys.includes(k as keyof T))) as Partial<T>;

/** One step's errors, keyed by the field of the form that step edits. */
export function wizardStepErrors(step: WizardStep, w: ProductWizard, me: Me | null): Record<string, string> {
  switch (step) {
    case "category":
      if (w.categoryMode === "new") return validateCategoryForm(w.newCategory) as Record<string, string>;
      return blank(w.categoryId) ? { categoryId: E.required } : {};
    case "names":
      return pick(validateProductForm(w.product, me), ["key", "sourceLang", "name"]) as Record<string, string>;
    case "access":
      return pick(validateProductForm(w.product, me), ["tenantId", "featureKeys"]) as Record<string, string>;
    case "variant":
      return w.withVariant ? (validateVariantForm(w.variant) as Record<string, string>) : {};
    case "review":
      return {};
  }
}

export function firstInvalidStep(w: ProductWizard, me: Me | null): WizardStep | null {
  return WIZARD_STEPS.find((s) => Object.keys(wizardStepErrors(s, w, me)).length > 0) ?? null;
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

// ------------------------------------------------------------------ removal

const REMOVAL_ORDER: readonly ProductRemoval["outcome"][] = ["deleted", "archived", "not_found"];
const REMOVAL_KEYS: Record<ProductRemoval["outcome"], string> = {
  deleted: CATALOG_KEYS.removal.deleted,
  archived: CATALOG_KEYS.removal.archived,
  not_found: CATALOG_KEYS.removal.notFound,
};

/**
 * What a group removal did, one line per outcome that happened (F-026-i):
 * billing answers each product on its own, so a batch can be part deleted,
 * part archived because it was sold, and part not the caller's.
 */
export function removalReport(outcomes: readonly ProductRemoval[]): { key: string; count: number }[] {
  return REMOVAL_ORDER.map((o) => ({ key: REMOVAL_KEYS[o], count: outcomes.filter((r) => r.outcome === o).length })).filter((l) => l.count > 0);
}

/** The selection, less every product the list no longer has — a removed one, or one another tab removed. */
export const stillSelected = (selected: ReadonlySet<string>, listed: readonly { id: string }[]) =>
  new Set(listed.map((p) => p.id).filter((id) => selected.has(id)));

// ------------------------------------------------------------ category group

const CATEGORY_REMOVAL_ORDER: readonly CategoryRemoval["outcome"][] = ["deleted", "archived", "has_products", "not_found"];
const CATEGORY_REMOVAL_KEYS: Record<CategoryRemoval["outcome"], string> = {
  deleted: CATALOG_KEYS.categories.deleted,
  archived: CATALOG_KEYS.categories.archived,
  has_products: CATALOG_KEYS.categories.hasProducts,
  not_found: CATALOG_KEYS.categories.notFound,
};

/**
 * What a group removal of categories did, one line per outcome that happened
 * (F-026-k over F-026-j), then what happened to the products removed with them
 * (F-026-m over F-026-l) — in the products' own sentences.
 */
export function categoryRemovalReport(outcomes: readonly CategoryRemoval[]): { key: string; count: number }[] {
  const products = (o: "deleted" | "archived") => outcomes.reduce((n, r) => n + (r.products?.[o] ?? 0), 0);
  return [
    ...CATEGORY_REMOVAL_ORDER.map((o) => ({ key: CATEGORY_REMOVAL_KEYS[o], count: outcomes.filter((r) => r.outcome === o).length })),
    { key: CATALOG_KEYS.removal.deleted, count: products("deleted") },
    { key: CATALOG_KEYS.removal.archived, count: products("archived") },
  ].filter((l) => l.count > 0);
}

/** The categories billing kept for the products in them: the ones the page asks about a second time (F-026-m). */
export const heldByProducts = (outcomes: readonly CategoryRemoval[]) => outcomes.filter((r) => r.outcome === "has_products").map((r) => r.id);

/** The first answer with each category the second removal (with its products) answered replaced by that answer. */
export function mergeRemovals(first: readonly CategoryRemoval[], second: readonly CategoryRemoval[]): CategoryRemoval[] {
  const again = new Map(second.map((r) => [r.id, r]));
  return first.map((r) => again.get(r.id) ?? r);
}

/**
 * Products per category, the archived counted too: billing keeps a category
 * any product sits in, archived ones included, so a count that left them out
 * would show 0 beside a category the removal then refuses.
 */
export function productCounts(...lists: readonly (readonly { categoryId: string }[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of lists.flat()) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
  return counts;
}

/** The selected categories a group switch actually changes: those not already on (or off). */
export const switchTargets = (selected: ReadonlySet<string>, categories: readonly { id: string; isActive: boolean }[], on: boolean) =>
  categories.filter((c) => selected.has(c.id) && c.isActive !== on).map((c) => c.id);

/** A group switch is one PATCH per category, each on its own: how many changed, how many did not. */
export function switchReport(results: readonly PromiseSettledResult<unknown>[]): { key: string; count: number }[] {
  const ok = results.filter((r) => r.status === "fulfilled").length;
  return [
    { key: CATALOG_KEYS.categories.switched, count: ok },
    { key: CATALOG_KEYS.categories.switchFailed, count: results.length - ok },
  ].filter((l) => l.count > 0);
}
