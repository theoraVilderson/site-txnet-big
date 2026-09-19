// Browser calls `/api/billing` on the page's own domain, the same way it calls
// auth-service (ADR-0060) — with the access token as a Bearer header, and
// `forward-auth` turning that into the `X-User-Id` every billing route reads.
// There is no Next.js proxy hop: the panel removed its one on 2026-09-05 and
// lists it under Deprecations (`panel-web/contract.md`), because
// server-to-server was the source of an intermittent 502. Traefik, not this
// app, routes the path to the service.
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const API_URL = `${API_BASE}/billing`;

/**
 * The token is `auth-api`'s, read per call. Billing mints no credential of its
 * own — every route behind the gate is authorised by the same session — so this
 * deliberately has no token state to get out of step with `auth-api`'s.
 */
const call = createApiClient({
  baseUrl: API_URL,
  service: "billing-service",
  credential: () => authApi.getAccessToken(),
  // Billing is behind the gate, so it is the client most likely to be refused
  // with `permissionsChanged` (ADR-0043). The refresh is auth-api's, shared.
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  // A page that fetches on mount (the top-up page's gateways) waits for the
  // page-load session instead of racing it with no token.
  credentialSettled: () => authApi.credentialSettled(),
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
  /**
   * `pending` with its retry clock running (F-092-x): the gateway met the
   * verify with silence and billing is asking again. The money may have moved.
   */
  verifying: boolean;
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
export interface GiftCredit {
  /** Absent on an answer from before F-502-l-b; a credit either way. */
  kind?: "wallet_credit";
  /** The code as stored, which is the trimmed, upper-cased form of what was typed. */
  code: string;
  /** Base currency, a decimal string. Always `> 0` — a zero-value coupon raises server-side. */
  credited: string;
  /** The balance after the credit. Base currency, a decimal string. */
  balance: string;
}

/** A free-service code (F-502-l-b, D-35): a Grant, and its subscription key shown this once. */
export interface GiftGrant {
  kind: "free_grant";
  code: string;
  grant: { id: string; variantId: string | null; startsAt: string; endsAt: string | null; featureKeys: string[] };
  /** Billing keeps only its hash: this answer is the only time it exists in the clear. */
  subscriptionKey: string;
}

export type GiftRedemption = GiftCredit | GiftGrant;

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
  /** Base currency, decimal strings. The gateway's own range — the amount box's bounds; `null` is no limit on that side. */
  minAmount: string | null;
  maxAmount: string | null;
  /** Off or not yet verified: shown only to someone who may manage gateways, so they can test it. */
  testing: boolean;
  /**
   * Quick amounts (F-092-v): the gateway's own list, else the tenant's default,
   * already inside the range. Empty means none was configured.
   */
  presets: string[];
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
  /**
   * An in-chat gateway started inside a Mini App (F-104-q): the link the
   * messenger's `openInvoice` takes. `null` everywhere else — a browser is
   * never offered such a gateway.
   */
  invoiceLink: string | null;
  amount: string;
  discount: string;
  fee: string;
  payable: string;
  credited: string;
  /** The wallet balance after a free top-up credited it; `null` when nothing was credited. */
  balance: string | null;
}

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
  createdAt: string;
}

/** `POST /tenant-wallet/topup`'s body. The route is `.strict()`: no `source`, no coupons (F-019-e). */
export interface TenantTopupBody {
  gatewayId: string;
  amount: string;
}

/** `GET /tenant-wallet`: one page, and the wallet's own balance — never a sum of the page. */
export type TenantWalletPage = Paged<TenantWalletRow> & { balance: string };

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
export type TenantWalletAdminPage = Paged<TenantWalletAdminRow> & { tenantId: string; balance: string };

export interface TenantWalletAdjusted {
  transactionId: string;
  tenantId: string;
  direction: TenantLedgerDirection;
  amount: string;
  balanceAfter: string;
  createdAt: string;
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

  /**
   * Every gateway the caller may manage (F-102-d): the platform owner all of
   * them, a tenant its own. Billing decides which; this sends no tenant.
   */
  /** Payments waiting on a person, in the caller's scope (F-093-n → F-092-z). */
  async manualPayments(): Promise<VerifyingPayment[]> {
    return call<VerifyingPayment[]>("/payments/manual", { method: "GET" });
  },

  /** Ask the gateway now; whatever it settles is settled by billing's ordinary path. */
  async manualInquire(id: string): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/inquire`, { method: "POST" });
  },

  /** Billing asks the gateway once more first; it credits by hand only if that stays unsettled. */
  /** Attach an authority whose write was lost, then ask the gateway (F-092-af). */
  async manualAttachAuthority(id: string, authority: string): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/authority`, {
      method: "POST",
      body: JSON.stringify({ authority }),
    });
  },

  async manualConfirm(id: string, body: { referenceId: string; reason: string }): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /** End a payment nobody paid (F-092-ak). Billing asks the gateway first and never rejects money it can see. */
  async manualReject(id: string, reason: string): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  },

  async adminGateways(): Promise<AdminGateway[]> {
    return call<AdminGateway[]>("/gateways", { method: "GET" });
  },

  /** Create a gateway. A secret in the body is relayed to the vault and never answered. */
  async createGateway(body: CreateGatewayBody): Promise<AdminGateway> {
    return call<AdminGateway>("/gateways", { method: "POST", body: JSON.stringify(body) });
  },

  /** Change only what `body` names. An absent secret keeps the stored one. */
  async updateGateway(source: GatewaySource, id: string, body: UpdateGatewayBody): Promise<AdminGateway> {
    return call<AdminGateway>(`/gateways/${source}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  /** The caller tenant's default quick amounts on the top-up page (F-092-v). */
  async gatewayPresets(): Promise<{ presets: string[] }> {
    return call<{ presets: string[] }>("/gateways/presets", { method: "GET" });
  },

  /** Replace them; billing answers the list as stored (sorted, two decimals). */
  async setGatewayPresets(presets: string[]): Promise<{ presets: string[] }> {
    return call<{ presets: string[] }>("/gateways/presets", { method: "PUT", body: JSON.stringify({ presets }) });
  },

  /** Delete — or, when a payment or link points at it, deactivate — one gateway (ADR-0041 §6). */
  async deleteGateway(source: GatewaySource, id: string): Promise<GatewayRemoved> {
    return call<GatewayRemoved>(`/gateways/${source}/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

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

  /** Every link (grant) the platform has made. Platform owner only; anyone else is refused 403. */
  async gatewayGrants(): Promise<GatewayGrant[]> {
    return call<GatewayGrant[]>("/settlement/grants", { method: "GET" });
  },

  /** Link a gateway to a tenant that does not own it (ADR-0041). */
  async createGatewayGrant(body: CreateGatewayGrantBody): Promise<{ id: string }> {
    return call<{ id: string }>("/settlement/grants", { method: "POST", body: JSON.stringify(body) });
  },

  /** Unlink: the grant is withdrawn, never deleted. */
  async withdrawGatewayGrant(id: string): Promise<{ id: string }> {
    return call<{ id: string }>(`/settlement/grants/${encodeURIComponent(id)}/withdraw`, { method: "POST" });
  },
};

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
  | "tenants_are_platform_coupons"
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
  totalUsageLimit: number | null;
  perUserUsageLimit: number;
  usedCount: number;
  reservedCount: number;
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
  tenantIds: string[];
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
  tenantIds?: string[];
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
  /** Base currency, a decimal string. */
  value: string;
  /** Set: every code gives a Grant of this variant, and `value` is "0" (F-502-l-a). */
  grantVariantId?: string | null;
  prefix?: string | null;
  expiresAt?: string | null;
  tenantIds?: string[];
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
  status: RedemptionStatus;
  redeemedAt: string;
}

export interface CouponUsageReport {
  items: CouponUsageItem[];
  total: number;
  page: number;
  pageSize: number;
  totals: { redemptions: number; used: number; reserved: number; released: number; discountGiven: string };
}

/** Which table a gateway row is in — the pair `source` + `id` names a row (D-25). */
export type GatewaySource = "platform" | "tenant";

/** An open payment a person may act on (F-092-z; every `pending` or `expired` one since F-092-af). */
export interface VerifyingPayment {
  id: string;
  status: "pending" | "expired";
  tenantId: string | null;
  userId: string;
  source: GatewaySource;
  gatewayId: string | null;
  gatewayName: string | null;
  providerName: string | null;
  amountRequested: string;
  amountCredited: string;
  chargedAmountMinor: string;
  authority: string | null;
  createdAt: string;
  verifyAttempts: number;
  nextVerifyAt: string | null;
  /** Still verifying a day after it was made (F-092-y). */
  flaggedAt: string | null;
}

/** What asking the gateway, or confirming by hand, came to (billing `ManualOutcome`). */
export type ManualOutcome =
  | "credited"
  | "already_settled"
  | "refused"
  | "mismatch"
  | "unsettled"
  | "confirmed_manually"
  /** A person closed it; the gateway saw no money (F-092-ak). */
  | "rejected_manually"
  /** Not rejected: the payer is still at the bank (F-092-ak). */
  | "still_in_bank";

export interface ManualAnswer {
  paymentId: string;
  outcome: ManualOutcome;
  gatewayStatus: string | null;
  referenceId: string | null;
}

/** The secrets a gateway can carry (F-102-a, F-104-c) — billing's `GATEWAY_SECRET_NAMES`. */
export type GatewaySecretName = "merchantId" | "secretKey" | "webhookSecret";

/** Whether one secret is stored. There is no field that could carry its value. */
export interface GatewaySecretState {
  configured: boolean;
  version: number | null;
  rotatedAt: string | null;
}

/** A gateway as `GET /gateways` answers it (`billing` F-102-c). Decimals are strings (C-02). */
export interface AdminGateway {
  source: GatewaySource;
  id: string;
  /** The owning tenant; `null` for a platform gateway. */
  tenantId: string | null;
  displayName: string;
  providerName: string;
  gatewayCategory: string;
  isActive: boolean;
  verificationStatus: string | null;
  description: string | null;
  supportedCurrencies: unknown;
  confirmationMode: string | null;
  /** `null` is no limit on that side. */
  minAcceptAmount: string | null;
  maxAcceptAmount: string | null;
  feeCalculationMode: string;
  feeType: string;
  feeValue: string;
  feeFloor: string | null;
  feeCeiling: string | null;
  useLiveRate: boolean;
  staticRate: string | null;
  percentageModifier: string | null;
  fixedAmountModifier: string | null;
  minRate: string | null;
  maxRate: string | null;
  roundingStep: string | null;
  roundingMode: string | null;
  /** This gateway's own quick amounts; empty inherits the tenant's default (F-092-v). */
  depositPresets: string[];
  /** The callback address sent to the provider; `null` = the tenant's panel domain (F-092-w). */
  callbackUrl: string | null;
  /** `null` when billing could not ask the vault; the row is still manageable. */
  credentials: Record<GatewaySecretName, GatewaySecretState> | null;
  /** The secrets its provider needs that are not stored: saved, maybe active, and cannot take a payment yet (F-104-e). `null` with `credentials`. */
  missingSecrets: GatewaySecretName[] | null;
  createdAt: string;
  updatedAt: string;
}

type GatewayFieldsBody = {
  displayName?: string;
  providerName?: string;
  gatewayCategory?: string;
  isActive?: boolean;
  minAcceptAmount?: string | null;
  maxAcceptAmount?: string | null;
  feeCalculationMode?: string;
  feeType?: string;
  feeValue?: string;
  feeFloor?: string | null;
  feeCeiling?: string | null;
  verificationStatus?: string;
  depositPresets?: string[];
  callbackUrl?: string | null;
  /** A Telegram Stars gateway's USD value per Star, with the live rate off (F-104-e). */
  staticRate?: string | null;
  useLiveRate?: boolean;
  /** Write-only. Sent when typed, never read back. */
  merchantId?: string;
  secretKey?: string;
  webhookSecret?: string;
};

export type CreateGatewayBody = GatewayFieldsBody & { source: GatewaySource; tenantId?: string };
export type UpdateGatewayBody = GatewayFieldsBody;

export interface GatewayRemoved {
  id: string;
  source: GatewaySource;
  mode: "deleted" | "deactivated";
  grantsWithdrawn: number;
}

/** A link of one gateway to one borrowing tenant (`audit/contract.settlement.md`). */
export interface GatewayGrant {
  id: string;
  tenantId: string;
  gatewayId: string | null;
  tenantGatewayConfigId: string | null;
  isActive: boolean;
  note: string | null;
  grantedAt: string;
  withdrawnAt: string | null;
}

export type CreateGatewayGrantBody = {
  tenantId: string;
  gatewayId?: string;
  tenantGatewayConfigId?: string;
  note?: string;
};
