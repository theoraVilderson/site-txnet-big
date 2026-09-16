// Catalog management (F-026-d) is served by billing-service on its own public
// path, `api.${DOMAIN_NAME}/api/catalog` (ADR-0049; the user's call, 2026-09-14).
// Cross-origin with the access token as a Bearer header, exactly as
// `billing-api.ts` calls billing: the same gate, the same credential.
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const API_URL = `${process.env.NEXT_PUBLIC_API_ORIGIN}/api/catalog`;

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
export type UpdateProductBody = Partial<Pick<CreateProductBody, "sourceLang" | "name" | "description" | "featureKeys" | "defaultQuotas">> & { isActive?: boolean };

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

export const catalogApi = {
  async categories(): Promise<CatalogCategory[]> {
    return call<CatalogCategory[]>("/categories", { method: "GET" });
  },

  async createCategory(body: CreateCategoryBody): Promise<CatalogCategory> {
    return call<CatalogCategory>("/categories", { method: "POST", ...json(body) });
  },

  async updateCategory(categoryId: string, body: { sourceLang?: string; name?: Texts; isActive?: boolean }): Promise<CatalogCategory> {
    return call<CatalogCategory>(`/categories/${id(categoryId)}`, { method: "PATCH", ...json(body) });
  },

  /** The platform owner may narrow by a tenant id or `platform`; a tenant always gets its own. */
  async products(query: { categoryId?: string; tenantId?: string } = {}): Promise<CatalogProduct[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
    const qs = params.toString();
    return call<CatalogProduct[]>(`/products${qs ? `?${qs}` : ""}`, { method: "GET" });
  },

  /** A product with its variants and each variant's whole price history. */
  async product(productId: string): Promise<CatalogProductDetail> {
    return call<CatalogProductDetail>(`/products/${id(productId)}`, { method: "GET" });
  },

  async createProduct(body: CreateProductBody): Promise<CatalogProduct> {
    return call<CatalogProduct>("/products", { method: "POST", ...json(body) });
  },

  async updateProduct(productId: string, body: UpdateProductBody): Promise<CatalogProduct> {
    return call<CatalogProduct>(`/products/${id(productId)}`, { method: "PATCH", ...json(body) });
  },

  async createVariant(productId: string, body: CreateVariantBody): Promise<CatalogVariant> {
    return call<CatalogVariant>(`/products/${id(productId)}/variants`, { method: "POST", ...json(body) });
  },

  async updateVariant(variantId: string, body: UpdateVariantBody): Promise<CatalogVariant> {
    return call<CatalogVariant>(`/variants/${id(variantId)}`, { method: "PATCH", ...json(body) });
  },

  /** A new price row; the old one stays as it was. */
  async setPrice(variantId: string, body: SetPriceBody): Promise<CatalogPrice> {
    return call<CatalogPrice>(`/variants/${id(variantId)}/prices`, { method: "POST", ...json(body) });
  },

  async deactivatePrice(priceId: string): Promise<CatalogPrice> {
    return call<CatalogPrice>(`/prices/${id(priceId)}/deactivate`, { method: "POST" });
  },

  // Translation review (F-1533-d/e): billing limits each call to the caller's items.

  async translations(lang?: string): Promise<TranslationDraft[]> {
    return call<TranslationDraft[]>(`/translations${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`, { method: "GET" });
  },

  /** Drafts every language that has neither text nor a draft yet. */
  async draftMissing(): Promise<{ drafted: number }> {
    return call<{ drafted: number }>("/translations/draft-missing", { method: "POST" });
  },

  async publishTranslations(lang: string, keys: string[]): Promise<{ published: number }> {
    return call<{ published: number }>("/translations/publish", { method: "POST", ...json({ lang, keys }) });
  },

  async editTranslations(lang: string, texts: Record<string, string>): Promise<{ published: number }> {
    return call<{ published: number }>("/translations", { method: "PATCH", ...json({ lang, texts }) });
  },

  /**
   * The published `catalog` namespace in one language, flat by full key — from
   * the panel's own i18n route (same origin, what the rest of the panel reads).
   * A language with no catalog text yet answers 404: that is `{}`, not an error.
   */
  async texts(lang: string): Promise<unknown> {
    const res = await fetch(`/api/i18n/${encodeURIComponent(lang)}/catalog`, { cache: "no-store" });
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`catalog texts ${lang}: ${res.status}`);
    return res.json();
  },
};
