import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { Me } from "@/lib/auth-api";
import { PLATFORM_DEFAULT_TIMEZONE } from "@/lib/time-zone";
import type {
  BillingMode,
  CatalogPrice,
  CatalogRateCard,
  CatalogRejection,
  CreateCapabilityBody,
  CreateCategoryBody,
  CreateProductBody,
  CreateVariantBody,
  FulfilmentKind,
  ProductRemoval,
  CategoryRemoval,
  PanelGroupOption,
  QualityTier,
  QuotaMetric,
  Quotas,
  RateCardMode,
  RateCardTerms,
  ResetPolicy,
  SetPriceBody,
  SetRateCardBody,
  UpdateVariantBody,
  Visibility,
} from "@/lib/catalog-api";

export { BILLING_MODES, CREATABLE_FULFILMENT_KINDS, FULFILMENT_KINDS, QUALITY_TIERS, RATE_CARD_MODES, RETIRED_FULFILMENT_KINDS, QUOTA_METRICS, RESET_POLICIES, VISIBILITIES } from "@/lib/catalog-api";

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
  category_cycle: CATALOG_KEYS.refusals.category_cycle,
  category_too_deep: CATALOG_KEYS.refusals.category_too_deep,
  capability_not_found: CATALOG_KEYS.refusals.capability_not_found,
  capability_unknown: CATALOG_KEYS.refusals.capability_unknown,
  capability_in_use: CATALOG_KEYS.refusals.capability_in_use,
  traffic_quota_required: CATALOG_KEYS.refusals.traffic_quota_required,
  meter_not_found: CATALOG_KEYS.refusals.meter_not_found,
  rate_card_not_found: CATALOG_KEYS.refusals.rate_card_not_found,
  rate_card_not_served: CATALOG_KEYS.refusals.rate_card_not_served,
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

/**
 * A meter's name (F-118-s, D-59 (a)): billing's `meterNameKey`, its text
 * committed in `locales/shareds/<lang>/catalog.json` with the code that adds
 * the meter, so every language the panel has carries it. The key only when
 * the texts did not load.
 */
export const meterNameKey = (key: string) => `catalog.meter.${key}.name`;
export const meterName = (texts: Record<string, string>, key: string): string => texts[meterNameKey(key)] || key;

/** A rename as an admin types it: one name (and a product's description) in the source language picked. */
export interface NamesForm {
  sourceLang: string;
  name: string;
  description: string;
  /** Draft every other language for review (F-1533-i). Off by default: only this language changes. */
  translateAll: boolean;
}

/** `translateAll` on the wire only when ticked — billing reads absent as off. */
const translateAllOf = (f: { translateAll: boolean }) => (f.translateAll ? { translateAll: true } : {});

export function validateNamesForm(f: NamesForm): Errors<NamesForm> {
  const errors: Errors<NamesForm> = {};
  if (blank(f.sourceLang)) errors.sourceLang = E.required;
  if (blank(f.name)) errors.name = E.required;
  return errors;
}

/** A rename in billing's shape. Other languages are drafted only when ticked; a product's blank description is removed. */
export function namesBody(f: NamesForm, kind: "product" | "category") {
  const sourceLang = f.sourceLang.trim();
  const name = { [sourceLang]: f.name.trim() };
  if (kind === "category") return { sourceLang, name, ...translateAllOf(f) };
  return { sourceLang, name, description: blank(f.description) ? null : { [sourceLang]: f.description.trim() }, ...translateAllOf(f) };
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
  /** The category it sits under; blank = top level (F-026-r). */
  parentId: string;
  /** Draft every other language for review (F-1533-i). */
  translateAll: boolean;
}

/** `defaultLang` is the deployment's `DEFAULT_LOCALE`: billing's default source language too. */
export const emptyCategoryForm = (defaultLang: string): CategoryForm => ({
  key: "",
  sourceLang: defaultLang,
  name: "",
  shared: false,
  parentId: "",
  translateAll: false,
});

export function validateCategoryForm(f: CategoryForm): Errors<CategoryForm> {
  const errors: Errors<CategoryForm> = {};
  if (!KEY.test(f.key.trim())) errors.key = E.key;
  if (blank(f.sourceLang)) errors.sourceLang = E.required;
  if (blank(f.name)) errors.name = E.required;
  return errors;
}

export function categoryBody(f: CategoryForm, owner: boolean): CreateCategoryBody {
  const sourceLang = f.sourceLang.trim();
  return {
    key: f.key.trim(),
    sourceLang,
    name: { [sourceLang]: f.name.trim() },
    ...(owner && f.shared ? { tenantId: null } : {}),
    ...(blank(f.parentId) ? {} : { parentId: f.parentId.trim() }),
    ...translateAllOf(f),
  };
}

// ------------------------------------------------------------ capability

/**
 * A capability (F-114-f-b, ADR-0086): named like a category, its key made
 * from the name. Billing's key is dotted (`vpn.access`), so a derived one sits
 * under `feature.`; a key is opaque to code, so the prefix means nothing more.
 */
export interface CapabilityForm {
  key: string;
  sourceLang: string;
  name: string;
  /** The platform owner only, on the capabilities tab: a capability every tenant sees. */
  shared: boolean;
  translateAll: boolean;
}

export const emptyCapabilityForm = (defaultLang: string): CapabilityForm => ({ key: "", sourceLang: defaultLang, name: "", shared: false, translateAll: false });

const CAPABILITY_PREFIX = "feature.";

/** `feature.<the name's key>`, numbered past every key already on the list. */
export const suggestCapabilityKey = (name: string, taken: Iterable<string>) => {
  const inPrefix = [...taken].filter((k) => k.startsWith(CAPABILITY_PREFIX)).map((k) => k.slice(CAPABILITY_PREFIX.length));
  return `${CAPABILITY_PREFIX}${suggestKey(name, inPrefix, "capability")}`;
};

export function validateCapabilityForm(f: CapabilityForm): Errors<CapabilityForm> {
  const errors: Errors<CapabilityForm> = {};
  if (!FEATURE_KEY.test(f.key.trim())) errors.key = E.featureKey;
  if (blank(f.sourceLang)) errors.sourceLang = E.required;
  if (blank(f.name)) errors.name = E.required;
  return errors;
}

/** `tenant`: whose it is — `null` the platform's, an id that tenant's, `undefined` the caller's (billing decides). */
export function capabilityBody(f: CapabilityForm, tenant: string | null | undefined): CreateCapabilityBody {
  const sourceLang = f.sourceLang.trim();
  return {
    ...(tenant === undefined ? {} : { tenantId: tenant }),
    key: f.key.trim(),
    sourceLang,
    name: { [sourceLang]: f.name.trim() },
    ...translateAllOf(f),
  };
}

/**
 * What a product may carry: the platform's capabilities and its own tenant's —
 * billing's `knownCapabilities`, judged by the product's tenant. `undefined` =
 * billing already narrowed the list (not the platform owner).
 */
export const capabilitiesFor = <T extends { tenantId: string | null }>(caps: readonly T[], tenant: string | null | undefined): T[] =>
  caps.filter((c) => tenant === undefined || c.tenantId === null || c.tenantId === tenant);

/** The platform owner edits every capability; a tenant its own, never the platform's (ADR-0086 §3). */
export const canEditCapability = (c: { tenantId: string | null }, owner: boolean) => owner || c.tenantId !== null;

// ------------------------------------------------------------------- tree

/** billing's cap (`CATEGORY_MAX_DEPTH`, shared-core `category-tree.ts`): a top-level category is level 1. */
export const CATEGORY_MAX_DEPTH = 3;

type TreeItem = { id: string; parentId: string | null; key: string };

/**
 * Every category once, each right after its parent, siblings by key, with its
 * depth (0 = top). One whose parent the list does not hold — another tenant's
 * category above a platform one never reaches a tenant — is shown at the top.
 */
export function categoryTree<T extends TreeItem>(categories: readonly T[]): { category: T; depth: number }[] {
  const listed = new Set(categories.map((c) => c.id));
  const children = new Map<string | null, T[]>();
  for (const c of categories) {
    const parent = c.parentId && listed.has(c.parentId) ? c.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), c]);
  }
  const out: { category: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const c of [...(children.get(parent) ?? [])].sort((a, b) => a.key.localeCompare(b.key))) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ category: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** `vpn › fast › gaming`: a category named by its path from the top, as far as the list reaches. */
export function categoryPath<T extends TreeItem>(categories: readonly T[], id: string, name: (c: T) => string): string {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const path: string[] = [];
  for (let c = byId.get(id); c && path.length <= CATEGORY_MAX_DEPTH; c = c.parentId ? byId.get(c.parentId) : undefined) path.unshift(name(c));
  return path.join(" › ");
}

/**
 * The parents a category may be moved under (`self`), or a new one filed
 * under (`null`): not itself, nothing under it, and no place that would take
 * it — with everything under it — past {@link CATEGORY_MAX_DEPTH}. billing
 * refuses the same (`category_cycle`, `category_too_deep`); this keeps the
 * picker from offering them.
 */
export function parentChoices<T extends TreeItem>(categories: readonly T[], self: string | null): T[] {
  const tree = categoryTree(categories);
  const depthOf = new Map(tree.map((n) => [n.category.id, n.depth]));
  const below = new Set<string>();
  let span = 1;
  if (self) {
    below.add(self);
    for (const n of tree) {
      if (n.category.parentId && below.has(n.category.parentId)) {
        below.add(n.category.id);
        span = Math.max(span, n.depth - (depthOf.get(self) ?? 0) + 1);
      }
    }
  }
  return tree.filter((n) => !below.has(n.category.id) && n.depth + 1 + span <= CATEGORY_MAX_DEPTH).map((n) => n.category);
}

/** A move in billing's patch shape: blank is the top level, which billing takes as `null`. */
export const moveBody = (parentId: string): { parentId: string | null } => ({ parentId: parentId.trim() || null });

// ------------------------------------------------------------------- product

export type CatalogOwnerChoice = "own" | "platform" | "tenant";

/** The form as typed: every box a string. */
export interface ProductForm {
  /** The platform owner only: whose product it is. */
  owner: CatalogOwnerChoice;
  tenantId: string;
  /** Every category it is filed in; the first is shown first (F-026-r). */
  categoryIds: string[];
  key: string;
  sourceLang: string;
  name: string;
  /** Blank = none. */
  description: string;
  /** Draft every other language for review (F-1533-i). */
  translateAll: boolean;
  fulfilmentKind: FulfilmentKind;
  /** What a Grant of this product unlocks, picked from the ones in use or added. */
  featureKeys: string[];
}

export const emptyProductForm = (defaultLang: string): ProductForm => ({
  owner: "own",
  tenantId: "",
  categoryIds: [],
  key: "",
  sourceLang: defaultLang,
  name: "",
  description: "",
  translateAll: false,
  fulfilmentKind: "network_access",
  featureKeys: [],
});

export function validateProductForm(f: ProductForm, me: Me | null): Errors<ProductForm> {
  const errors: Errors<ProductForm> = {};
  if (isPlatformOwner(me) && f.owner === "tenant" && !UUID.test(f.tenantId.trim())) errors.tenantId = E.uuid;
  if (unique(f.categoryIds).length === 0) errors.categoryIds = E.required;
  if (!KEY.test(f.key.trim())) errors.key = E.key;
  if (blank(f.sourceLang)) errors.sourceLang = E.required;
  if (blank(f.name)) errors.name = E.required;
  if (unique(f.featureKeys).some((k) => !FEATURE_KEY.test(k))) errors.featureKeys = E.featureKey;
  return errors;
}

/** A new product, in billing's wire shape. `tenantId` only for the platform owner's choice. */
export function productBody(f: ProductForm, me: Me | null): CreateProductBody {
  const body: CreateProductBody = {
    categoryIds: unique(f.categoryIds),
    key: f.key.trim(),
    sourceLang: f.sourceLang.trim(),
    name: { [f.sourceLang.trim()]: f.name.trim() },
    fulfilmentKind: f.fulfilmentKind,
    featureKeys: unique(f.featureKeys),
  };
  if (!blank(f.description)) body.description = { [f.sourceLang.trim()]: f.description.trim() };
  if (f.translateAll) body.translateAll = true;
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
  /** A `network_access` variant's panel group; blank = none, and not for sale (F-026-o). */
  panelGroupId: string;
  /** A metered variant's first card (F-118-m): how its traffic is paid, and the price per GB. */
  rateMode: RateCardMode;
  ratePerGb: string;
}

export const emptyVariantForm = (): VariantForm => ({
  sku: "",
  billingMode: "prepaid",
  visibility: "public",
  qualityTier: "standard",
  durationDays: "",
  price: "",
  quotas: [],
  panelGroupId: "",
  rateMode: "prepaid",
  ratePerGb: "",
});

/** A metered variant earns on its rate, so its price is an optional one-off at purchase: blank is 0. */
const firstPrice = (f: VariantForm) => (f.billingMode === "metered" && blank(f.price) ? "0" : f.price.trim());

export function validateVariantForm(f: VariantForm): Errors<VariantForm> {
  const errors: Errors<VariantForm> = {};
  if (!SKU.test(f.sku.trim().toUpperCase())) errors.sku = E.sku;
  if (!DECIMAL.test(firstPrice(f))) errors.price = E.decimal;
  if (!blank(f.durationDays)) {
    const days = Number(f.durationDays.trim());
    if (!/^\d+$/.test(f.durationDays.trim()) || days < 1 || days > 3650) errors.durationDays = E.duration;
  }
  if (f.quotas.some((q) => !WHOLE.test(q.limit.trim()))) errors.quotas = E.quota;
  else if (new Set(f.quotas.map((q) => q.metric)).size !== f.quotas.length) errors.quotas = E.quotaRepeat;
  if (f.billingMode === "metered" && !isUnitPrice(f.ratePerGb)) errors.ratePerGb = E.unitPrice;
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

/** A new variant with its first price, in billing's wire shape. A group only for `network_access` (F-026-o). */
export function variantBody(f: VariantForm, kind: FulfilmentKind): CreateVariantBody {
  const group = f.panelGroupId.trim();
  return {
    sku: f.sku.trim().toUpperCase(),
    billingMode: f.billingMode,
    visibility: f.visibility,
    qualityTier: f.qualityTier,
    durationDays: blank(f.durationDays) ? null : Number(f.durationDays.trim()),
    price: firstPrice(f),
    ...(f.quotas.length ? { quotas: quotasOf(f.quotas) } : {}),
    ...(takesPanelGroup(kind) && group ? { panelGroupId: group } : {}),
    ...(f.billingMode === "metered" ? { rateCard: perGbCard(f.rateMode, f.ratePerGb) } : {}),
  };
}

// --------------------------------------------------------------- panel group

/** Only a `network_access` variant is placed on a panel, so only it names a group (F-026-o). */
export const takesPanelGroup = (kind: FulfilmentKind) => kind === "network_access";

/**
 * The groups a variant is offered: the platform's and its own tenant's, as
 * billing's `usableGroup` admits. `undefined` = billing already narrowed the
 * list (a tenant's own, or a reseller's screen); only the platform owner is
 * sent every group.
 */
export function groupsForVariant(groups: readonly PanelGroupOption[], tenantId: string | null | undefined): PanelGroupOption[] {
  return tenantId === undefined ? [...groups] : groups.filter((g) => g.tenantId === null || g.tenantId === tenantId);
}

/**
 * Billing's `?tenantId=` for the currency a price field names (F-116-h10,
 * catalog `GET /pricing-currency`): none for the surface's own rows,
 * `platform` for a platform row, a tenant the owner chose. `null` while a
 * typed tenant is no uuid yet — nothing to ask, rather than a 400 to show.
 */
export function pricingCurrencyQuery(owner: string | null | undefined): string | null {
  if (owner === undefined) return "";
  if (owner === null) return "?tenantId=platform";
  return UUID.test(owner.trim()) ? `?tenantId=${owner.trim()}` : null;
}

/** A price field's label with the code billing writes it in; before the answer, none — never a guessed one (ADR-0098). */
export const pricedIn = (label: string, code: string | null) => (code ? `${label} (${code})` : label);

/** Whose the wizard's variant will be, when the platform owner chose it; anyone else's is billing's to narrow. */
export function wizardVariantTenant(f: ProductForm, me: Me | null): string | null | undefined {
  if (!isPlatformOwner(me)) return undefined;
  if (f.owner === "platform") return null;
  return f.owner === "tenant" ? f.tenantId.trim() : me!.tenant.id;
}

/** An edit's group: blank clears it, which billing's schema takes as `null`. */
export const panelGroupPatch = (value: string): UpdateVariantBody => ({ panelGroupId: value.trim() || null });

/** A `network_access` variant with no group is never offered — billing's shop drops it (F-111-e). */
export const notForSale = (v: { panelGroupId: string | null }, kind: FulfilmentKind) => takesPanelGroup(kind) && v.panelGroupId === null;

// -------------------------------------------------------------------- wizard

/** A new product, one question at a time: where it goes, what it is called, what it unlocks, how it sells. */
export const WIZARD_STEPS = ["category", "names", "access", "variant", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * Where a created product leaves the panel (F-114-g): on the list, the new row
 * marked and the notice offering to open it — the sheet would only repeat what
 * the review just showed. Only a failed variant opens it, since that is the work left.
 */
export function afterWizard(productId: string, variantFailed: boolean) {
  return variantFailed
    ? { openId: productId, freshId: productId, notice: null, error: CATALOG_KEYS.wizard.partial }
    : { openId: null, freshId: productId, notice: CATALOG_KEYS.wizard.done, error: null };
}

export interface ProductWizard {
  categoryMode: "existing" | "new";
  /** The existing categories picked, in the order picked. */
  categoryIds: string[];
  newCategory: CategoryForm;
  product: ProductForm;
  /** A product with no variant cannot be sold; skipping is allowed, and the list says so. */
  withVariant: boolean;
  variant: VariantForm;
}

export const emptyWizard = (defaultLang: string): ProductWizard => ({
  categoryMode: "existing",
  categoryIds: [],
  newCategory: emptyCategoryForm(defaultLang),
  product: emptyProductForm(defaultLang),
  withVariant: true,
  variant: emptyVariantForm(),
});

const pick = <T extends object>(errors: T, keys: readonly (keyof T)[]) =>
  Object.fromEntries(Object.entries(errors).filter(([k]) => keys.includes(k as keyof T))) as Partial<T>;

/**
 * A category the product can be filed in: the platform's, or the product's own
 * tenant's — billing's `usableCategories`. `undefined` = billing decides (not the
 * platform owner): a tenant only ever sees its own and the platform's.
 */
const fitsOwner = (c: { tenantId: string | null }, tenant: string | null | undefined) =>
  tenant === undefined || c.tenantId === null || c.tenantId === tenant;

/**
 * The wizard's new category, filed where its product can use it: a platform
 * product's under the platform, another tenant's product's under that tenant.
 * Left to the "shared" box it would be the owner's own, and billing would then
 * refuse the product as `category_not_found`.
 */
export function wizardCategoryBody(w: ProductWizard, me: Me | null): CreateCategoryBody {
  const body = categoryBody(w.newCategory, isPlatformOwner(me));
  const tenant = wizardVariantTenant(w.product, me);
  if (tenant === undefined || w.product.owner === "own") return body;
  return { ...body, tenantId: tenant };
}

/**
 * One step's errors, keyed by the field of the form that step edits.
 * `categories`: what the existing picks are checked against for the product's owner.
 */
export function wizardStepErrors(
  step: WizardStep,
  w: ProductWizard,
  me: Me | null,
  categories: readonly { id: string; tenantId: string | null }[] = [],
): Record<string, string> {
  switch (step) {
    case "category": {
      if (w.categoryMode === "new") return validateCategoryForm(w.newCategory) as Record<string, string>;
      if (unique(w.categoryIds).length === 0) return { categoryIds: E.required };
      const tenant = wizardVariantTenant(w.product, me);
      const unfit = categories.some((c) => w.categoryIds.includes(c.id) && !fitsOwner(c, tenant));
      return unfit ? { categoryIds: CATALOG_KEYS.wizard.categoryNotForOwner } : {};
    }
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

export function firstInvalidStep(w: ProductWizard, me: Me | null, categories: readonly { id: string; tenantId: string | null }[] = []): WizardStep | null {
  return WIZARD_STEPS.find((s) => Object.keys(wizardStepErrors(s, w, me, categories)).length > 0) ?? null;
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
  new Intl.DateTimeFormat("en-CA", { timeZone: PLATFORM_DEFAULT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

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

// ------------------------------------------------------------ rate (F-118-m)

/** The one meter a card prices today, and the one shape billing serves on it (`servedByBytes`, F-118-m). */
export const VPN_TRAFFIC = "vpn.traffic";
const GIB_UNIT = String(GIB);

/** `Decimal(18, 8)` above zero: billing's `rate_card_metered_price_positive`. */
const UNIT_PRICE = /^(0|[1-9]\d{0,9})(\.\d{1,8})?$/;
const isUnitPrice = (v: string) => UNIT_PRICE.test(v.trim()) && /[1-9]/.test(v);

/** Per GiB, nothing included, then metered — any other `vpn.traffic` card billing refuses `rate_card_not_served`. */
const perGbCard = (mode: RateCardMode, price: string): RateCardTerms => ({
  meterKey: VPN_TRAFFIC,
  unitSize: GIB_UNIT,
  unitPrice: price.trim(),
  mode,
  afterIncluded: "metered",
});

export interface RateCardForm {
  mode: RateCardMode;
  unitPrice: string;
  /** `YYYY-MM-DD`, Tehran's day; blank = from now — a price's rule. */
  day: string;
}

export function validateRateCardForm(f: RateCardForm, today: string): Errors<RateCardForm> {
  const errors: Errors<RateCardForm> = {};
  if (!isUnitPrice(f.unitPrice)) errors.unitPrice = E.unitPrice;
  if (!blank(f.day) && f.day < today) errors.day = E.pastDay;
  return errors;
}

/** A new card, from now or a later day's first Tehran instant, as {@link priceBody}. */
export function rateCardBody(f: RateCardForm, today: string): SetRateCardBody {
  const card = perGbCard(f.mode, f.unitPrice);
  return blank(f.day) || f.day <= today ? card : { ...card, effectiveFrom: `${f.day}T00:00:00${TEHRAN_OFFSET}` };
}

/** Billing's `rateCardAt` for one meter (`vpn.traffic` unless named): the newest active card already in effect at `now`, or none. */
export function currentRateCard(cards: readonly CatalogRateCard[], now: Date = new Date(), meterKey: string = VPN_TRAFFIC): CatalogRateCard | null {
  let best: CatalogRateCard | null = null;
  for (const c of cards) {
    const at = new Date(c.effectiveFrom).getTime();
    if (c.meterKey !== meterKey || !c.isActive || at > now.getTime()) continue;
    if (!best || at > new Date(best.effectiveFrom).getTime()) best = c;
  }
  return best;
}

/**
 * A new link's price (F-118-r, ADR-0105 (7)): a `vpn.config.regenerate` card
 * on any variant, sold behind billing's per-use door (F-118-h). One link per
 * unit; `included` free per service, then each one charged or none — the
 * shapes billing's checks take (`rate_card_metered_price_positive`,
 * `rate_card_stop_includes_some`). With no card the count cap decides.
 */
export const CONFIG_REGENERATE = "vpn.config.regenerate";
const COUNT = /^(0|[1-9]\d{0,8})$/;

export interface RegenerateCardForm {
  mode: RateCardMode;
  /** Free per service; blank = none. */
  included: string;
  after: "metered" | "stop";
  /** Per new link past the free ones; unused when `after` is `stop`. */
  unitPrice: string;
  /** `YYYY-MM-DD`, Tehran's day; blank = from now — a price's rule. */
  day: string;
}

export function validateRegenerateCardForm(f: RegenerateCardForm, today: string): Errors<RegenerateCardForm> {
  const errors: Errors<RegenerateCardForm> = {};
  const included = f.included.trim() || "0";
  if (!COUNT.test(included)) errors.included = E.includedCount;
  else if (f.after === "stop" && included === "0") errors.included = E.stopIncludes;
  if (f.after === "metered" && !isUnitPrice(f.unitPrice)) errors.unitPrice = E.usePrice;
  if (!blank(f.day) && f.day < today) errors.day = E.pastDay;
  return errors;
}

/** A new regenerate card, from now or a later day's first Tehran instant, as {@link rateCardBody}. */
export function regenerateCardBody(f: RegenerateCardForm, today: string): SetRateCardBody {
  const card: RateCardTerms = {
    meterKey: CONFIG_REGENERATE,
    unitSize: "1",
    unitPrice: f.after === "metered" ? f.unitPrice.trim() : "0",
    mode: f.mode,
    includedQuantity: f.included.trim() || "0",
    afterIncluded: f.after,
  };
  return blank(f.day) || f.day <= today ? card : { ...card, effectiveFrom: `${f.day}T00:00:00${TEHRAN_OFFSET}` };
}

/** A metered variant with no card in effect is refused at sale (`metered_rate_missing`). */
export const noRate = (v: { billingMode: BillingMode; rateCards: readonly CatalogRateCard[] }, now: Date = new Date()) =>
  v.billingMode === "metered" && currentRateCard(v.rateCards, now) === null;

/** A rate's places: all it was written with, never fewer than its currency shows — 0.00045 is not 0.00. */
export const rateDecimals = (unitPrice: string, currencyDecimals: number) =>
  Math.max(currencyDecimals, (unitPrice.split(".")[1] ?? "").replace(/0+$/, "").length);

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

const CATEGORY_REMOVAL_ORDER: readonly CategoryRemoval["outcome"][] = ["deleted", "archived", "has_products", "has_children", "not_found"];
const CATEGORY_REMOVAL_KEYS: Record<CategoryRemoval["outcome"], string> = {
  deleted: CATALOG_KEYS.categories.deleted,
  archived: CATALOG_KEYS.categories.archived,
  has_products: CATALOG_KEYS.categories.hasProducts,
  has_children: CATALOG_KEYS.categories.hasChildren,
  not_found: CATALOG_KEYS.categories.notFound,
};

/**
 * What a group removal of categories did, one line per outcome that happened
 * (F-026-k over F-026-j), then what happened to the products removed with them
 * (F-026-m over F-026-l) — in the products' own sentences.
 */
export function categoryRemovalReport(outcomes: readonly CategoryRemoval[]): { key: string; count: number }[] {
  const products = (o: "deleted" | "archived" | "unlinked") => outcomes.reduce((n, r) => n + (r.products?.[o] ?? 0), 0);
  return [
    ...CATEGORY_REMOVAL_ORDER.map((o) => ({ key: CATEGORY_REMOVAL_KEYS[o], count: outcomes.filter((r) => r.outcome === o).length })),
    { key: CATALOG_KEYS.removal.deleted, count: products("deleted") },
    { key: CATALOG_KEYS.removal.archived, count: products("archived") },
    // Filed in another category too: taken out of this one, still sold there (F-026-r).
    { key: CATALOG_KEYS.categories.unlinked, count: products("unlinked") },
  ].filter((l) => l.count > 0);
}

/** Back from the archive, still switched off (F-026-n over F-026-l). */
export const RESTORE_CATEGORY = { archived: false } as const;

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
export function productCounts(...lists: readonly (readonly { categoryIds: readonly string[] }[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of lists.flat()) for (const id of p.categoryIds) counts.set(id, (counts.get(id) ?? 0) + 1);
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
