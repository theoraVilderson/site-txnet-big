// The wheel (F-707), served by billing-service's `engagement/` module on
// `/api/billing` on the page's own domain (ADR-0060), behind `forward-auth` —
// the same door as `billing-api.ts`, kept in its own file because that one is
// already 2,000 lines. No route names a user or a tenant: the gate's
// `X-User-Id` and RLS decide whose wheel it is.
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const call = createApiClient({
  baseUrl: `${API_BASE}/billing`,
  service: "billing-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});

/** Prisma's `SpinPrizeType`, less `wallet_credit`: billing refuses it on every row (ADR-0111 point 2). */
export const WHEEL_PRIZE_TYPES = ["bonus_traffic_gb", "extra_days", "discount_coupon", "free_grant", "empty"] as const;
export type WheelPrizeType = (typeof WHEEL_PRIZE_TYPES)[number];

export type SpinStatus = "awarded" | "voided_fraud" | "rejected_ineligible";

// -------------------------------------------------------------------- the user

/** The wheel as the user sees it (`WheelView`): the public odds and whether they may spin. */
export interface UserWheel {
  tenantDay: string;
  version: number;
  currencyCode: string;
  prizes: Array<{ position: number; label: string; prizeType: WheelPrizeType; prizeValue: string; oddsPercent: string }>;
  eligible: boolean;
  refusalReason: string | null;
  spinsLeftToday: number;
  nextSpinAt: string | null;
}

/** A spin's answer (`SpinResult`). A refused spin is a recorded `200`, not an error. */
export interface SpinResult {
  attemptId: string;
  status: SpinStatus;
  refusalReason: string | null;
  version: number;
  tenantDay: string;
  seq: number | null;
  /** The slot the wheel stops on: the prize's, or the first empty one. `null` = refused. */
  position: number | null;
  prize: { position: number; label: string; prizeType: WheelPrizeType; prizeValue: string } | null;
  reward: { grantId: string | null; coupon: { id: string; code: string; percent: string; expiresAt: string } | null } | null;
  replay: boolean;
}

export interface WheelHistoryRow {
  attemptId: string;
  at: string;
  tenantDay: string;
  status: SpinStatus;
  refusalReason: string | null;
  prize: { label: string; prizeType: WheelPrizeType; prizeValue: string } | null;
  coupon: { code: string; expiresAt: string | null } | null;
}

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const wheelApi = {
  view(): Promise<UserWheel> {
    return call<UserWheel>("/wheel", { method: "GET" });
  },
  /** `requestId` is one tap's key: sent again after a lost answer, billing answers the same spin. */
  spin(requestId: string): Promise<SpinResult> {
    return call<SpinResult>("/wheel/spin", json({ requestId }));
  },
  history(): Promise<WheelHistoryRow[]> {
    return call<WheelHistoryRow[]>("/wheel/history", { method: "GET" });
  },
};
