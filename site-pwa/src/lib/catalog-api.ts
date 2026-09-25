// Catalog management (F-026-d) is served by billing-service on its own public
// path, `/api/catalog` on the page's own domain (ADR-0049, ADR-0060). The
// access token as a Bearer header, exactly as `billing-api.ts` calls billing:
// the same gate, the same credential.
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const API_URL = `${API_BASE}/catalog`;

const call = createApiClient({
  baseUrl: API_URL,
  service: "billing-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});

/** Prisma's `FulfilmentKind` (§4.1). `catalog.test.ts` holds each tuple to its enum. */
export const FULFILMENT_KINDS = ["network_access", "external_order", "feature_access", "wallet_topup"] as const;
export type FulfilmentKind = (typeof FULFILMENT_KINDS)[number];
/** Prisma's `VariantVisibility` (§4.2). */
export const VISIBILITIES = ["public", "unlisted", "admin_only"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
/** Prisma's `VariantBillingMode`. */
export const BILLING_MODES = ["prepaid", "metered"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
/** Prisma's `QualityTier` (F-408). */
export const QUALITY_TIERS = ["standard", "premium"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];
/** Prisma's `QuotaMetric` (§4.5). */
export const QUOTA_METRICS = ["traffic_bytes", "concurrent_devices", "order_units", "feature_items", "api_calls"] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];
/** The schema's `RESET_POLICIES`. */
export const RESET_POLICIES = ["none", "monthly", "daily"] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

export type Quotas = Partial<Record<QuotaMetric, { limit: number; resetPolicy: ResetPolicy }>>;

/** Every reason `/catalog` can refuse with (`catalog/contract.md` "HTTP surface"). */
export type CatalogRejection =
  | "not_platform_owner"
  | "tenant_not_found"
  | "category_not_found"
  | "product_not_found"
  | "variant_not_found"
  | "price_not_found"
  | "key_taken"
  | "sku_taken"
  | "price_in_the_past"
  | "panel_group_not_found"
  | "text_key_invalid"
  | "texts_unavailable"
  | "lang_unknown"
  | "source_text_missing";

/** Text by language code (F-1533-d/f); at least the item's source language. The key is billing's. */
export type Texts = Record<string, string>;

/** One machine draft waiting for review, beside its source (`GET /translations`). */
export interface TranslationDraft {
  lang: string;
  /** The full i18n key the item row holds. */
  key: string;
  draft: string;
  published: string | null;
  /** The item's source language and its published text there. */
  source: { lang: string; text: string | null };
}

export interface CreateCategoryBody {
  tenantId?: string | null;
  key: string;
  /** Absent = billing's `DEFAULT_LANGUAGE`. */
  sourceLang?: string;
  name: Texts;
}

export interface CatalogCategory {
  id: string;
  /** `null` = the platform's, shared with every tenant. */
  tenantId: string | null;
  key: string;
  nameKey: string;
  /** The language its name was written in; the list falls back to it. */
  sourceLang: string;
  isActive: boolean;
  /** Set when it was removed with its products and a sold one stayed in it (F-026-l); only in the `archived` list. */
  archivedAt: string | null;
}

export interface CatalogProduct {
  id: string;
  tenantId: string | null;
  categoryId: string;
  key: string;
  nameKey: string;
  descriptionKey: string | null;
  sourceLang: string;
  fulfilmentKind: FulfilmentKind;
  featureKeys: string[];
  defaultQuotas: Quotas;
  isActive: boolean;
  /** Set when a removal found it sold and kept it (F-026-h); such a product is only in the `archived` list. */
  archivedAt: string | null;
}

/** What a removal did to one product (F-026-h): gone for good, kept because it was sold, or not the caller's. */
export interface ProductRemoval {
  id: string;
  outcome: "deleted" | "archived" | "not_found";
}

/**
 * What a removal did to one category (F-026-j): gone, kept because a product sits in it (archived ones too), or not
 * the caller's. Removed with its products (F-026-l): `archived` when a sold one stays, and what happened to them.
 */
export interface CategoryRemoval {
  id: string;
  outcome: "deleted" | "archived" | "has_products" | "not_found";
  products?: { deleted: number; archived: number };
}

/** Base currency, a decimal string (C-02). A row is history: never edited, only switched off. */
export interface CatalogPrice {
  id: string;
  variantId: string;
  amount: string;
  effectiveFrom: string;
  isActive: boolean;
}

export interface CatalogVariant {
  id: string;
  tenantId: string | null;
  productId: string;
  sku: string;
  nameKey: string | null;
  quotas: Quotas;
  /** `null` = permanent. */
  durationDays: number | null;
  billingMode: BillingMode;
  visibility: Visibility;
  panelGroupId: string | null;
  qualityTier: QualityTier;
  isActive: boolean;
  /** Newest `effectiveFrom` first. */
  prices: CatalogPrice[];
}

export type CatalogProductDetail = CatalogProduct & { variants: CatalogVariant[] };

export interface CreateProductBody {
  /** Absent = the caller's tenant; `null` = platform; another id = the platform owner's alone. */
  tenantId?: string | null;
  categoryId: string;
  key: string;
  sourceLang?: string;
  name: Texts;
  description?: Texts | null;
  fulfilmentKind: FulfilmentKind;
  featureKeys?: string[];
  defaultQuotas?: Quotas;
}
export type UpdateProductBody = Partial<Pick<CreateProductBody, "sourceLang" | "name" | "description" | "featureKeys" | "defaultQuotas">> & {
  isActive?: boolean;
  /** Only `false`: back from the archive, still switched off. */
  archived?: false;
};

export interface CreateVariantBody {
  sku: string;
  billingMode: BillingMode;
  visibility: Visibility;
  qualityTier?: QualityTier;
  durationDays?: number | null;
  quotas?: Quotas;
  nameKey?: string | null;
  /** The first price. */
  price: string;
  effectiveFrom?: string;
}
export type UpdateVariantBody = Partial<Pick<CreateVariantBody, "visibility" | "qualityTier" | "durationDays" | "quotas" | "nameKey">> & { isActive?: boolean };

export interface SetPriceBody {
  amount: string;
  /** Absent = now. Never in the past. */
  effectiveFrom?: string;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const id = (v: string) => encodeURIComponent(v);

/**
 * Which tenant's catalog a call is about: `""` for the caller's own
 * (`/api/catalog/...`), `/tenants/:id` for the reseller a route names
 * (F-066-w7, ADR-0064). Never read from the session or the host — a reseller's
 * owner signs in to the platform owner's tenant (ADR-0059), so the ambient
 * path would manage the **platform's** catalog and answer 200 doing it.
 */
export const catalogApiPrefix = (tenantId: string | null) => (tenantId === null ? "" : `/tenants/${id(tenantId)}`);

/** The calls both catalog surfaces answer. The page's components take one of these, never `catalogApi` itself. */
export type CatalogAdminApi = ReturnType<typeof catalogAdminApi>;

/**
 * The catalog calls for one surface: `null` for the caller's own tenant
 * (F-026-f), a tenant id for the reseller the path names (F-066-w8). Billing
 * still decides everything — this only chooses which tenant is being asked
 * about, and `texts` is the panel's own i18n route either way.
 */
export function catalogAdminApi(tenantId: string | null) {
  const at = catalogApiPrefix(tenantId);
  return {
    async categories(query: { archived?: "true" } = {}): Promise<CatalogCategory[]> {
      const qs = new URLSearchParams(query).toString();
      return call<CatalogCategory[]>(`${at}/categories${qs ? `?${qs}` : ""}`, { method: "GET" });
    },

    async createCategory(body: CreateCategoryBody): Promise<CatalogCategory> {
      return call<CatalogCategory>(`${at}/categories`, { method: "POST", ...json(body) });
    },

    async updateCategory(categoryId: string, body: { sourceLang?: string; name?: Texts; isActive?: boolean; archived?: false }): Promise<CatalogCategory> {
      return call<CatalogCategory>(`${at}/categories/${id(categoryId)}`, { method: "PATCH", ...json(body) });
    },

    /** The platform owner may narrow by a tenant id or `platform`; a tenant always gets its own. `archived: "true"` lists the archived alone. */
    /** One outcome per id; an empty category is deleted, one holding products is kept (F-026-j) — or, `withProducts`, removed with them (F-026-l). */
    async removeCategories(ids: string[], withProducts = false): Promise<CategoryRemoval[]> {
      return call<CategoryRemoval[]>(`${at}/categories/remove`, { method: "POST", ...json(withProducts ? { ids, withProducts } : { ids }) });
    },

    async products(query: { categoryId?: string; tenantId?: string; archived?: "true" } = {}): Promise<CatalogProduct[]> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
      const qs = params.toString();
      return call<CatalogProduct[]>(`${at}/products${qs ? `?${qs}` : ""}`, { method: "GET" });
    },

    /** A product with its variants and each variant's whole price history. */
    async product(productId: string): Promise<CatalogProductDetail> {
      return call<CatalogProductDetail>(`${at}/products/${id(productId)}`, { method: "GET" });
    },

    async createProduct(body: CreateProductBody): Promise<CatalogProduct> {
      return call<CatalogProduct>(`${at}/products`, { method: "POST", ...json(body) });
    },

    async updateProduct(productId: string, body: UpdateProductBody): Promise<CatalogProduct> {
      return call<CatalogProduct>(`${at}/products/${id(productId)}`, { method: "PATCH", ...json(body) });
    },

    /** One outcome per id; a sold product is archived, never deleted (F-026-h). */
    async removeProducts(ids: string[]): Promise<ProductRemoval[]> {
      return call<ProductRemoval[]>(`${at}/products/remove`, { method: "POST", ...json({ ids }) });
    },

    async createVariant(productId: string, body: CreateVariantBody): Promise<CatalogVariant> {
      return call<CatalogVariant>(`${at}/products/${id(productId)}/variants`, { method: "POST", ...json(body) });
    },

    async updateVariant(variantId: string, body: UpdateVariantBody): Promise<CatalogVariant> {
      return call<CatalogVariant>(`${at}/variants/${id(variantId)}`, { method: "PATCH", ...json(body) });
    },

    /** A new price row; the old one stays as it was. */
    async setPrice(variantId: string, body: SetPriceBody): Promise<CatalogPrice> {
      return call<CatalogPrice>(`${at}/variants/${id(variantId)}/prices`, { method: "POST", ...json(body) });
    },

    async deactivatePrice(priceId: string): Promise<CatalogPrice> {
      return call<CatalogPrice>(`${at}/prices/${id(priceId)}/deactivate`, { method: "POST" });
    },

    // Translation review (F-1533-d/e): billing limits each call to the caller's items.

    async translations(lang?: string): Promise<TranslationDraft[]> {
      return call<TranslationDraft[]>(`${at}/translations${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`, { method: "GET" });
    },

    /** Drafts every language that has neither text nor a draft yet. */
    async draftMissing(): Promise<{ drafted: number }> {
      return call<{ drafted: number }>(`${at}/translations/draft-missing`, { method: "POST" });
    },

    async publishTranslations(lang: string, keys: string[]): Promise<{ published: number }> {
      return call<{ published: number }>(`${at}/translations/publish`, { method: "POST", ...json({ lang, keys }) });
    },

    async editTranslations(lang: string, texts: Record<string, string>): Promise<{ published: number }> {
      return call<{ published: number }>(`${at}/translations`, { method: "PATCH", ...json({ lang, texts }) });
    },

    /**
     * The published `catalog` namespace in one language, flat by full key — from
     * the panel's own i18n route (same origin, what the rest of the panel reads).
     * A language with no catalog text yet answers 404: that is `{}`, not an error.
     *
     * The same on both surfaces: a reseller's items are named in the same
     * published namespace, and this route is the panel's, not billing's.
     */
    async texts(lang: string): Promise<unknown> {
      const res = await fetch(`/api/i18n/${encodeURIComponent(lang)}/catalog`, { cache: "no-store" });
      if (res.status === 404) return {};
      if (!res.ok) throw new Error(`catalog texts ${lang}: ${res.status}`);
      return res.json();
    },
  };
}

/** The caller's own catalog — what `catalogApi` has always been (F-026-f). */
export const catalogApi = catalogAdminApi(null);
