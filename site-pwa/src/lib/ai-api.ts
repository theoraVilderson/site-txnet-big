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
