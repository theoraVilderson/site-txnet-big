// The shop: offers, an invoice and its payment (F-111-e).
import { call } from "./client";

/**
 * One variant the shop sells, as `GET /offers` answers it (F-111-e,
 * `billing/contract.purchase.md`): listed, priced now, and deliverable — billing
 * leaves out what an invoice would refuse. `price` is the catalog's, in
 * `currencyCode`; it is shown, never sent back. Names are keys, resolved through the
 * published `catalog` namespace as My services does.
 */
export interface ShopOffer {
  variantId: string;
  sku: string;
  /** The variant's own name, else its product's. */
  nameKey: string;
  productId: string;
  /** The product's own name — what a card is headed with (F-114-d). */
  productNameKey: string;
  descriptionKey: string | null;
  categoryKey: string;
  /** Every live category the product is filed in, in the product's order (F-114-d). */
  categories: Array<{ key: string; nameKey: string }>;
  fulfilmentKind: string;
  /** `null` = permanent. */
  durationDays: number | null;
  billingMode: "prepaid" | "metered";
  quotas: unknown;
  price: string;
  /** What `price` is in: the price row's own (F-116-h3). */
  currencyCode: string;
  /** The card in effect for each meter (F-118-ae): what a sale now would lock. */
  rateCards: ShopRateCard[];
}

/** A rate card as an offer names it; quantities and money as strings. */
export interface ShopRateCard {
  meterKey: string;
  unitSize: string;
  unitPrice: string;
  currencyCode: string;
  mode: "prepaid" | "postpaid";
  includedQuantity: string;
  afterIncluded: "stop" | "metered";
}

/** The statuses an invoice can be in, as `billing.prisma` declares `InvoiceStatus` (C-09). */
export const INVOICE_STATUSES = ["pending", "paid", "expired", "cancelled", "refunded"] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * An invoice, as `POST /invoices` makes it and `GET /invoices/:id` reads it back
 * (F-111-a, F-111-e). Money is a decimal string in `currencyCode` (C-02).
 * `rejected` is only in the creation's answer: the codes that took nothing, with
 * billing's sentence.
 */
export interface ShopInvoice {
  id: string;
  variantId: string;
  sku: string;
  nameKey: string;
  status: InvoiceStatus;
  amount: string;
  discount: string;
  total: string;
  /** What every amount here is in (F-116-h3, ADR-0098): the answer's own, never assumed. */
  currencyCode: string;
  applied: Array<{ code: string; discount: string }>;
  rejected?: Array<{ code: string; reason: string; message: string }>;
  expiresAt: string;
}

/** `POST /invoices/:id/pay`'s answer. No token: the link is My services' (F-114-e-c). */
export interface InvoicePaid {
  id: string;
  status: "paid";
  total: string;
  balanceAfter: string;
  /** What every amount here is in (F-116-h3, ADR-0098): the answer's own, never assumed. */
  currencyCode: string;
  walletTransactionId: string | null;
  grants: Array<{ id: string; status: string }>;
}

/** The shop's calls — spread into `billingApi` (`lib/billing-api.ts`). */
export const shopCalls = {
  /**
   * One page of the caller's own Grants (F-502-s → F-502-r), newest period
   * first.
   *
   * **Whose Grants is not a parameter.** The user is the gate's `X-User-Id`,
   * the same shape as the financial page's lists, so there is nothing here to
   * pass and nothing to get wrong. A user with no Grants is an empty page, not
   * a 404. `scope` leaves ended Grants out (F-502-u); `q` keeps only the
   * Grants holding a live config named like it (F-307-m).
   */
  async shopOffers(): Promise<ShopOffer[]> {
    return call<ShopOffer[]>("/offers", { method: "GET" });
  },

  /**
   * An invoice for one variant (F-111-a). **The body has no price**: billing
   * prices it from the catalog, so a figure sent here would be ignored anyway.
   * The codes are held under the invoice for its 30 minutes.
   */
  async createInvoice(variantId: string, couponCodes: string[]): Promise<ShopInvoice> {
    return call<ShopInvoice>("/invoices", { method: "POST", body: JSON.stringify({ variantId, couponCodes }) });
  },

  /** The caller's own invoice (F-111-e) — the one a top-up comes back to. Another user's is a 404. */
  async invoice(id: string): Promise<ShopInvoice> {
    return call<ShopInvoice>(`/invoices/${encodeURIComponent(id)}`, { method: "GET" });
  },

  /**
   * Pay it from the wallet (F-111-b), exactly once. A shortfall is a 409
   * `insufficient_balance` whose `facts.missing` is the top-up to offer
   * (F-111-c) — `shop/_lib/shop.ts` reads it.
   */
  async payInvoice(id: string): Promise<InvoicePaid> {
    return call<InvoicePaid>(`/invoices/${encodeURIComponent(id)}/pay`, { method: "POST" });
  },

  /**
   * Gives up the caller's own pending invoice (F-114-d) — the shop replaces it
   * when the codes change, and this hands its coupon holds back at once rather
   * than after its 30 minutes. One already cancelled or expired answers as it is.
   */
  async cancelInvoice(id: string): Promise<{ id: string; status: InvoiceStatus }> {
    return call<{ id: string; status: InvoiceStatus }>(`/invoices/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  },
};
