/**
 * Renewing one's own Grant from the wallet, as the chat reads it (F-305-i):
 * billing's renewal routes (`billing/contract.renewal.md`) and the invoice
 * routes a renewal shares with a purchase (`billing/contract.purchase.md`),
 * narrowed to what a chat tells. Money and bytes are decimal strings (C-02).
 */

/**
 * One plan the Grant may renew to — the fields the chat reads. `bytes` `"0"`
 * adds no traffic (unlimited, or bought in blocks); `days` 0 adds no time.
 * `price` is before any discount; `current` is the Grant's own plan, first.
 */
export interface RenewalPlan {
  variantId: string;
  current: boolean;
  nameKey: string;
  sku: string;
  bytes: string;
  days: number;
  price: string;
  currencyCode: string;
}

/** The parts a Grant may buy typed, with **its** bounds; a most of 0 = not sold to it. Prices are billing's quote, never read here. */
export interface RenewalCustom {
  minGib: number;
  maxGib: number;
  minDays: number;
  maxDays: number;
}

/** `GET /api/billing/gift/grants/:id/renewal-plans` (F-305-j); `custom` null = no GiB or days typed, `ownPlanRenewable` false = its plan is no longer sold. */
export interface RenewalPlans {
  grantId: string;
  plans: RenewalPlan[];
  custom: RenewalCustom | null;
  ownPlanRenewable: boolean;
}

/** What one renewal invoice is for: a plan, or GiB and days typed (F-305-e). */
export type RenewalChoice = { variantId: string } | { gib: number; days: number };

/** A renewal invoice, as `POST /api/billing/invoices` answers it. */
export interface RenewalInvoice {
  id: string;
  nameKey: string;
  sku: string;
  amount: string;
  discount: string;
  total: string;
  currencyCode: string;
  rejected?: { code: string; reason: string; message: string }[];
  renewal: { grantId: string; bytes: string; days: number } | null;
  expiresAt: string;
}

/** `POST /api/billing/invoices/:id/pay`: the renewed Grant is the one named. */
export interface InvoicePaid {
  id: string;
  total: string;
  balanceAfter: string;
  currencyCode: string;
  grants: { id: string; status: string }[];
}
