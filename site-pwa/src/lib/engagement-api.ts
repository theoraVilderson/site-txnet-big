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

// ------------------------------------------------------------------- the admin

/** One slot as saved, in a version (`WheelPrizeView`). Decimals are strings (C-02). */
export interface WheelPrize {
  id: string;
  position: number;
  label: string;
  prizeType: WheelPrizeType;
  prizeValue: string;
  couponTemplateId: string | null;
  couponValidDays: number | null;
  variantId: string | null;
  weight: number;
  costAmount: string;
  dailyStockLimit: number | null;
}

/** One version of the wheel (`WheelVersionView`); never changed once written. */
export interface WheelVersion {
  id: string;
  version: number;
  /** The tenant day it starts on, `YYYY-MM-DD`. */
  effectiveFromDay: string;
  isActive: boolean;
  dailyBudgetCapAmount: string;
  currencyCode: string;
  perUserCooldownHours: number;
  maxSpinsPerAccountPerDay: number;
  requiresMinAccountAgeHours: number;
  requiresMinTotalPurchaseAmount: string | null;
  requiresMinCompletedOrdersCount: number | null;
  requiresActiveServiceAtSpinTime: boolean;
  requiresPhoneVerified: boolean;
  userGroupId: string | null;
  createdByAdminId: string;
  createdAt: string;
  /** Σ weight × cost / Σ weight, billing's figure. */
  expectedCostPerSpin: string;
  prizes: WheelPrize[];
}

export interface WheelState {
  today: string;
  inForce: WheelVersion | null;
  /** Saved for a later day: what tomorrow brings. */
  next: WheelVersion | null;
  /** Newest first. */
  history: WheelVersion[];
}

/** `POST …/wheel/versions` — the `.strict()` `wheelVersionSchema`, prizes in slot order. */
export interface WheelPrizeBody {
  label: string;
  prizeType: WheelPrizeType;
  prizeValue: string;
  couponTemplateId?: string | null;
  couponValidDays?: number | null;
  variantId?: string | null;
  weight: number;
  costAmount: string;
  dailyStockLimit?: number | null;
}

export interface WheelVersionBody {
  isActive: boolean;
  dailyBudgetCapAmount: string;
  perUserCooldownHours: number;
  maxSpinsPerAccountPerDay: number;
  requiresMinAccountAgeHours: number;
  requiresMinTotalPurchaseAmount: string | null;
  requiresMinCompletedOrdersCount: number | null;
  requiresActiveServiceAtSpinTime: boolean;
  requiresPhoneVerified: boolean;
  userGroupId: string | null;
  prizes: WheelPrizeBody[];
}

/** One tenant day of the report (F-707-e). */
export interface WheelDayReport {
  day: string;
  version: number;
  spins: number;
  refused: number;
  refusals: Record<string, number>;
  nothing: number;
  prizes: Array<{ prizeId: string; position: number; label: string; prizeType: WheelPrizeType; count: number; cost: string }>;
  costSpent: string;
  cap: string;
  currencyCode: string;
  capUsedPercent: string;
  alertedAt: string | null;
}

// -------------------------------------------------------------------- the user

/** The wheel as the user sees it (`WheelView`): the public odds and whether they may spin. */
export interface UserWheel {
  tenantDay: string;
  version: number;
  currencyCode: string;
  /** This user's own odds (F-707-u); `reachable: false` = the prize cannot reach their services, so 0% (F-707-v). */
  prizes: Array<{ position: number; label: string; prizeType: WheelPrizeType; prizeValue: string; oddsPercent: string; reachable: boolean }>;
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

export const wheelAdminApi = {
  state(): Promise<WheelState> {
    return call<WheelState>("/engagement/wheel", { method: "GET" });
  },
  /** A new version from the tenant's next day; nothing in force changes today. */
  save(body: WheelVersionBody): Promise<WheelVersion> {
    return call<WheelVersion>("/engagement/wheel/versions", json(body));
  },
  /** Tenant days, inclusive; both default to today, at most 31. */
  report(query: { from?: string; to?: string } = {}): Promise<WheelDayReport[]> {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]).toString();
    return call<WheelDayReport[]>(`/engagement/wheel/report${q ? `?${q}` : ""}`, { method: "GET" });
  },
};

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

// ----------------------------------------------------------------- lotteries

/** A lottery as its user sees it (`UserLotteryView`, F-707-j). */
export type LotteryStatus = "published" | "frozen" | "drawn" | "cancelled";

export interface UserLottery {
  id: string;
  title: string;
  description: string | null;
  entryMode: "automatic" | "opt_in";
  status: LotteryStatus;
  closesAt: string;
  publishedAt: string | null;
  cancelReason: string | null;
  /** Published and before its close: a join or a leave is accepted now. */
  open: boolean;
  prizes: Array<{ rank: number; label: string; prizeType: WheelPrizeType; prizeValue: string; winnersCount: number }>;
  entry: { optedInAt: string | null; ticketNumber: number | null; excludedReason: string | null } | null;
}

export interface LotteryEntryResult {
  lotteryId: string;
  joined: boolean;
  optedInAt?: string | null;
  replay: boolean;
}

export type LotteryDelivery = "pending" | "delivered" | "passed_on";

/** A drawn lottery's public result (`LotteryResult`, F-707-m): all the verify step needs. */
export interface LotteryResult {
  lotteryId: string;
  title: string;
  algorithm: string;
  seed: string;
  listHash: string;
  entrantCount: number;
  prizes: Array<{ rank: number; label: string; winnersCount: number }>;
  reservesCount: number;
  frozenAt: string;
  drawnAt: string;
  tickets: Array<{ ticketNumber: number; entrantId: string }>;
  places: Array<{
    position: number;
    ticketNumber: number;
    prize: { rank: number; label: string } | null;
    delivery: LotteryDelivery;
    passedOnReason: string | null;
    replacesPosition: number | null;
  }>;
  mine: { entrantId: string; ticketNumber: number | null; excludedReason: string | null } | null;
}

const lotteryPath = (id: string) => `/lotteries/${encodeURIComponent(id)}`;

export const lotteryApi = {
  list(): Promise<UserLottery[]> {
    return call<UserLottery[]>("/lotteries", { method: "GET" });
  },
  /** Idempotent: a repeat answers the kept entry with `replay: true`. */
  join(id: string): Promise<LotteryEntryResult> {
    return call<LotteryEntryResult>(`${lotteryPath(id)}/entry`, { method: "POST" });
  },
  leave(id: string): Promise<LotteryEntryResult> {
    return call<LotteryEntryResult>(`${lotteryPath(id)}/entry`, { method: "DELETE" });
  },
  result(id: string): Promise<LotteryResult> {
    return call<LotteryResult>(`${lotteryPath(id)}/result`, { method: "GET" });
  },
};

// ------------------------------------------------------- lotteries, the admin

export type AdminLotteryStatus = "draft" | LotteryStatus;
/** A lottery prize: billing refuses `wallet_credit` and `empty` (F-707-i rule 5). */
export type LotteryPrizeType = Exclude<WheelPrizeType, "empty">;

/** One lottery as its admin sees it (`LotteryView`, F-707-i). Decimals are strings (C-02). */
export interface AdminLottery {
  id: string;
  status: AdminLotteryStatus;
  userGroupId: string;
  title: string;
  description: string | null;
  entryMode: "automatic" | "opt_in";
  closesAt: string;
  requiresPhoneVerified: boolean;
  requiresMinAccountAgeHours: number;
  reservesCount: number;
  publishedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdByAdminId: string;
  createdAt: string;
  /** Opt-ins while open; every judged member after the freeze. */
  entrantCount: number;
  winnersTotal: number;
  prizes: Array<{
    id: string;
    rank: number;
    label: string;
    prizeType: LotteryPrizeType;
    prizeValue: string;
    couponTemplateId: string | null;
    couponValidDays: number | null;
    variantId: string | null;
    winnersCount: number;
  }>;
}

/** `POST` / `PUT …/engagement/lotteries` — the `.strict()` `lotteryDraftSchema`, prizes in rank order. */
export interface LotteryDraftBody {
  userGroupId: string;
  title: string;
  description: string | null;
  entryMode: "automatic" | "opt_in";
  /** An instant. */
  closesAt: string;
  requiresPhoneVerified: boolean;
  requiresMinAccountAgeHours: number;
  reservesCount: number;
  prizes: Array<{
    label: string;
    prizeType: LotteryPrizeType;
    prizeValue: string;
    couponTemplateId: string | null;
    couponValidDays: number | null;
    variantId: string | null;
    winnersCount: number;
  }>;
}

/** `GET …/:id/eligibility` (`LotteryEligibility`, F-707-o): who enters if it closed now, or who did. */
export interface LotteryEligibility {
  lotteryId: string;
  asOf: string;
  final: boolean;
  members: number | null;
  eligibleMembers: number | null;
  candidates: number;
  eligible: number;
  excluded: Record<string, number>;
  skippedResellerCount: number;
}

/** `GET …/:id/winners` (`LotteryWinners`, F-707-o): each place and who holds it, once drawn. */
export interface LotteryWinners {
  lotteryId: string;
  entrantCount: number;
  frozenAt: string;
  drawnAt: string;
  publishedAt: string | null;
  places: Array<{
    position: number;
    ticketNumber: number;
    user: { id: string; fullName: string; username: string | null } | null;
    prize: { rank: number; label: string } | null;
    delivery: LotteryDelivery;
    deliveredAt: string | null;
    passedOnReason: string | null;
    replacesPosition: number | null;
  }>;
}

const adminLotteryPath = (id: string) => `/engagement/lotteries/${encodeURIComponent(id)}`;

export const lotteryAdminApi = {
  list(): Promise<AdminLottery[]> {
    return call<AdminLottery[]>("/engagement/lotteries", { method: "GET" });
  },
  get(id: string): Promise<AdminLottery> {
    return call<AdminLottery>(adminLotteryPath(id), { method: "GET" });
  },
  create(body: LotteryDraftBody): Promise<AdminLottery> {
    return call<AdminLottery>("/engagement/lotteries", json(body));
  },
  /** A draft rewritten whole, prizes too. */
  replace(id: string, body: LotteryDraftBody): Promise<AdminLottery> {
    return call<AdminLottery>(adminLotteryPath(id), { method: "PUT", body: JSON.stringify(body) });
  },
  remove(id: string): Promise<void> {
    return call<void>(adminLotteryPath(id), { method: "DELETE" });
  },
  publish(id: string): Promise<AdminLottery> {
    return call<AdminLottery>(`${adminLotteryPath(id)}/publish`, { method: "POST" });
  },
  /** The reason is shown to users. */
  cancel(id: string, reason: string): Promise<AdminLottery> {
    return call<AdminLottery>(`${adminLotteryPath(id)}/cancel`, json({ reason }));
  },
  eligibility(id: string): Promise<LotteryEligibility> {
    return call<LotteryEligibility>(`${adminLotteryPath(id)}/eligibility`, { method: "GET" });
  },
  winners(id: string): Promise<LotteryWinners> {
    return call<LotteryWinners>(`${adminLotteryPath(id)}/winners`, { method: "GET" });
  },
};
