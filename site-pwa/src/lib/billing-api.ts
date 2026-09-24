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
 * The statuses a Grant can be in, as `entitlement.prisma` declares them (C-09).
 * Declared once here because the panel reads them in two places — the pill and
 * the page's sentences — and a second spelling is a blank pill in one of them.
 */
export const GRANT_STATUSES = ["pending", "active", "suspended", "exhausted", "expired", "cancelled"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

/**
 * One of the caller's own Grants, as `GET /gift/grants` answers it (F-502-r,
 * `billing/contract.gift.md`).
 *
 * **Neither the subscription key nor its hash is in it.** Billing selects its
 * columns explicitly for that reason (D-35): the key exists in the clear only
 * in a redemption's answer and in a reissue's, never in a list. So a row is
 * what a user recognises a service by, and the way back to its key is the
 * reissue route.
 *
 * `nameKey` is the variant's own wording, else its product's — a key, not the
 * translated text, resolved here through the same published `catalog`
 * namespace the catalog page reads. `variant` is `null` for a Grant issued
 * without a catalog item.
 */
export interface GrantRow {
  id: string;
  /** Answered for every Grant; billing never filters the list by it. */
  status: GrantStatus;
  startsAt: string;
  /** `null` = permanent. */
  endsAt: string | null;
  featureKeys: string[];
  variant: { id: string; sku: string; nameKey: string } | null;
  /** `metered` Grants buy their bytes in blocks, so `purchasedBytes` is what bounds them (ADR-0072). */
  billingMode: "prepaid" | "metered";
  /** Bytes, as a decimal string: what the panels reported. Measured, not charged. */
  consumedBytes: string;
  /** Bytes, as a decimal string: what has been bought. */
  purchasedBytes: string;
  /** Set only while suspended (ADR-0075). */
  suspendedAt: string | null;
  /** When the panel seats are released; `null` when nothing is due (not suspended, or a window of 0). */
  purgeAt: string | null;
}

export type GrantsPage = Paged<GrantRow>;

/**
 * The convergence loop's verdicts on a config (F-027-aa/ab), as `network.prisma`
 * declares `DriftState` (C-09). Only `synced` is quiet: every other one is a
 * button on the service page that says why (F-027-ac).
 */
export const DRIFT_STATES = [
  "synced",
  "reset",
  "renamed",
  "rebuilt",
  "missing",
  "orphan",
  "limit_overridden",
  "contested",
] as const;
export type DriftState = (typeof DRIFT_STATES)[number];

/** A config's own status, as `network.prisma` declares `ConfigStatus`, minus `retired` — the list never answers one. */
export const CONFIG_STATUSES = ["active", "frozen", "disabled_by_admin", "disabled_by_system"] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];

/** The two actions a user may take on a config (user, 2026-09-23). */
export type ConfigAction = "regenerate" | "retire";

/**
 * Why one config's action wrote nothing: billing's `CONFIG_ACTION_REJECTIONS`
 * (`traffic/config-actions.ts`) plus `failed` for a throw that was not a
 * refusal. The page has a sentence for each; the spec reads the tuple.
 */
export const CONFIG_ACTION_REFUSALS = [
  "grant_not_found",
  "grant_not_active",
  "panel_not_found",
  "config_not_found",
  "config_retired",
  "regenerate_limit_reached",
  "config_changed",
  "same_panel",
  "actor_not_allowed",
  "failed",
] as const;
export type ConfigActionRefusal = (typeof CONFIG_ACTION_REFUSALS)[number];

/**
 * One config of a Grant, as `GET /traffic/grants/:id/configs` answers it
 * (F-027-ac, `billing/contract.gift.md`). Never its `uuid`: that is the
 * credential, and `/sub` is what hands it out.
 */
export interface UserConfigRow {
  id: string;
  protocol: string;
  status: ConfigStatus;
  region: string;
  /** Bytes as decimal strings; `null` until the allocator gave it a share. */
  allocatedCeilingBytes: string | null;
  /** What the panel confirmed; a gap to `allocated` is work still queued. */
  appliedCeilingBytes: string | null;
  driftState: DriftState;
  enforcementState: "pending" | "partial" | "complete";
  regenerateUsedCount: number;
  maxRegenerateCount: number;
  lastReconciledAt: string | null;
}

export type ConfigActionOutcome =
  | { configId: string; ok: true }
  | { configId: string; ok: false; reason: ConfigActionRefusal };

/** `GET /traffic/collection-health` (F-027-w): whether anything is metering the user's configs right now. */
export interface CollectionHealth {
  metering: "healthy" | "unavailable" | "not_metered";
  lastCollectedAt: string | null;
  staleForSeconds: number | null;
  configsAffected: number;
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

/**
 * Where a gateway call goes: the ambient surface, which configures the
 * caller's **own** tenant, or the one that names a reseller in the path
 * (F-066-w3, `billing/contract.gateways.md`). The two are shaped identically,
 * `:source/:id` included, so one client serves both.
 *
 * The panel's gateway screens pick by surface, never by who is signed in: a
 * reseller's owner signs in to the platform owner's tenant (ADR-0059), so the
 * ambient path would configure the platform's gateways while answering 200.
 */
export const gatewayApiPrefix = (tenantId: string | null) =>
  tenantId === null ? "/gateways" : `/tenants/${encodeURIComponent(tenantId)}/gateways`;

/** The six calls both gateway surfaces answer. `GatewaysView` takes one of these, not `billingApi`. */
export interface GatewayAdminApi {
  list(): Promise<AdminGateway[]>;
  create(body: CreateGatewayBody): Promise<AdminGateway>;
  update(source: GatewaySource, id: string, body: UpdateGatewayBody): Promise<AdminGateway>;
  remove(source: GatewaySource, id: string): Promise<GatewayRemoved>;
  presets(): Promise<{ presets: string[] }>;
  setPresets(presets: string[]): Promise<{ presets: string[] }>;
}

/**
 * The gateway calls for one surface: `null` for the caller's own tenant
 * (F-102-d), a tenant id for the reseller the path names (F-066-w4). Billing
 * still decides everything — this only chooses which tenant is being asked
 * about.
 */
export function gatewayAdminApi(tenantId: string | null): GatewayAdminApi {
  const at = gatewayApiPrefix(tenantId);
  const row = (source: GatewaySource, id: string) => `${at}/${source}/${encodeURIComponent(id)}`;
  return {
    list: () => call<AdminGateway[]>(at, { method: "GET" }),
    create: (body) => call<AdminGateway>(at, { method: "POST", body: JSON.stringify(body) }),
    update: (source, id, body) => call<AdminGateway>(row(source, id), { method: "PATCH", body: JSON.stringify(body) }),
    remove: (source, id) => call<GatewayRemoved>(row(source, id), { method: "DELETE" }),
    presets: () => call<{ presets: string[] }>(`${at}/presets`, { method: "GET" }),
    setPresets: (presets) => call<{ presets: string[] }>(`${at}/presets`, { method: "PUT", body: JSON.stringify({ presets }) }),
  };
}

/** The caller's own gateways — what `billingApi`'s six gateway calls have always been. */
export const ambientGatewayApi = gatewayAdminApi(null);

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
   * The Mini App's invoice sheet closed without paying (F-093-q): tell billing,
   * so the payment's coupon holds come back now instead of at the end of its
   * 15-minute clock and the one-use code still works on the next try.
   *
   * Every outcome is a 200 verdict there is nothing to show — billing refuses
   * a payment pre-checkout has already approved, because the messenger may
   * hold the money. A network failure here costs only the wait it saved, so
   * the caller lets it go rather than telling the payer about it.
   */
  async depositAbandon(paymentId: string): Promise<{ status: string }> {
    return call<{ status: string }>(`/deposit/${paymentId}/abandon`, { method: "POST" });
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
   * One page of the caller's own Grants (F-502-s → F-502-r), newest period
   * first.
   *
   * **Whose Grants is not a parameter.** The user is the gate's `X-User-Id`,
   * the same shape as the financial page's lists, so there is nothing here to
   * pass and nothing to get wrong. A user with no Grants is an empty page, not
   * a 404; paging is the only knob the route has.
   */
  async grants(page: number, pageSize: number): Promise<GrantsPage> {
    return call<GrantsPage>(`/gift/grants?page=${page}&pageSize=${pageSize}`, { method: "GET" });
  },

  /**
   * Reissue one Grant's subscription key (F-502-q → F-502-p).
   *
   * The key a redemption answers exists in the clear exactly once — billing
   * keeps only its hash (D-35) — so a copy that did not land used to be final.
   * This mints a new one, and the old key stops working inside the same
   * transaction: there is no moment when both open the link, and none when
   * neither does (`billing/contract.gift.md`).
   *
   * **The id is the whole request.** The route takes no body, because the only
   * thing it protects is that the caller owns the Grant, and a field naming a
   * user would be a field to lie in. Another user's Grant and one that does not
   * exist are the same 404, so this client cannot tell them apart either.
   *
   * Its own bucket, 5 per 900s: each call destroys a working key, so a caller
   * that retried on the user's behalf would spend the budget that recovers it.
   */
  async rotateGrantToken(grantId: string): Promise<{ grantId: string; subscriptionKey: string }> {
    return call<{ grantId: string; subscriptionKey: string }>(
      `/gift/grants/${encodeURIComponent(grantId)}/rotate-token`,
      { method: "POST" },
    );
  },

  /**
   * One Grant's configs, with each one's ceiling and drift verdict (F-027-ac).
   * Another user's Grant is the same 404 as a missing one.
   */
  async grantConfigs(grantId: string): Promise<{ grantId: string; rows: UserConfigRow[] }> {
    return call<{ grantId: string; rows: UserConfigRow[] }>(
      `/traffic/grants/${encodeURIComponent(grantId)}/configs`,
      { method: "GET" },
    );
  },

  /**
   * One action on one config or up to fifty (F-027-ac). **Always an outcome
   * per config**, never all-or-nothing (user, 2026-09-23): a refused config
   * does not stop the others, and the answer says which it was. A 4xx here is
   * the request itself — a bad body or the limiter — not one config.
   */
  async configAction(action: ConfigAction, configIds: string[]): Promise<{ action: ConfigAction; results: ConfigActionOutcome[] }> {
    return call<{ action: ConfigAction; results: ConfigActionOutcome[] }>("/traffic/configs/actions", {
      method: "POST",
      body: JSON.stringify({ action, configIds }),
    });
  },

  /** Whether the collector is reading the user's panels (F-027-w) — the service page's "not cut off" sentence. */
  async collectionHealth(): Promise<CollectionHealth> {
    return call<CollectionHealth>("/traffic/collection-health", { method: "GET" });
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

  // The systems page (F-027-ad). billing scopes every one to the platform
  // owner's panels (`panelScopeOf`); nothing here sends a tenant.

  /** Register a panel as desired state. The answer is always `pending`: the verdict is the next tick's. */
  async registerPanel(body: RegisterPanelBody): Promise<RegisteredPanel> {
    return call<RegisteredPanel>("/systems/panels", { method: "POST", body: JSON.stringify(body) });
  },

  /**
   * A new login for a registered panel (F-027-au): rotated in the vault; a
   * `pending` panel is re-tested on the next tick unless it is cooling off
   * after `rate_limited`. A refused panel is 409 `panel_refused`.
   */
  async resubmitPanelLogin(id: string, credentials: string): Promise<ResubmittedLogin> {
    return call<ResubmittedLogin>(`/systems/panels/${encodeURIComponent(id)}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ credentials }),
    });
  },

  async systemsPanels(): Promise<SystemsPanel[]> {
    return call<SystemsPanel[]>("/systems/panels", { method: "GET" });
  },

  async panelCapabilities(id: string): Promise<CapabilityMatrix> {
    return call<CapabilityMatrix>(`/systems/panels/${encodeURIComponent(id)}/capabilities`, { method: "GET" });
  },

  async driftEvents(query: { state: "open" | "all"; after?: string }): Promise<CursorPage<SystemsDriftEvent>> {
    const q = new URLSearchParams({ state: query.state });
    if (query.after) q.set("after", query.after);
    return call<CursorPage<SystemsDriftEvent>>(`/systems/drift-events?${q}`, { method: "GET" });
  },

  /** The decision a halted panel waits for; its collection resumes on the next pass. */
  async acknowledgeDrift(id: string, note?: string): Promise<SystemsDriftEvent> {
    return call<SystemsDriftEvent>(`/systems/drift-events/${encodeURIComponent(id)}/acknowledge`, {
      method: "POST",
      body: JSON.stringify(note === undefined ? {} : { note }),
    });
  },

  async usageHolds(query: { state: "pending" | "all"; after?: string }): Promise<CursorPage<SystemsHold>> {
    const q = new URLSearchParams({ state: query.state });
    if (query.after) q.set("after", query.after);
    return call<CursorPage<SystemsHold>>(`/systems/holds?${q}`, { method: "GET" });
  },

  /** Queued for the meter (202); the hold stays `pending` until it is billed. A second release is harmless. */
  async releaseHold(id: string, note?: string): Promise<QueuedRelease> {
    return call<QueuedRelease>(`/systems/holds/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: JSON.stringify(note === undefined ? {} : { note }),
    });
  },

  /** Never charged, and once: a second write-off is 409 `already_resolved`. */
  async writeOffHold(id: string, note: string): Promise<SystemsHold> {
    return call<SystemsHold>(`/systems/holds/${encodeURIComponent(id)}/write-off`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
  },

  // The six gateway calls are {@link ambientGatewayApi}'s, kept here under
  // their old names for the pages that ask about the caller's own tenant and
  // nothing else (the coupon form's gateway picker). A screen that configures
  // a named reseller takes a `GatewayAdminApi` instead.
  async adminGateways(): Promise<AdminGateway[]> {
    return ambientGatewayApi.list();
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

// ── The systems page (F-027-ad) — billing `contract.systems.md` ──────────────
// Every value below is what `network-service`'s loops last wrote (ADR-0071):
// billing reads columns, it never calls the Go service, so a stale figure
// shows as an old timestamp, never as a number made up on the way.

/** `network.PanelReviewState`. A verdict arrives on the next tick; until then `pending`. */
export type PanelReviewState = "pending" | "accepted" | "accepted_low_trust" | "refused";
/** `network.PanelState`. `throttled_or_blocked` is a panel answering and refusing us, not one that is down. */
export type PanelState = "healthy" | "degraded" | "maintenance" | "down" | "throttled_or_blocked";
/** `network.ConnectionTestFault`: the test did not get an answer — not a verdict. */
export type ConnectionTestFault =
  | "timeout"
  | "rate_limited"
  | "blocked"
  | "unavailable"
  | "unsupported"
  | "protocol"
  | "unopenable"
  | "invalid_answers";

export interface SystemsPanel {
  id: string;
  name: string;
  driverType: string;
  transport: "pull" | "push";
  role: "active" | "passive";
  region: string;
  review: {
    reviewState: PanelReviewState;
    connectionTestedAt: string | null;
    connectionTestFault: ConnectionTestFault | null;
    connectionTestDetail: string | null;
  };
  health: {
    panelState: PanelState;
    lastHealthyAt: string | null;
    lastSuccessfulCollectionAt: string | null;
    collectionHalted: boolean;
    openDriftEvents: number;
  };
  budget: { maxRequestsPerMinute: number; blockedSince: string | null };
}

/** One questionnaire row as billing answers it (`systems/capabilities.ts`). The question is said here, by `key`. */
export interface CapabilityRow {
  key: string;
  scope: string;
  severity: string;
  state: string;
  detail: string | null;
}

export interface CapabilityMatrix {
  id: string;
  transport: string;
  reviewState: PanelReviewState;
  connectionTestedAt: string | null;
  documentVersion: number | null;
  /** False when the stored answers are under another version: every row in scope reads `unanswered`. */
  current: boolean;
  answeredAt: string | null;
  rows: CapabilityRow[];
}

export interface SystemsDriftEvent {
  id: string;
  panelId: string;
  panelName: string | null;
  eventType: "mass_reset" | "mass_missing" | "mass_rename" | "mass_limit_override";
  affectedConfigCount: number;
  observedConfigCount: number;
  detectedAt: string;
  collectionHalted: boolean;
  acknowledgedAt: string | null;
  acknowledgedByAdminId: string | null;
  note: string | null;
}

export type HoldReason =
  | "gigawords_missing"
  | "session_never_closed"
  | "publish_failed_after_read"
  | "attribution_ambiguous"
  | "panel_drift_event"
  | "low_trust_source";

export interface SystemsHold {
  id: string;
  configId: string;
  panelId: string;
  panelName: string | null;
  /** Decimal strings: a BIGINT past 2^53 is not a JSON number (rule 13). */
  upBytes: string;
  downBytes: string;
  reason: HoldReason;
  state: "pending" | "released" | "written_off";
  heldFrom: string;
  heldAt: string;
  resolvedAt: string | null;
  resolvedByAdminId: string | null;
  resolutionNote: string | null;
}

/** What re-submitting a login answers (F-027-au). `retest`: the next tick tests the panel again. */
export interface ResubmittedLogin {
  id: string;
  reviewState: PanelReviewState;
  retest: boolean;
  credentials: RegisteredPanel["credentials"];
}

/** What a release answers: queued for the meter, the hold still `pending` (rule 10). */
export interface QueuedRelease {
  id: string;
  state: "pending";
  release: "queued";
}

/** A keyset page: `next` is the `after` of the following one, null on the last. */
export interface CursorPage<Row> {
  items: Row[];
  next: string | null;
}

export interface RegisterPanelBody {
  name: string;
  ipAddress: string;
  apiBaseUrl?: string;
  driverType: string;
  counterSemantics: string;
  transport: "pull" | "push";
  role: "active" | "passive";
  region: string;
  maxRequestsPerMinute?: number;
  /** The panel's login. Relayed once to the vault and never answered back. */
  credentials: string;
}

export interface RegisteredPanel {
  id: string;
  reviewState: "pending";
  credentials: { configured: boolean; version: number | null; rotatedAt: string | null };
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

/** Every reason `/settlement/*` can refuse with (`settlement.service.ts` `SettlementRejection`). */
export type SettlementRejection =
  | "not_platform_owner"
  | "gateway_not_found"
  | "tenant_not_found"
  | "grant_to_owner"
  | "gateway_not_grantable"
  | "already_granted"
  | "grant_not_found"
  | "already_withdrawn"
  | "amount_not_positive"
  | "exceeds_outstanding";

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
