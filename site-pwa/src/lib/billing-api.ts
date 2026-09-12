// Browser calls api.${DOMAIN_NAME}/api/billing directly, the same way it calls
// auth-service — cross-origin, with the access token as a Bearer header, and
// `forward-auth` turning that into the `X-User-Id` every billing route reads.
// There is no Next.js proxy hop: the panel removed its one on 2026-09-05 and
// lists it under Deprecations (`panel-web/contract.md`), because
// server-to-server was the source of an intermittent 502. `billing-service`'s
// `main.ts` had assumed the opposite and shipped with CORS off; F-093-c is the
// first call from this app and the decision was settled with the user then.
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const API_URL = `${process.env.NEXT_PUBLIC_API_ORIGIN}/api/billing`;

/**
 * The token is `auth-api`'s, read per call. Billing mints no credential of its
 * own — every route behind the gate is authorised by the same session — so this
 * deliberately has no token state to get out of step with `auth-api`'s.
 */
const call = createApiClient({
  baseUrl: API_URL,
  service: "billing-service",
  credential: () => authApi.getAccessToken(),
});

/**
 * What `GET /wallet/history` answers, narrowed to the part the top bar reads.
 * The full page is {@link WalletHistoryPage} (`billing/contract.history.md`).
 */
export interface WalletBalance {
  /**
   * `wallet.cachedBalance` as a decimal string, in the **base** currency
   * (ADR-0019: USD, two places). Written only inside the transaction that
   * appends the proving ledger row, so it is a balance and not a running total —
   * nothing on this side adds to it or recomputes it.
   */
  balance: string;
}

/** One page of either list. The two lists differ only in their row. */
export interface Paged<Row> {
  total: number;
  page: number;
  pageSize: number;
  rows: Row[];
}

/**
 * A movement of money in the wallet ledger.
 *
 * It has no `status`, and that is the point: a row exists only because money
 * moved. An attempt that failed is a {@link WalletPaymentRow} and lives in the
 * other list — in legacy the two shared one collection, which is how a failed
 * top-up got counted as a movement (`billing/contract.history.md`).
 */
export interface WalletLedgerRow {
  id: string;
  /** Base currency, a decimal string. Unsigned — `direction` carries the sign. */
  amount: string;
  direction: "credit" | "debit";
  /** `WalletReasonType`: what caused the movement. There is no free-text title. */
  reasonType: string;
  /** The row that caused it — a payment, a transfer, a commission. */
  referenceId: string | null;
  /** The balance the ledger wrote after this row. Never recomputed here or there. */
  balanceAfter: string;
  createdAt: string;
}

export type WalletHistoryPage = Paged<WalletLedgerRow> & WalletBalance;

/** A top-up attempt. Only a `success` one has a ledger row beside it (F-092-j writes it). */
export interface WalletPaymentRow {
  id: string;
  status: "pending" | "success" | "failed" | "expired";
  amountRequested: string;
  fee: string;
  discount: string;
  amountCredited: string;
  /** What the gateway was asked for, and the rate that produced it — frozen at intent (ADR-0019). */
  charge: { amountMinor: string; rate: string | null };
  trackingCode: string | null;
  /** The receipt number of a paid payment — what a user quotes to support. */
  referenceId: string | null;
  cardPanMasked: string | null;
  failureCode: string | null;
  /** Exactly one of the two gateway columns is set, and this says which (ADR-0006). */
  gateway: { source: "platform" | "tenant"; id: string; displayName: string } | null;
  createdAt: string;
  expiresAt: string | null;
}

export type WalletPaymentsPage = Paged<WalletPaymentRow>;

/**
 * What `POST /gift/redeem` answers (`billing/contract.gift.md`).
 *
 * `balance` is the wallet's balance **after** the credit, written by the same
 * transaction that appended the ledger row — so it is a balance billing
 * answered, not one this app worked out. Nothing on this side adds `credited`
 * to a figure it is holding: that is exactly the legacy bug F-093-g does not
 * port, where a *refused* code still added an `undefined` amount to the store
 * and showed success over a balance of `NaN`.
 */
export interface GiftRedemption {
  /** The code as stored, which is the trimmed, upper-cased form of what was typed. */
  code: string;
  /** Base currency, a decimal string. Always `> 0` — a zero-value coupon raises server-side. */
  credited: string;
  /** The balance after the credit. Base currency, a decimal string. */
  balance: string;
}

/**
 * One gateway the user may pay through, as `GET /deposit/gateways` answers it
 * (`billing/contract.deposit.md`). Only gateways that are usable are listed —
 * active, verified, with a driver and a merchant id in the vault — so this app
 * never has to explain why an offered gateway refused the payment.
 */
export interface DepositGateway {
  id: string;
  /**
   * Which table the id is from. It travels back on every quote and start,
   * because a platform gateway and a tenant one can share an id and only the
   * pair identifies a row (ADR-0006, D-25).
   */
  source: "platform" | "tenant";
  displayName: string;
  /** The driver behind it (`zarinpal`, …). Shown as the logo, never branched on. */
  providerName: string;
  category: string;
  /** Base currency, decimal strings. The gateway's own range — the amount box's bounds. */
  minAmount: string;
  maxAmount: string;
}

/** A coupon that priced into the quote. `discount` is what this code took, after the ones before it. */
export interface QuotedCoupon {
  code: string;
  discount: string;
}

/**
 * A code that did not price in. **Not an error**: the quote goes on without it,
 * so a typo cannot hide the rest of the breakdown. `message` is a sentence
 * billing has already translated, one per `reason` — this app shows it as it
 * arrived and branches on no reason code (`contract.errors.md`).
 */
export interface RejectedCoupon {
  code: string;
  reason: string;
  message: string;
}

/**
 * The whole bill for one set of inputs (`POST /deposit/quote`).
 *
 * **Every number here is `priceAtGateway`'s and the panel derives none of
 * them** — not the total, not the discount, not the balance afterwards
 * (F-0612). Legacy computed the same bill in the browser and again on the
 * server, and the two drifted.
 */
export interface DepositQuote {
  gatewayId: string;
  source: "platform" | "tenant";
  /** What the user asked to top up with, echoed back. */
  amount: string;
  coupons: QuotedCoupon[];
  rejected: RejectedCoupon[];
  discount: string;
  /**
   * What the payable was raised by to clear the gateway's minimum, and never a
   * charge: it is credited to the wallet too, so `credited` already carries it.
   */
  gap: string;
  fee: string;
  /** What the card is charged, in base currency. `0.00` on the free path. */
  payable: string;
  /** What lands in the wallet — the amount plus the adjustment gap. */
  credited: string;
  /** Fully discounted: nothing reaches a gateway and the credit is immediate. */
  free: boolean;
  /**
   * What the gateway itself will be asked for, in its own currency and minor
   * units, at the rate that priced this quote (ADR-0019). `null` on the free
   * path. Shown beside the payable so a rial gateway's figure is not a surprise
   * on the bank's page.
   */
  charge: { currency: string; decimals: number; amountMinor: string } | null;
}

/** The body all three of the paying routes take — the same one, so they cannot drift. */
export interface DepositQuoteBody {
  gatewayId: string;
  source: "platform" | "tenant";
  amount: string;
  couponCodes: string[];
}

/**
 * What `POST /deposit/start` answers. The payment row exists and its coupons
 * are held by the time this lands (`billing/contract.deposit.md`).
 */
export interface DepositStarted {
  paymentId: string;
  free: boolean;
  /** Where to send the browser. `null` on the free path, where nothing was minted. */
  redirectUrl: string | null;
  amount: string;
  discount: string;
  fee: string;
  payable: string;
  credited: string;
  /** The wallet balance after a free top-up credited it; `null` when nothing was credited. */
  balance: string | null;
}

export const billingApi = {
  /**
   * The wallet's balance, and nothing else.
   *
   * It reads `wallet/history` with the smallest page rather than a route of its
   * own: `{balance}` is already the first field that route answers, and a
   * `GET /wallet/balance` would be a second endpoint returning a value the
   * first one has — a field added because a caller was convenient, which is
   * what §11 forbids. When F-093-d asks for the ledger it widens this method's
   * query; until then one row is the cheapest honest ask.
   *
   * A user with no wallet yet is `"0.00"` and not a 404, so there is no
   * first-top-up special case to write here.
   */
  async walletBalance(): Promise<WalletBalance> {
    return call<WalletBalance>("/wallet/history?page=1&pageSize=1", { method: "GET" });
  },

  /**
   * A page of the wallet ledger (F-093-d). `query` is already built and
   * encoded — `financial/_lib/filters.ts` owns that, including turning the
   * day the user picked on a calendar into the instants this route takes.
   *
   * The page's `balance` rides along because it is this route's first field;
   * it is the same figure the top bar shows, read the same way.
   */
  async walletHistory(query: string): Promise<WalletHistoryPage> {
    return call<WalletHistoryPage>(`/wallet/history?${query}`, { method: "GET" });
  },

  /**
   * A page of top-up attempts (F-093-d) — the list the ledger deliberately
   * does not carry. A separate call to a separate route, so a status filter
   * meant for attempts can never narrow the ledger.
   */
  async walletPayments(query: string): Promise<WalletPaymentsPage> {
    return call<WalletPaymentsPage>(`/wallet/payments?${query}`, { method: "GET" });
  },

  /**
   * The gateways this user may pay through (F-093-e). Unusable ones are not in
   * the list at all, so the selector needs no "why is this greyed out" state.
   */
  async depositGateways(): Promise<DepositGateway[]> {
    return call<DepositGateway[]>("/deposit/gateways", { method: "GET" });
  },

  /**
   * Price one set of inputs. It reserves and writes nothing, so it is safe to
   * call whenever the amount, the gateway or the codes change — which is what
   * the page does, debounced.
   */
  async depositQuote(body: DepositQuoteBody): Promise<DepositQuote> {
    return call<DepositQuote>("/deposit/quote", { method: "POST", body: JSON.stringify(body) });
  },

  /**
   * Start the payment the quote described, with **the quote's own body**: the
   * server re-prices from the same inputs by the same code, and a client never
   * sends back a number it was shown (F-0612).
   *
   * A coupon that can no longer be held is a 409 carrying a translated
   * sentence, and nothing was written — the page re-quotes and the breakdown
   * comes back without it.
   */
  async depositStart(body: DepositQuoteBody): Promise<DepositStarted> {
    return call<DepositStarted>("/deposit/start", { method: "POST", body: JSON.stringify(body) });
  },

  /**
   * Redeem a gift code (F-093-g), crediting the wallet in one transaction.
   *
   * Every refusal is a **409** carrying a sentence billing has already
   * translated — "this is a discount code, enter it when you top up", and four
   * others — so it arrives as an `ApiError` whose `message` goes straight on
   * screen (`contract.errors.md`). There is no reason code to branch on here,
   * and deliberately so: each message already names the box the code belongs
   * in, which is the job a `reason` would otherwise be doing in this client.
   *
   * The route is rate-limited far below the read routes (10 per 900s), because
   * it is the only thing that says whether a given code exists. A caller that
   * retried on the user's behalf would spend that budget for them.
   */
  async redeemGift(code: string): Promise<GiftRedemption> {
    return call<GiftRedemption>("/gift/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  },
};
