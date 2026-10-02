// The caller's own AI suggestion (F-038-h), served by `ai-service` on
// `/api/ai` on the page's own domain (ADR-0060), routed there by Traefik behind
// `forward-auth` — the same shape as `notification-api.ts`. No route names a
// user: whose suggestion it is comes off the gate's `X-User-Id`.
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const call = createApiClient({
  baseUrl: `${API_BASE}/ai`,
  service: "ai-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});

/** The action types the card tells — ai-service's `CARD_TYPES`, spelled here in the same order. */
export const SUGGESTION_CARD_TYPES = ["renew", "resize_up", "resize_down"] as const;
export type SuggestionCardType = (typeof SUGGESTION_CARD_TYPES)[number];

/** The user's open suggestion: what it is about and the plan it names. Prices are the shop's, read beside it. */
export interface SuggestionCard {
  actionId: string;
  actionType: SuggestionCardType | (string & {});
  label: "suggestion";
  grantId: string;
  /** The plan the call to action buys. */
  variantId: string;
  /** The plan the service is on now; `null` when the engine did not say. */
  fromVariantId: string | null;
  /** ISO-8601; the service's end or predicted run-out. */
  deadline: string | null;
}

export const aiApi = {
  /** The caller's current suggestion, or `null`. */
  current(): Promise<{ suggestion: SuggestionCard | null }> {
    return call<{ suggestion: SuggestionCard | null }>("/me/suggestion", { method: "GET" });
  },

  /** Close this suggestion; the type stays open. */
  dismiss(actionId: string): Promise<{ dismissed: boolean }> {
    return call<{ dismissed: boolean }>(`/me/suggestion/${encodeURIComponent(actionId)}/dismiss`, { method: "POST" });
  },

  /** "Don't show this again": no suggestion of this type, ever (F-1505). */
  optOut(actionId: string): Promise<{ actionType: string }> {
    return call<{ actionType: string }>(`/me/suggestion/${encodeURIComponent(actionId)}/opt-out`, { method: "POST" });
  },
};

// ─── The reseller's AI admin (F-038-j2, over ai's `/api/ai/admin/*`, F-038-j1) ───
// Behind `ai.manage`. No call names a tenant or an author: both are the gate's.

/** ai-service's action types (ADR-0109 point 3, v1) — the settings answer them in this order. */
export const AI_ACTION_TYPES = ["renew", "resize_up", "resize_down", "top_up_wallet", "retain_offer", "trial_convert", "checkout_help", "win_back", "usage_alert"] as const;
export type AiActionType = (typeof AI_ACTION_TYPES)[number];

export interface AiSettings {
  engineEnabled: boolean;
  /** False when the package lacks AI or the tenant may not sell — whatever `engineEnabled` says. */
  engineRuns: boolean;
  /** A decimal string, two places, 0–1. */
  confidenceThreshold: string;
  /** 5–20. */
  holdoutPercent: number;
  disabledActionTypes: AiActionType[];
  actionTypes: AiActionType[];
}

export type AiSettingsPatch = Partial<Pick<AiSettings, "engineEnabled" | "confidenceThreshold" | "holdoutPercent" | "disabledActionTypes">>;

/** A reason is a code and its numbers; the page words it (`common.ai.reasons.*`). */
export type AiReason = { code: string } & Record<string, string | number | boolean | null>;

export interface AtRiskItem {
  userId: string;
  grantId: string | null;
  /** A probability (`renewal`) as stored, or days to run-out. */
  value: string | null;
  predictedAt: string | null;
  confidence: string;
  reasons: AiReason[];
}
export type AtRiskKind = "renewal" | "run_out";

/** One reseller in the platform owner's list (F-038-o2); `slug` null for one deleted since the run. */
export interface ResellerForecastItem {
  tenantId: string;
  slug: string | null;
  /** Days to run-out (`quota_exhaustion`) or a probability (`churn_risk`), as stored. */
  value: string | null;
  predictedAt: string | null;
  confidence: string;
  reasons: AiReason[];
}
export type ResellerForecastKind = "quota_exhaustion" | "churn_risk";

export interface AiMoney { amount: string; currencyCode: string }

/** One plan's margin (F-1528): price against its cost at the package's rate now; an unknown cost is null with its reason. */
export interface PlanMargin {
  variantId: string;
  productId: string;
  sku: string;
  nameKey: string;
  billingMode: "prepaid" | "metered";
  durationDays: number | null;
  /** Bytes, as a decimal string; null for an unlimited or a metered plan. */
  size: string | null;
  unlimited: boolean;
  price: AiMoney;
  cost: AiMoney | null;
  margin: AiMoney | null;
  losingMoney: boolean;
  /** `wholesale_cost`, or `cost_unknown` with `why`. */
  reasons: AiReason[];
  grants: { active: number; losing: number; costUnknown: number };
}
/** One plan in a family (F-1527): its users' use per period, bytes as decimal strings. */
export interface LayoutPlanRow {
  variantId: string;
  sku: string;
  nameKey: string;
  size: string;
  active: number;
  measured: number;
  usage: { p25: string; p50: string; p75: string; p90: string } | null;
  under: number;
  atCap: number;
}

/** `add_smaller` / `add_bigger` name a size (never a price); `no_takers` a plan nobody holds. */
export type LayoutSuggestion =
  | { code: "add_smaller" | "add_bigger"; variantId: string; users: number; measured: number; share: number; size: string; demandCensored?: boolean }
  | { code: "no_takers"; variantId: string; users: number; measured: number };

/** Plans a user can move between — one product, mode and length — with what their use suggests (F-1527). */
export interface LayoutFamily {
  productId: string;
  billingMode: "prepaid" | "metered";
  durationDays: number | null;
  plans: LayoutPlanRow[];
  suggestions: LayoutSuggestion[];
}

export interface UpliftArm { units: number; converted: number; rate: number | null; revenue: AiMoney[]; margin: AiMoney[]; marginUnknown: number }
export interface UpliftReport {
  from: string;
  to: string;
  types: Array<{ actionType: string; treated: UpliftArm; control: UpliftArm; uplift: { rate: number | null; revenue: AiMoney[]; margin: AiMoney[] } }>;
  renewals: { treated: number; control: number };
}

export interface AiOffer {
  id: string;
  name: string;
  actionType: "retain_offer";
  target: { couponTemplateId: string | null; variantId: string | null };
  maxDiscountPercent: string;
  dailyBudget: string;
  currencyCode: string;
  isActive: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}
export interface AiOfferBody {
  name: string;
  actionType: "retain_offer";
  couponTemplateId: string;
  maxDiscountPercent: string;
  dailyBudget: string;
  currencyCode: string;
}
export type AiOfferPatch = Partial<Pick<AiOffer, "name" | "maxDiscountPercent" | "dailyBudget" | "currencyCode" | "isActive">>;

/** ai's offer refusals (`error.reason`), each worded under `common.ai.refused`. */
export const AI_OFFER_REFUSALS = ["template_not_found", "template_not_a_discount", "variant_not_found", "offer_not_found"] as const;

export const aiAdminApi = {
  settings(): Promise<{ settings: AiSettings }> {
    return call<{ settings: AiSettings }>("/admin/settings", { method: "GET" });
  },
  saveSettings(patch: AiSettingsPatch): Promise<{ settings: AiSettings }> {
    return call<{ settings: AiSettings }>("/admin/settings", { method: "PUT", body: JSON.stringify(patch) });
  },
  atRisk(kind: AtRiskKind, cursor?: string | null): Promise<{ items: AtRiskItem[]; nextCursor: string | null }> {
    const q = new URLSearchParams({ kind, ...(cursor ? { cursor } : {}) });
    return call<{ items: AtRiskItem[]; nextCursor: string | null }>(`/admin/at-risk?${q}`, { method: "GET" });
  },
  /** The platform owner only; any other tenant is refused `not_platform_owner` (F-038-o2). */
  resellers(kind: ResellerForecastKind, cursor?: string | null): Promise<{ items: ResellerForecastItem[]; nextCursor: string | null }> {
    const q = new URLSearchParams({ kind, ...(cursor ? { cursor } : {}) });
    return call<{ items: ResellerForecastItem[]; nextCursor: string | null }>(`/admin/resellers?${q}`, { method: "GET" });
  },
  margins(): Promise<{ items: PlanMargin[] }> {
    return call<{ items: PlanMargin[] }>("/admin/margins", { method: "GET" });
  },
  planLayout(): Promise<{ families: LayoutFamily[] }> {
    return call<{ families: LayoutFamily[] }>("/admin/plan-layout", { method: "GET" });
  },
  uplift(from: string, to: string): Promise<UpliftReport> {
    return call<UpliftReport>("/admin/reports/uplift", { method: "POST", body: JSON.stringify({ from, to }) });
  },
  offers(): Promise<{ items: AiOffer[] }> {
    return call<{ items: AiOffer[] }>("/admin/offers", { method: "GET" });
  },
  createOffer(body: AiOfferBody): Promise<{ offer: AiOffer }> {
    return call<{ offer: AiOffer }>("/admin/offers", { method: "POST", body: JSON.stringify(body) });
  },
  updateOffer(offerId: string, patch: AiOfferPatch): Promise<{ offer: AiOffer }> {
    return call<{ offer: AiOffer }>(`/admin/offers/${encodeURIComponent(offerId)}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
};
