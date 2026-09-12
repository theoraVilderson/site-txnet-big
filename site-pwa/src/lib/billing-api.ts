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
