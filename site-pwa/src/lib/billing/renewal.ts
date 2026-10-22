// Renewing the caller's own Grant from the wallet (F-305, billing `contract.renewal.md`).
import { call } from "./client";
import type { ShopInvoice } from "./shop";

/**
 * One plan a Grant may renew to (F-305-j): what it adds and what it costs now,
 * before any discount. `bytes` is a decimal string (C-02); `"0"` adds no
 * traffic — the Grant's is unlimited or bought in blocks — and `days` 0 adds
 * no time to a permanent one.
 */
export interface RenewalPlan {
  variantId: string;
  sku: string;
  nameKey: string;
  /** The Grant's own plan; false = a switch to another of its product. */
  current: boolean;
  /** Before any discount: the invoice prices the codeless rule and the codes. */
  price: string;
  currencyCode: string;
  campaignEndsAt: string | null;
  bytes: string;
  days: number;
}

/** The product's rate for GiB and days typed, with **this Grant's** bounds (F-305-e); a most of 0 = that part is not sold to it. */
export interface RenewalCustom {
  rateId: string;
  pricePerGib: string;
  pricePerDay: string;
  currencyCode: string;
  minGib: number;
  maxGib: number;
  minDays: number;
  maxDays: number;
}

/** `GET /gift/grants/:id/renewal-plans`: exactly what the invoice would take, the Grant's own plan first. */
export interface RenewalPlans {
  grantId: string;
  /** False = the Grant's own plan is no longer sold (panel-web `contract.renewal.md` rule 3). */
  ownPlanRenewable: boolean;
  plans: RenewalPlan[];
  /** `null` = custom renewal is off for this Grant. */
  custom: RenewalCustom | null;
}

/** What a renewal invoice is for: a plan, or GiB and days typed (F-305-e). */
export type RenewalChoice = { variantId: string } | { gib: number; days: number };

/** The renewal calls — spread into `billingApi` (`lib/billing-api.ts`). */
export const renewalCalls = {
  /** The plans the sheet lists (F-305-j). Another user's Grant is a 404; a closed one a 409. */
  async renewalPlans(grantId: string): Promise<RenewalPlans> {
    return call<RenewalPlans>(`/gift/grants/${encodeURIComponent(grantId)}/renewal-plans`, { method: "GET" });
  },

  /**
   * A renewal invoice for the caller's own Grant (F-305-c/e) — the purchase's
   * route with `grantId`. **No price in the body**: billing prices the plan or
   * the GiB and days, then the codeless rule and the codes.
   */
  async createRenewalInvoice(grantId: string, choice: RenewalChoice, couponCodes: string[]): Promise<ShopInvoice> {
    return call<ShopInvoice>("/invoices", { method: "POST", body: JSON.stringify({ grantId, ...choice, couponCodes }) });
  },
};
