// The wallet: balance, its two lists, and a reseller's own wallet (billing/contract.history.md).
import { type Paged, call } from "./client";
import type { DepositGateway, DepositStarted } from "./deposit";

/**
 * What `GET /wallet/history` answers, narrowed to the part the top bar reads.
 * The full page is {@link WalletHistoryPage} (`billing/contract.history.md`).
 */
export interface WalletBalance {
  /**
   * `wallet.cachedBalance` as a decimal string, in `currencyCode` (two
   * places). Written only inside the transaction that
   * appends the proving ledger row, so it is a balance and not a running total —
   * nothing on this side adds to it or recomputes it.
   */
  balance: string;
  /**
   * The part of `balance` promised to the user's services — a VPN reserve, a
   * meter's hold (F-118-a) — and `balance − held`, what a purchase can spend.
   * Both billing's, from the same row as `balance` (F-118-j); never subtracted here.
   */
  held: string;
  available: string;
  /** The wallet's currency; a user with no wallet yet, the one their first credit will take (F-116-h2). */
  currencyCode: string;
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
  /** In `currencyCode`, a decimal string. Unsigned — `direction` carries the sign. */
  amount: string;
  direction: "credit" | "debit";
  /** `WalletReasonType`: what caused the movement. There is no free-text title. */
  reasonType: string;
  /** The row that caused it — a payment, a transfer, a commission. */
  referenceId: string | null;
  /** The balance the ledger wrote after this row. Never recomputed here or there. */
  balanceAfter: string;
  /** The row's own currency — a USD row written before a switch to IRR stays dollars (F-116-h3). */
  currencyCode: string;
  /** A postpaid capture's meter and the units it paid for, a decimal string — bytes on `vpn.traffic` (F-118-am). */
  meterKey: string | null;
  usageQuantity: string | null;
  /** `final_usage_rounded_up`: a closed service's last usage, priced up to a cent (F-118-al). */
  note: "final_usage_rounded_up" | null;
  createdAt: string;
}

export type WalletHistoryPage = Paged<WalletLedgerRow> & WalletBalance;

/** A top-up attempt. Only a `success` one has a ledger row beside it (F-092-j writes it). */
export interface WalletPaymentRow {
  id: string;
  status: "pending" | "success" | "failed" | "expired";
  amountRequested: string;
  fee: string;
  /** The tax on top, and the rate it was charged at — frozen at intent (ADR-0076). `0.00` and `null` when untaxed. */
  tax: string;
  taxRatePercent: string | null;
  discount: string;
  amountCredited: string;
  /** The payment's own currency: what every amount above is in (F-116-h3). */
  currencyCode: string;
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
  /**
   * `pending` with its retry clock running (F-092-x): the gateway met the
   * verify with silence and billing is asking again. The money may have moved.
   */
  verifying: boolean;
}

export type WalletPaymentsPage = Paged<WalletPaymentRow>;

/**
 * A movement of a reseller's billing wallet with the platform (F-019-d) — not
 * a user's wallet. `reasonType` is the tenant ledger's own set
 * (`tenant/contract.billing.md`); a value added later renders as itself.
 */
export interface TenantWalletRow {
  id: string;
  direction: "credit" | "debit";
  reasonType: string;
  amount: string;
  balanceAfter: string;
  /** The row's own currency, never the reseller's now (F-116-h3). */
  currencyCode: string;
  createdAt: string;
}

/** `POST /tenant-wallet/topup`'s body. The route is `.strict()`: no `source`, no coupons (F-019-e). */
export interface TenantTopupBody {
  gatewayId: string;
  amount: string;
}

/** `GET /tenant-wallet`: one page, and the wallet's own balance — never a sum of the page. */
export type TenantWalletPage = Paged<TenantWalletRow> & { balance: string; currencyCode: string };

/** Prisma's `TenantLedgerDirection`. */
export type TenantLedgerDirection = "credit" | "debit";

export interface TenantWalletAdjustBody {
  direction: TenantLedgerDirection;
  /** A decimal string, positive, at most two places (C-02). */
  amount: string;
  requestId: string;
  note?: string;
}

/**
 * A movement of one reseller's wallet as the **platform owner** reads it
 * (F-019-j). The reseller's own read carries no `referenceId`; this one does —
 * an adjustment's reference is the owner's own request id, a charge's the
 * period it paid for (`tenant/contract.billing.md`).
 */
export interface TenantWalletAdminRow extends TenantWalletRow {
  referenceId: string | null;
}

/** `GET /tenant-wallets/:tenantId/transactions`: one page, and the wallet's own balance. */
export type TenantWalletAdminPage = Paged<TenantWalletAdminRow> & { tenantId: string; balance: string; currencyCode: string };

export interface TenantWalletAdjusted {
  transactionId: string;
  tenantId: string;
  direction: TenantLedgerDirection;
  amount: string;
  balanceAfter: string;
  currencyCode: string;
  createdAt: string;
}

/** The wallet's calls — spread into `billingApi` (`lib/billing-api.ts`). */
export const walletCalls = {
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

  /** A reseller's billing wallet (F-019-d). Its owner or `tenant_billing.topup`, else a translated 403. */
  async tenantWallet(page: number, pageSize: number): Promise<TenantWalletPage> {
    return call<TenantWalletPage>(`/tenant-wallet?page=${page}&pageSize=${pageSize}`, { method: "GET" });
  },

  /**
   * The platform owner's gateways a reseller tops up its billing wallet through
   * (F-019-e, ADR-0056) — the deposit list's shape, `platform` rows only. The
   * same door as `tenantWallet`: a refusal is a translated 403.
   */
  async tenantTopupGateways(): Promise<DepositGateway[]> {
    return call<DepositGateway[]>("/tenant-wallet/topup/gateways", { method: "GET" });
  },

  /**
   * Start a billing top-up (F-019-e). The platform is the merchant, so the
   * answer's `redirectUrl` is a bank that returns to the platform's panel host.
   * No quote route: the breakdown arrives with the start.
   */
  async tenantTopup(body: TenantTopupBody): Promise<DepositStarted> {
    return call<DepositStarted>("/tenant-wallet/topup", { method: "POST", body: JSON.stringify(body) });
  },

  /**
   * One reseller's billing ledger, read by the platform owner (F-019-j).
   * Permission `tenant_billing.read`, then the service's owner check; a
   * reseller that was never credited answers `"0.00"` with no rows, so there
   * is no first-credit special case here. `balance` is the wallet's own
   * figure, never a sum of the page.
   */
  async tenantWalletTransactions(tenantId: string, page: number, pageSize: number): Promise<TenantWalletAdminPage> {
    return call<TenantWalletAdminPage>(
      `/tenant-wallets/${encodeURIComponent(tenantId)}/transactions?page=${page}&pageSize=${pageSize}`,
      { method: "GET" },
    );
  },

  /**
   * The platform owner credits or debits a reseller's billing wallet by hand
   * (F-019-a, `tenant/contract.billing.md` "Manual adjustment"). `requestId` is
   * the entry's reference: the same one sent again is `duplicate_request`, so a
   * caller mints it once per form, not once per click.
   */
  async adjustTenantWallet(tenantId: string, body: TenantWalletAdjustBody): Promise<TenantWalletAdjusted> {
    return call<TenantWalletAdjusted>(`/tenant-wallets/${encodeURIComponent(tenantId)}/adjustments`, {
      method: "POST",
      body: JSON.stringify(body),
    });
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
   * One of the caller's own top-up attempts (F-093-l) — what `/payment/pending`
   * polls until the payment settles. Another user's id is a 404.
   */
  async walletPayment(id: string): Promise<WalletPaymentRow> {
    return call<WalletPaymentRow>(`/wallet/payments/${encodeURIComponent(id)}`, { method: "GET" });
  },
};
