// Coupons, discounts with no code and gift-code batches (F-502-g/h, F-114-k).
import { call } from "./client";
import type { GatewaySource } from "./gateways";

/** `?a=1&b=2` from the defined values of `query`, or nothing. */
function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
  const out = params.toString();
  return out ? `?${out}` : "";
}

/** A coupon's state at a glance, as billing derives it (`statusOf`, F-502-c). */
export type CouponStatus = "active" | "inactive" | "scheduled" | "expired" | "exhausted" | "deleted";

export type CouponChannel = "panel" | "bot";

export interface CouponGatewayRef {
  source: GatewaySource;
  id: string;
}

/** Every reason `/discount-rules` can refuse with (`billing/contract.purchase.md` "Discounts with no code"). */
export type DiscountRuleRejection =
  | "rule_not_found"
  | "target_not_found"
  | "user_out_of_scope"
  | "invalid_value"
  | "invalid_window"
  | "one_target"
  | "named_needs_users"
  | "one_audience"
  | "group_not_found"
  /** ADR-0143: a new group this caller may not pick. */
  | "audience_not_allowed";

/** What an admin sees at a glance; billing decides it (`statusOfRule`). */
export type DiscountRuleStatus = "off" | "ended" | "scheduled" | "running";

/** A discount with no code as `GET /discount-rules` answers it (F-114-h, ADR-0087). `value` is a decimal string (C-02). */
export interface DiscountRule {
  id: string;
  name: string;
  kind: "percentage" | "fixed_amount";
  value: string;
  /** The rule's own currency: what a `fixed_amount` value is in (F-116-h2). */
  currencyCode: string;
  /** At most one of these two; neither = everything. A category covers every category under it. */
  productId: string | null;
  categoryId: string | null;
  /** Serves only `userIds`. Never together with `groupId`. */
  forNamedUsers: boolean;
  userIds: string[];
  /** Serves the user members of one group (F-114-j). */
  groupId: string | null;
  startsAt: string;
  /** Exclusive; `null` = until switched off. */
  endsAt: string | null;
  isActive: boolean;
  status: DiscountRuleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateDiscountRuleBody {
  name?: string;
  kind?: DiscountRule["kind"];
  value?: string;
  productId?: string | null;
  categoryId?: string | null;
  forNamedUsers?: boolean;
  userIds?: string[];
  groupId?: string | null;
  startsAt?: string;
  endsAt?: string | null;
  isActive?: boolean;
}

export type CreateDiscountRuleBody = UpdateDiscountRuleBody & Required<Pick<UpdateDiscountRuleBody, "name" | "kind" | "value" | "startsAt">>;

/** Every reason `/coupons` can refuse with (`billing/contract.coupon.md` "HTTP surface"). */
export type CouponRejection =
  | "not_platform_owner"
  | "coupon_not_found"
  | "tenant_not_found"
  | "code_taken"
  | "invalid_code"
  | "invalid_value"
  | "invalid_limit"
  | "limits_not_for_gift_codes"
  | "targeted_needs_users"
  | "user_out_of_scope"
  | "platform_coupon_needs_platform_gateway"
  | "gateway_not_found"
  | "scope_not_found"
  | "variant_not_found"
  | "used_coupon_frozen"
  | "capacity_below_used"
  | "batch_not_found"
  | "invalid_batch";

/** A coupon as `GET /coupons` answers it (F-502-c). Decimals are strings (C-02); instants ISO. */
export interface AdminCoupon {
  id: string;
  /** `null` = a platform coupon. */
  tenantId: string | null;
  code: string;
  discountType: "percentage" | "fixed_amount" | "wallet_credit" | "free_grant";
  discountValue: string;
  maxDiscountCap: string | null;
  minPurchaseAmount: string | null;
  maxPurchaseAmount: string | null;
  /** The coupon's own currency: what a fixed value, the cap and the purchase bounds are in (F-116-h2). */
  currencyCode: string;
  totalUsageLimit: number | null;
  perUserUsageLimit: number;
  usedCount: number;
  reservedCount: number;
  /** Billing keeps this coupon's type, value and grant variant; a released redemption freezes it too (F-502-o). */
  frozen: boolean;
  expiresAt: string | null;
  validFrom: string | null;
  isActive: boolean;
  visibility: "public" | "targeted";
  activeWeekdays: number[];
  activeHourFrom: number | null;
  activeHourTo: number | null;
  firstPurchaseOnly: boolean;
  newUserWithinDays: number | null;
  periodUsageLimit: number | null;
  periodDays: number | null;
  allowedChannels: CouponChannel[];
  label: string | null;
  note: string | null;
  batchId: string | null;
  allowedUserIds: string[];
  gateways: CouponGatewayRef[];
  serviceScopes: Array<{ productId: string | null; variantId: string | null }>;
  /** A free-service coupon's catalog variant (F-502-l-a); null for every other type. */
  grantVariantId: string | null;
  status: CouponStatus;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CouponPage {
  items: AdminCoupon[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CouponListQuery {
  /** Platform owner only: a tenant id or `platform`. */
  tenantId?: string;
  status?: "active" | "inactive" | "expired" | "deleted";
  kind?: "discount" | "gift";
  q?: string;
  batchId?: string;
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

export interface UpdateCouponBody {
  code?: string;
  discountType?: "percentage" | "fixed_amount" | "wallet_credit" | "free_grant";
  discountValue?: string;
  maxDiscountCap?: string | null;
  minPurchaseAmount?: string | null;
  maxPurchaseAmount?: string | null;
  totalUsageLimit?: number | null;
  perUserUsageLimit?: number;
  expiresAt?: string | null;
  validFrom?: string | null;
  isActive?: boolean;
  visibility?: "public" | "targeted";
  activeWeekdays?: number[];
  activeHourFrom?: number | null;
  activeHourTo?: number | null;
  firstPurchaseOnly?: boolean;
  newUserWithinDays?: number | null;
  periodUsageLimit?: number | null;
  periodDays?: number | null;
  allowedChannels?: CouponChannel[];
  label?: string | null;
  note?: string | null;
  allowedUserIds?: string[];
  gateways?: CouponGatewayRef[];
  serviceScopes?: Array<{ productId?: string | null; variantId?: string | null }>;
  grantVariantId?: string | null;
}

export interface CreateCouponBody extends UpdateCouponBody {
  code: string;
  discountType: "percentage" | "fixed_amount" | "wallet_credit" | "free_grant";
  discountValue: string;
  /** Absent = the caller's tenant; `null` = platform; another id = the platform owner's alone. */
  tenantId?: string | null;
}

/** A gift-code batch as billing answers it (F-502-d). Counts exclude deleted codes. */
export interface GiftBatch {
  id: string;
  /** `null` = the platform's batch. */
  tenantId: string | null;
  label: string;
  note: string | null;
  createdAt: string;
  deactivatedAt: string | null;
  codes: number;
  used: number;
  reserved: number;
}

export interface GiftBatchPage {
  items: GiftBatch[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GenerateGiftBatchBody {
  /** Absent = the caller's tenant; `null` = platform; another id = the platform owner's alone. */
  tenantId?: string | null;
  label: string;
  note?: string | null;
  count: number;
  /** In the coupon owner's currency, a decimal string. */
  value: string;
  /** Set: every code gives a Grant of this variant, and `value` is "0" (F-502-l-a). */
  grantVariantId?: string | null;
  prefix?: string | null;
  expiresAt?: string | null;
}

export interface CouponRemoved {
  id: string;
  mode: "deleted" | "soft_deleted";
}

/** billing's `RedemptionStatus` — one declaration for the filter and the rows (C-09). */
export const REDEMPTION_STATUSES = ["pending", "confirmed", "expired", "cancelled"] as const;

export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

export interface UsageQuery {
  status?: RedemptionStatus;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  [key: string]: string | number | undefined;
}

export interface CouponUsageItem {
  id: string;
  couponId: string;
  code: string;
  userId: string;
  userName: string | null;
  username: string | null;
  paymentTransactionId: string | null;
  paymentStatus: string | null;
  discountAmount: string;
  /** What `discountAmount` is in: the order's when it was taken (F-116-h5). */
  currencyCode: string;
  status: RedemptionStatus;
  redeemedAt: string;
}

export interface CouponUsageReport {
  items: CouponUsageItem[];
  total: number;
  page: number;
  pageSize: number;
  totals: CouponUsageTotals;
}

/**
 * The report's totals over its range (F-116-h5). What confirmed uses gave is
 * summed per currency as written, then totalled in the owner's currency now;
 * `discountGiven` is `null` when an earlier currency has no conversion to it —
 * then only the per-currency sums say what was given.
 */
export interface CouponUsageTotals {
  redemptions: number;
  used: number;
  reserved: number;
  released: number;
  discountGiven: string | null;
  currencyCode: string;
  discountGivenByCurrency: Array<{ currencyCode: string; amount: string }>;
}

/** Coupon, discount and gift-batch calls — spread into `billingApi` (`lib/billing-api.ts`). */
export const couponCalls = {
  /** One page of coupons the caller may manage (F-502-f). Billing scopes the list; the filters only narrow it. */
  async adminCoupons(query: CouponListQuery = {}): Promise<CouponPage> {
    return call<CouponPage>(`/coupons${queryString(query)}`, { method: "GET" });
  },

  async createCoupon(body: CreateCouponBody): Promise<AdminCoupon> {
    return call<AdminCoupon>("/coupons", { method: "POST", body: JSON.stringify(body) });
  },

  /** Change only what `body` names; a set given replaces the whole set. */
  async updateCoupon(id: string, body: UpdateCouponBody): Promise<AdminCoupon> {
    return call<AdminCoupon>(`/coupons/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  /** Delete — or, when anything redeemed it, switch off and hide — one coupon (ADR-0048 decision 6). */
  async deleteCoupon(id: string): Promise<CouponRemoved> {
    return call<CouponRemoved>(`/coupons/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  /** Every discount rule with no code of the caller's tenant, newest first (F-114-h). */
  async discountRules(): Promise<DiscountRule[]> {
    return call<DiscountRule[]>("/discount-rules", { method: "GET" });
  },

  async createDiscountRule(body: CreateDiscountRuleBody): Promise<DiscountRule> {
    return call<DiscountRule>("/discount-rules", { method: "POST", body: JSON.stringify(body) });
  },

  /** Change only what `body` names; `userIds` replaces the list. No delete: a rule is switched off. */
  async updateDiscountRule(id: string, body: UpdateDiscountRuleBody): Promise<DiscountRule> {
    return call<DiscountRule>(`/discount-rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  async couponUsage(id: string, query: UsageQuery = {}): Promise<CouponUsageReport> {
    return call<CouponUsageReport>(`/coupons/${encodeURIComponent(id)}/usage${queryString(query)}`, { method: "GET" });
  },

  /** Gift-code batches the caller may manage, newest first (F-502-d). */
  async giftBatches(query: { tenantId?: string; page?: number; pageSize?: number } = {}): Promise<GiftBatchPage> {
    return call<GiftBatchPage>(`/coupons/batches${queryString(query)}`, { method: "GET" });
  },

  /** Generate N single-use wallet-credit codes in one batch. The codes are not in the answer: export them. */
  async generateGiftBatch(body: GenerateGiftBatchBody): Promise<GiftBatch> {
    return call<GiftBatch>("/coupons/batches", { method: "POST", body: JSON.stringify(body) });
  },

  /** The batch's codes as CSV text. Audited by billing: whoever holds the file holds the credit. */
  async exportGiftBatch(id: string): Promise<{ filename: string; csv: string }> {
    return call<{ filename: string; csv: string }>(`/coupons/batches/${encodeURIComponent(id)}/export`, { method: "GET" });
  },

  /** Switch every live code of the batch off. Harmless to repeat. */
  async deactivateGiftBatch(id: string): Promise<{ id: string; deactivated: number }> {
    return call<{ id: string; deactivated: number }>(`/coupons/batches/${encodeURIComponent(id)}/deactivate`, { method: "POST" });
  },

  async giftBatchUsage(id: string, query: UsageQuery = {}): Promise<CouponUsageReport> {
    return call<CouponUsageReport>(`/coupons/batches/${encodeURIComponent(id)}/usage${queryString(query)}`, { method: "GET" });
  },
};
