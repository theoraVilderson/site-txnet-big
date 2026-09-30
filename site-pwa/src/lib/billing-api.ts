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
  /** In `currencyCode`, a decimal string. Always `> 0` — a zero-value coupon raises server-side. */
  credited: string;
  /** The balance after the credit. In `currencyCode`, a decimal string. */
  balance: string;
  /** What `credited` and `balance` are in: the code's own, which the wallet's matches (F-116-h3). */
  currencyCode: string;
}

/**
 * A free-service code (F-502-l-b): a Grant, and no token — the link is My
 * services' to show, as often as asked (F-114-e-c, ADR-0085).
 */
export interface GiftGrant {
  kind: "free_grant";
  code: string;
  grant: { id: string; variantId: string | null; startsAt: string; endsAt: string | null; featureKeys: string[] };
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
  /** The buyer's own name for it (F-307-x), shown before the catalog's; `null` = unnamed. */
  label: string | null;
  /** Answered for every Grant; `cancelled` and `exhausted` come only on scope `all`. */
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
  /** Sold with unlimited traffic (F-111-q): `purchasedBytes` is 0 and bounds nothing (F-111-s). */
  trafficUnlimited: boolean;
  /** A capped prepaid Grant's cap in bytes, rollover included — `/sub`'s `total`; `null` otherwise (F-111-t). */
  trafficCapBytes: string | null;
  /** Set only while suspended (ADR-0075). */
  suspendedAt: string | null;
  /** When the panel seats are released; `null` when nothing is due (not suspended, or a window of 0). */
  purgeAt: string | null;
  /** When traffic last moved, to within one usage push; `null` when it never has (F-307-u). */
  lastTrafficAt: string | null;
}

/**
 * Which Grants the list answers (user, 2026-09-26): `current` leaves out the
 * ones that will never serve again — `cancelled` and `exhausted` — and `all`
 * lists every one. `hidden` is how many `current` left out (0 on `all`).
 */
export type GrantScope = "current" | "all";
export type GrantsPage = Paged<GrantRow> & { hidden: number };

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
  "regenerate_unfunded",
  "config_changed",
  "same_panel",
  "actor_not_allowed",
  "failed",
] as const;
export type ConfigActionRefusal = (typeof CONFIG_ACTION_REFUSALS)[number];

/**
 * What a new link costs on one Grant (F-118-r): the `vpn.config.regenerate`
 * terms it locked at sale, and how many it has used — the row billing's door
 * prices from (F-118-h). `null` on a Grant sold without one: the count cap.
 */
export interface RegenerateTerms {
  unitSize: string;
  unitPrice: string;
  currencyCode: string;
  mode: string;
  includedQuantity: string;
  afterIncluded: string;
  used: string;
}

/** `GET /traffic/grants/:id/configs` for the user's own Grant. */
export interface UserGrantConfigs {
  grantId: string;
  rows: UserConfigRow[];
  /** Absent from an older billing: read as none. */
  regenerate?: RegenerateTerms | null;
}

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
  /** The buyer's own name for it (F-307-g); `null` is the default name. */
  label: string | null;
  /**
   * The config's captured link lines, named by billing as `/sub` names them
   * (ADR-0089) — what `/sub` hands the same user
   * (F-307-a). `[]` with `linksCapturedAt` `null`: not captured since the last
   * new key. `[]` with a time: the panel gives none.
   */
  lines: string[];
  linksCapturedAt: string | null;
}

/** A spending cap's `period` (F-118-i): one budget for the service's life, or one per month from its start date. */
export const SPENDING_CAP_PERIODS = ["none", "monthly"] as const;
export type SpendingCapPeriod = (typeof SPENDING_CAP_PERIODS)[number];

/**
 * The owner's cap on one service's usage (F-118-i, `billing/contract.spending-cap.md`):
 * who it is for, and at most how much its usage may cost. Money is two-place
 * strings in `currencyCode`, the wallet's; `left` is `amount − spent`, never below zero.
 */
export interface SpendingCap {
  grantId: string;
  label: string;
  amount: string;
  currencyCode: string;
  period: SpendingCapPeriod;
  periodStartsAt: string;
  spent: string;
  held: string;
  left: string;
}

/**
 * `GET /traffic/grants/:id/usage` (F-307-b): exactly 30 UTC days, today
 * included, oldest first, a day with no traffic as `"0"`. Bytes are decimal
 * strings; today is what the last rollup saw.
 */
export interface GrantUsage {
  grantId: string;
  from: string;
  to: string;
  days: { date: string; uploadBytes: string; downloadBytes: string }[];
}

/** One billing period of a metered Grant (F-118-ai): instants, bytes as a decimal string, money in the wallet's currency. */
export interface GrantPeriod {
  from: string;
  to: string;
  consumedBytes: string;
  spent: string;
}

/**
 * `GET /traffic/grants/:id/period` (F-118-ai): a metered Grant's month — from
 * the latest anniversary of its start to the next — and the one before
 * (`null` in the first). `coversBytes` is billing's estimate of what is still
 * paid for or payable; `null` when it cannot say.
 */
export interface GrantPeriodView {
  grantId: string;
  current: GrantPeriod;
  previous: GrantPeriod | null;
  currencyCode: string | null;
  coversBytes: string | null;
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
  /** In `currencyCode`, decimal strings. The gateway's own range — the amount box's bounds; `null` is no limit on that side. */
  minAmount: string | null;
  maxAmount: string | null;
  /** Off or not yet verified: shown only to someone who may manage gateways, so they can test it. */
  testing: boolean;
  /**
   * Quick amounts (F-092-v): the gateway's own list, else the tenant's default,
   * already inside the range. Empty means none was configured.
   */
  presets: string[];
  /** The gateway's own currency: what its range and presets are in (F-116-h2). */
  currencyCode: string;
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
  /** The payment's currency: what every amount here but `charge` is in (F-116-h2). */
  currencyCode: string;
  coupons: QuotedCoupon[];
  rejected: RejectedCoupon[];
  discount: string;
  /**
   * What the payable was raised by to clear the gateway's minimum, and never a
   * charge: it is credited to the wallet too, so `credited` already carries it.
   */
  gap: string;
  fee: string;
  /**
   * Tax on top of the basis (ADR-0076), already inside `payable`. `0.00` when
   * untaxed; `taxRatePercent` is the rate billing applied — the gateway's, else
   * the tenant default — or `null` for none.
   */
  tax: string;
  taxRatePercent: string | null;
  /** What the card is charged, in `currencyCode`. `0.00` on the free path. */
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
  tax: string;
  taxRatePercent: string | null;
  payable: string;
  credited: string;
  /** The wallet balance after a free top-up credited it; `null` when nothing was credited. */
  balance: string | null;
  /** What every amount here is in (F-116-h3, ADR-0098): the answer's own, never assumed. */
  currencyCode: string;
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

/** The eight calls both gateway surfaces answer. `GatewaysView` takes one of these, not `billingApi`. */
/** The tenant's default quick amounts, and the currency they are in (F-116-h2). */
export interface DepositPresets {
  presets: string[];
  currencyCode: string;
}

export interface GatewayAdminApi {
  list(): Promise<AdminGateway[]>;
  create(body: CreateGatewayBody): Promise<AdminGateway>;
  update(source: GatewaySource, id: string, body: UpdateGatewayBody): Promise<AdminGateway>;
  remove(source: GatewaySource, id: string): Promise<GatewayRemoved>;
  presets(): Promise<DepositPresets>;
  setPresets(presets: string[]): Promise<DepositPresets>;
  /** The tenant's default tax on a top-up (F-104-ag); `null` is no tax. */
  tax(): Promise<{ taxRatePercent: string | null }>;
  setTax(taxRatePercent: string | null): Promise<{ taxRatePercent: string | null }>;
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
    presets: () => call<DepositPresets>(`${at}/presets`, { method: "GET" }),
    setPresets: (presets) => call<DepositPresets>(`${at}/presets`, { method: "PUT", body: JSON.stringify({ presets }) }),
    tax: () => call<{ taxRatePercent: string | null }>(`${at}/tax`, { method: "GET" }),
    setTax: (taxRatePercent) =>
      call<{ taxRatePercent: string | null }>(`${at}/tax`, { method: "PUT", body: JSON.stringify({ taxRatePercent }) }),
  };
}

/** The caller's own gateways — what `billingApi`'s six gateway calls have always been. */
export const ambientGatewayApi = gatewayAdminApi(null);

/**
 * What a reseller's admin may take on a user's config (F-311-g): billing's
 * `ADMIN_CONFIG_ACTIONS`. A `disable` carries its `reason` and a `move` its
 * `toPanelId`, and nothing else carries either — the schema refuses the rest.
 */
export type AdminConfigAction = "regenerate" | "disable" | "enable" | "retire" | "move";
export interface AdminConfigActionBody {
  action: AdminConfigAction;
  configIds: string[];
  reason?: string;
  toPanelId?: string;
}
export type AdminConfigActionOutcome =
  | { configId: string; ok: true; movedTo?: string }
  | { configId: string; ok: false; reason: ConfigActionRefusal };

/**
 * One user's services under a reseller the **path** names (F-311-f/g,
 * `billing/contract.reseller-grants.md`): `/tenants/:tenantId/users/:userId`.
 * Never the session's tenant — a reseller's owner signs in to the platform's
 * (ADR-0059) — and never the caller's own Grants.
 */
export const resellerUserGrantsPath = (tenantId: string, userId: string) =>
  `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`;

/** The owner's four reads and the config actions, as an admin asks them for one user. */
export interface ResellerUserGrantsApi {
  grants(page: number, pageSize: number, scope: GrantScope): Promise<GrantsPage>;
  grantConfigs(grantId: string): Promise<{ grantId: string; rows: UserConfigRow[] }>;
  grantUsage(grantId: string): Promise<GrantUsage>;
  subscriptionLink(grantId: string): Promise<{ grantId: string; subscriptionUrl: string }>;
  configAction(body: AdminConfigActionBody): Promise<{ action: AdminConfigAction; results: AdminConfigActionOutcome[] }>;
  /** Where a move may send a config (F-311-v1): shared panels and the reseller's own. */
  moveTargets(): Promise<MoveTarget[]>;
  /**
   * An admin's act on one Grant (F-311-w): `route` is the action's segment
   * under `…/grants/:grantId/` and `body` exactly what its schema takes —
   * both from `my-resellers/_lib/grant-actions.ts`, which the spec holds to
   * the controller.
   */
  grantAction(grantId: string, route: string, body: Record<string, unknown>): Promise<GrantActionResult>;
  /** An admin issues this user a service by hand (F-311-o). */
  issue(body: Record<string, unknown>): Promise<GrantIssued>;
  /** Every audited admin act on this Grant and its configs, newest first (F-311-r). */
  history(grantId: string, page: number, pageSize: number): Promise<GrantHistoryPage>;
}

/**
 * One audited admin act (F-311-r, audit `contract.md` "a Grant's history"):
 * `action` is audit's `AdminAction`, `targetType` `grant` or `config`,
 * `before` / `after` the target's columns as billing wrote them. The admin's
 * IP is never answered.
 */
export interface GrantHistoryRow {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actorUserId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  at: string;
}
export type GrantHistoryPage = Paged<GrantHistoryRow> & { grantId: string };

/**
 * The answer of any Grant action (`billing/contract.reseller-grants.md`),
 * as one shape: each route fills its own fields and the sheet reads only
 * those. Bytes and money are decimal strings.
 */
export interface GrantActionResult {
  grantId: string;
  configsDisabled?: number;
  configsRestored?: number;
  endsAtAfter?: string | null;
  purchasedBytesAfter?: string;
  resetBytes?: string;
  spent?: boolean;
  revived?: boolean;
  rateMbpsAfter?: number | null;
  limitAfter?: number | null;
  panelsNotEnforcing?: { id: string; name: string }[];
  subscriptionUrl?: string;
  renewed?: boolean;
  refundedAmount?: string | null;
  /** What `refundedAmount` is in (F-116-h3); `null` with it. */
  currencyCode?: string | null;
  refundSkipped?: string | null;
}

export interface GrantIssued {
  grantId: string;
  variantId: string;
  status: GrantStatus;
  startsAt: string;
  endsAt: string | null;
  /** `false`: a repeat of the same request, answering its first Grant. */
  issued: boolean;
}

/** A panel a config may move to (F-311-v1); `own` is the reseller's dedicated one, else shared. */
export interface MoveTarget {
  id: string;
  name: string;
  region: string;
  own: boolean;
}

export function resellerUserGrantsApi(tenantId: string, userId: string): ResellerUserGrantsApi {
  const at = resellerUserGrantsPath(tenantId, userId);
  const grant = (grantId: string) => `${at}/grants/${encodeURIComponent(grantId)}`;
  return {
    grants: (page, pageSize, scope) =>
      call<GrantsPage>(`${at}/grants?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), scope })}`, { method: "GET" }),
    grantConfigs: (grantId) => call<{ grantId: string; rows: UserConfigRow[] }>(`${grant(grantId)}/configs`, { method: "GET" }),
    grantUsage: (grantId) => call<GrantUsage>(`${grant(grantId)}/usage`, { method: "GET" }),
    subscriptionLink: (grantId) =>
      call<{ grantId: string; subscriptionUrl: string }>(`${grant(grantId)}/subscription-link`, { method: "GET" }),
    moveTargets: async () => (await call<{ panels: MoveTarget[] }>(`${at}/configs/move-targets`, { method: "GET" })).panels,
    configAction: (body) =>
      call<{ action: AdminConfigAction; results: AdminConfigActionOutcome[] }>(`${at}/configs/actions`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    grantAction: (grantId, route, body) => call<GrantActionResult>(`${grant(grantId)}/${route}`, { method: "POST", body: JSON.stringify(body) }),
    issue: (body) => call<GrantIssued>(`${at}/grants`, { method: "POST", body: JSON.stringify(body) }),
    history: (grantId, page, pageSize) =>
      call<GrantHistoryPage>(`${grant(grantId)}/history?${new URLSearchParams({ page: String(page), pageSize: String(pageSize) })}`, { method: "GET" }),
  };
}

/**
 * A reseller's services across all its users (F-311-t, -u): `/tenants/:tenantId/grants`,
 * no user in the path — the paste or the ticked ids name them, each fenced by
 * the reseller's tenant (C-15).
 */
export const resellerGrantsPath = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/grants`;

/** The users-admin door's catalog (F-311-ab1): what an admin issues and a bulk filter picks by product. */
export const resellerUsersCatalogPath = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/users-catalog`;

/** One product as that route answers it: no price, `tenantId` decided by billing. */
export type UsersCatalogProduct = {
  id: string;
  nameKey: string;
  isActive: boolean;
  variants: { id: string; sku: string; nameKey: string | null; isActive: boolean }[];
};

/** A found service: the owner's row with the user it belongs to. */
export type ResellerGrantRow = GrantRow & { userId: string };

export function resellerGrantsApi(tenantId: string) {
  const at = resellerGrantsPath(tenantId);
  return {
    /**
     * The reseller's Grants holding a pasted config line or `/sub` link
     * (F-311-t). **A body, never a query string** — a line is a credential.
     */
    byLines: (lines: string[], page: number, pageSize: number, scope: GrantScope) =>
      call<Paged<ResellerGrantRow> & { hidden: number }>(`${at}/by-lines`, { method: "POST", body: JSON.stringify({ lines, page, pageSize, scope }) }),
    /** One act on 1..50 Grants (F-311-u); a repeated `requestId` answers the first call (F-311-u1). */
    bulk: (body: Record<string, unknown>) =>
      call<{ action: string; results: BulkOutcomeRow[] }>(`${at}/bulk`, { method: "POST", body: JSON.stringify(body) }),
    /**
     * The tenant's own products and plans, switched-off ones included (F-311-ab1):
     * the users-admin door's, so no `catalog.manage` — the platform's too (D-57).
     */
    usersCatalog: async () => (await call<{ products: UsersCatalogProduct[] }>(resellerUsersCatalogPath(tenantId), { method: "GET" })).products,
    /** The panels holding the reseller's services, the retired included (F-311-x1): a filter's picker. */
    bulkPanels: async () => (await call<{ panels: BulkPanel[] }>(`${at}/bulk-jobs/panels`, { method: "GET" })).panels,
    /** How many Grants a filter matches now (F-311-u2): what the confirm shows. */
    bulkCount: async (filter: object) =>
      (await call<{ count: number }>(`${at}/bulk-jobs/count`, { method: "POST", body: JSON.stringify({ filter }) })).count,
    /** Starts a job over the Grants the filter matches now; a repeated `requestId` answers the same job. */
    bulkStart: (body: Record<string, unknown>) => call<BulkJob>(`${at}/bulk-jobs`, { method: "POST", body: JSON.stringify(body) }),
    bulkJobs: (page: number, pageSize: number) =>
      call<Paged<BulkJob>>(`${at}/bulk-jobs?${new URLSearchParams({ page: String(page), pageSize: String(pageSize) })}`, { method: "GET" }),
    bulkJob: (jobId: string) => call<BulkJob>(`${at}/bulk-jobs/${encodeURIComponent(jobId)}`, { method: "GET" }),
    /** The Grants a job reached, in order; `problems` keeps the refused and failed. No rows once purged. */
    bulkOutcomes: (jobId: string, page: number, pageSize: number, problems: boolean) =>
      call<{ rows: BulkOutcomeRow[]; page: number; pageSize: number; purgedAt: string | null }>(
        `${at}/bulk-jobs/${encodeURIComponent(jobId)}/outcomes?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), problems: String(problems) })}`,
        { method: "GET" },
      ),
    bulkCancel: (jobId: string) => call<BulkJob>(`${at}/bulk-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }),
  };
}

/** A panel a bulk filter can name (F-311-x1); `grants` = the reseller's active and frozen services with a live config on it. */
export interface BulkPanel {
  id: string;
  name: string;
  region: string;
  own: boolean;
  retired: boolean;
  grants: number;
}

/** A bulk act by a filter, run by the worker (F-311-u2); `total` was frozen at the confirm. */
export interface BulkJob {
  id: string;
  requestId: string;
  action: string;
  command: Record<string, unknown>;
  filter: { panelId?: string; productId?: string; variantId?: string; statuses: string[] };
  status: "running" | "done" | "cancelled";
  total: number;
  processed: number;
  ok: number;
  refused: number;
  failed: number;
  createdAt: string;
  finishedAt: string | null;
  purgedAt: string | null;
}

/** One Grant's outcome of a bulk request; `result` is the single act's answer. */
export type BulkOutcomeRow =
  | { grantId: string; userId: string; ok: true; result: GrantActionResult }
  | { grantId: string; ok: false; reason: string; panels?: { id: string; name: string }[] };

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

  async grants(page: number, pageSize: number, scope: GrantScope, q = ""): Promise<GrantsPage> {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), scope });
    // Billing trims `q` and reads a blank one as none (F-307-m); none is not sent.
    if (q.trim() !== "") query.set("q", q.trim());
    return call<GrantsPage>(`/gift/grants?${query}`, { method: "GET" });
  },

  /**
   * The same page, narrowed to the Grants holding a config one of `lines` is
   * (F-307-p) — by its uuid, or its captured line with the name left out.
   * **A body, never a query string:** a line is a credential, and a URL lands
   * in access logs and history. Its own bucket, 60 per 900s per user.
   */
  async grantsByLines(lines: string[], page: number, pageSize: number, scope: GrantScope): Promise<GrantsPage> {
    return call<GrantsPage>("/gift/grants/by-lines", {
      method: "POST",
      body: JSON.stringify({ lines, page, pageSize, scope }),
    });
  },

  /**
   * One Grant's `/sub` link (F-114-e-b, ADR-0085): `https://<tenant subscription
   * domain>/sub/<token>`, the same on every call — billing keeps the token
   * sealed, so the link is asked for whenever it is wanted, never stored here.
   *
   * **The id is the whole request**; another user's Grant and a missing one are
   * the same 404. The two named refusals are 409s: `no_subscription_domain`
   * (the tenant's setup) and `link_not_kept` (a Grant from before the token was
   * kept — one reset keeps it from then on).
   */
  async subscriptionLink(grantId: string): Promise<{ grantId: string; subscriptionUrl: string }> {
    return call<{ grantId: string; subscriptionUrl: string }>(
      `/gift/grants/${encodeURIComponent(grantId)}/subscription-link`,
      { method: "GET" },
    );
  },

  /**
   * "Reset link" (F-502-p, F-114-e-b): a new token for a link that leaked. The
   * old link stops working in billing's transaction, and the answer is the new
   * one. Its own bucket, 5 per 900s: each call destroys a working link, so a
   * caller that retried on the user's behalf would spend the budget for it.
   */
  async resetSubscriptionLink(grantId: string): Promise<{ grantId: string; subscriptionUrl: string }> {
    return call<{ grantId: string; subscriptionUrl: string }>(
      `/gift/grants/${encodeURIComponent(grantId)}/rotate-token`,
      { method: "POST" },
    );
  },

  /**
   * One Grant's configs, with each one's ceiling and drift verdict (F-027-ac).
   * Another user's Grant is the same 404 as a missing one.
   */
  async grantConfigs(grantId: string): Promise<UserGrantConfigs> {
    return call<UserGrantConfigs>(
      `/traffic/grants/${encodeURIComponent(grantId)}/configs`,
      { method: "GET" },
    );
  },

  /** A Grant's daily bytes over the last 30 days (F-307-b) — the same 404 as `grantConfigs` for another user's Grant. */
  async grantUsage(grantId: string): Promise<GrantUsage> {
    return call<GrantUsage>(`/traffic/grants/${encodeURIComponent(grantId)}/usage`, { method: "GET" });
  },

  /** A metered Grant's billing period (F-118-ai); 404 another user's, 409 a Grant that is not metered. */
  async grantPeriod(grantId: string): Promise<GrantPeriodView> {
    return call<GrantPeriodView>(`/traffic/grants/${encodeURIComponent(grantId)}/period`, { method: "GET" });
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

  /**
   * Names one of the user's configs, or clears the name with `null`
   * (F-307-g, ADR-0089). Display only: the lines carry it on the next read,
   * and `/sub` on the app's next refresh. Another user's config is a 404.
   */
  async setConfigLabel(configId: string, label: string | null): Promise<{ configId: string; label: string | null }> {
    return call<{ configId: string; label: string | null }>(`/traffic/configs/${encodeURIComponent(configId)}/label`, {
      method: "PUT",
      body: JSON.stringify({ label }),
    });
  },

  /**
   * Names one of the user's services, or clears the name with `null`
   * (F-307-x). Display only: My services, its search and the user's notices
   * show it before the config names. Another user's service is a 404.
   */
  async setGrantLabel(grantId: string, label: string | null): Promise<{ grantId: string; label: string | null }> {
    return call<{ grantId: string; label: string | null }>(`/gift/grants/${encodeURIComponent(grantId)}/label`, {
      method: "PUT",
      body: JSON.stringify({ label }),
    });
  },

  /** One service's spending cap (F-118-i); `cap` is null when none is set. Another user's service is a 404. */
  async spendingCap(grantId: string): Promise<{ grantId: string; cap: SpendingCap | null }> {
    return call<{ grantId: string; cap: SpendingCap | null }>(`/traffic/grants/${encodeURIComponent(grantId)}/cap`, { method: "GET" });
  },

  /**
   * Sets, raises or lowers a service's cap. A new cap or a changed `period`
   * counts from now; a changed amount or label keeps what was spent.
   */
  async setSpendingCap(
    grantId: string,
    body: { label: string; amount: string; period: SpendingCapPeriod },
  ): Promise<{ grantId: string; cap: SpendingCap }> {
    return call<{ grantId: string; cap: SpendingCap }>(`/traffic/grants/${encodeURIComponent(grantId)}/cap`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  /** Removes a service's cap: its usage is bounded by the wallet alone again. No cap is a 204 too. */
  async removeSpendingCap(grantId: string): Promise<void> {
    await call<void>(`/traffic/grants/${encodeURIComponent(grantId)}/cap`, { method: "DELETE" });
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

  /**
   * A new RADIUS secret for a push panel (F-027-az): rotated in the vault; the
   * allowlist reads it within a minute and nothing is re-tested. A pull panel
   * is 409 `panel_not_push`, a refused one 409 `panel_refused`.
   */
  async resubmitPanelRadiusSecret(id: string, radiusSecret: string): Promise<ResubmittedRadiusSecret> {
    return call<ResubmittedRadiusSecret>(`/systems/panels/${encodeURIComponent(id)}/radius-secret`, {
      method: "PUT",
      body: JSON.stringify({ radiusSecret }),
    });
  },

  /**
   * A panel's settings (F-027-by): only what changed. A changed API or link
   * address sends it back to `pending` (`retest`); a push panel takes neither
   * (409 `not_for_transport`), an archived one nothing (409 `panel_retired`).
   */
  async updatePanel(id: string, body: PanelSettingsBody): Promise<UpdatedPanel> {
    return call<UpdatedPanel>(`/systems/panels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  /**
   * Delete a panel (F-027-bz): `deleted` with no history, `archived` with it.
   * 409 `panel_in_group` / `panel_has_configs` while it serves.
   */
  async deletePanel(id: string): Promise<RemovedPanel> {
    return call<RemovedPanel>(`/systems/panels/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  /** Restore an archived panel (F-027-bz): back to `pending`, tested before it is collected. */
  async restorePanel(id: string): Promise<{ id: string; reviewState: "pending" }> {
    return call<{ id: string; reviewState: "pending" }>(`/systems/panels/${encodeURIComponent(id)}/restore`, { method: "POST" });
  },

  async systemsPanels(): Promise<SystemsPanel[]> {
    return call<SystemsPanel[]>("/systems/panels", { method: "GET" });
  },

  async panelCapabilities(id: string): Promise<CapabilityMatrix> {
    return call<CapabilityMatrix>(`/systems/panels/${encodeURIComponent(id)}/capabilities`, { method: "GET" });
  },

  // A panel's inbounds (F-114-b): what the last read found, and which ones a buyer is placed on.

  async panelInbounds(id: string): Promise<PanelInbounds> {
    return call<PanelInbounds>(`/systems/panels/${encodeURIComponent(id)}/inbounds`, { method: "GET" });
  },

  /** 404 `inbound_not_found`, 409 `inbound_not_sellable` (gone, or a protocol we do not sell). */
  async updatePanelInbounds(id: string, body: PanelInboundsBody): Promise<PanelInbounds> {
    return call<PanelInbounds>(`/systems/panels/${encodeURIComponent(id)}/inbounds`, { method: "PUT", body: JSON.stringify(body) });
  },

  /** 202: the panel's next pass (within a minute) reads its inbounds again. */
  async refreshPanelInbounds(id: string): Promise<{ panelId: string; refreshRequested: true }> {
    return call<{ panelId: string; refreshRequested: true }>(`/systems/panels/${encodeURIComponent(id)}/inbounds/refresh`, { method: "POST" });
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

  // Panel groups (F-027-bx -> billing F-027-bw): the platform's, always `mirror`.

  async panelGroups(): Promise<PanelGroup[]> {
    return call<PanelGroup[]>("/systems/panel-groups", { method: "GET" });
  },

  async createPanelGroup(body: PanelGroupBody & { name: string }): Promise<PanelGroup> {
    return call<PanelGroup>("/systems/panel-groups", { method: "POST", body: JSON.stringify(body) });
  },

  /** At least one field; configs already placed stay where they are (billing rule 22). */
  async updatePanelGroup(id: string, body: PanelGroupBody): Promise<PanelGroup> {
    return call<PanelGroup>(`/systems/panel-groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  /** Enters as `primary`; fulfilment places on it once its panel is accepted and healthy. */
  async addPanelGroupMember(groupId: string, panelId: string): Promise<PanelGroupMember> {
    return call<PanelGroupMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members`, {
      method: "POST",
      body: JSON.stringify({ panelId }),
    });
  },

  /** A member's own selling settings (F-027-cg); null hands one back to the panel. */
  async updatePanelGroupMember(groupId: string, panelId: string, body: MemberSellingBody): Promise<PanelGroupMember> {
    return call<PanelGroupMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  /**
   * The membership's whole inbound set (F-027-ch); `[]` sells the pool again.
   * 409 `inbound_assigned_elsewhere` (`facts.groupId`) / `inbound_has_configs` (`facts.configs`).
   */
  async setPanelGroupMemberInbounds(groupId: string, panelId: string, inbounds: string[]): Promise<{ groupId: string; panelId: string; inbounds: string[] }> {
    return call(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}/inbounds`, {
      method: "PUT",
      body: JSON.stringify({ inbounds }),
    });
  },

  /** 409 `member_has_configs` while a live config of the group's Grants is on it: drain it instead (rule 23). */
  /** Delete a group (F-027-ca): 409 `group_has_members` / `group_in_use` while it has members or a variant names it. */
  async deletePanelGroup(id: string): Promise<{ id: string; removed: true }> {
    return call<{ id: string; removed: true }>(`/systems/panel-groups/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async removePanelGroupMember(groupId: string, panelId: string): Promise<RemovedMember> {
    return call<RemovedMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}`, { method: "DELETE" });
  },

  /** Once: a second is 409 `already_draining`. `waitSeconds` is the least the sweep waits from `drainingSince`. */
  async drainPanelGroupMember(groupId: string, panelId: string): Promise<DrainedMember> {
    return call<DrainedMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}/drain`, {
      method: "POST",
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
  | "group_not_found";

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
  /** The payment's own currency (F-116-h3). */
  currencyCode: string;
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
  /** Where it is reached (F-027-by): what the edit form starts from. */
  ipAddress: string | null;
  apiBaseUrl: string | null;
  clientBaseUrl: string | null;
  /** Archived (F-027-bz): kept for its records, skipped by every loop. Null for a panel in service. */
  retiredAt: string | null;
  /** Whether a push panel's RADIUS secret is stored (F-027-az); null on a pull panel. */
  radiusSecretConfigured: boolean | null;
  review: {
    reviewState: PanelReviewState;
    connectionTestedAt: string | null;
    connectionTestFault: ConnectionTestFault | null;
    connectionTestDetail: string | null;
    /** A refused duplicate's holder (F-027-ce); null when none, or when it is outside the reader's scope (F-027-cj). */
    duplicateOf: { id: string; name: string } | null;
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
  eventType: "mass_reset" | "mass_missing" | "mass_rename" | "mass_limit_override" | "foreign_claim";
  /** The panel whose users a `foreign_claim` found; null otherwise, or when it is outside your panels. */
  foreignPanel: { id: string; name: string } | null;
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

/** `network.ConfigProtocol`: what a panel's inbound serves, and so a config placed on it. */
export type ConfigProtocol = "vmess" | "vless" | "trojan" | "shadowsocks" | "hysteria2" | "tuic" | "wireguard" | "openvpn" | "pppoe";
/** `network.PanelGroupMemberRole` — the member's, not the panel's HA `role`. */
export type PanelGroupMemberRole = "primary" | "replica" | "drain";

/** Where a selling setting's effective value came from (billing `selling-settings.ts`, F-027-cg). */
export type SellingLayer = "member" | "panel" | "platform";

/** Each selling setting's effective value and its layer: member -> panel -> platform default. */
export interface EffectiveSellingSettings {
  inboundPlacement: { value: InboundPlacement; layer: SellingLayer };
  maxClients: { value: number | null; layer: SellingLayer };
  priority: { value: number; layer: SellingLayer };
  weight: { value: number; layer: SellingLayer };
}

/**
 * A member as `panel-groups.ts` `wireMember` answers it: its own selling
 * settings (null = inherited from the panel), their `effective` values, and
 * its panel's health beside it.
 */
export interface PanelGroupMember {
  groupId: string;
  panelId: string;
  inboundPlacement: InboundPlacement | null;
  maxClients: number | null;
  priority: number | null;
  weight: number | null;
  effective: EffectiveSellingSettings;
  /** The inbounds assigned to this membership (F-027-ch); `[]` = it sells the panel's pool. */
  inbounds: string[];
  role: PanelGroupMemberRole;
  drainingSince: string | null;
  createdAt: string;
  panelName: string;
  panelState: PanelState;
  reviewState: PanelReviewState;
  lastHealthyAt: string | null;
}

export interface PanelGroup {
  id: string;
  name: string;
  strategy: "mirror" | "priority" | "weighted";
  minHealthyPanels: number;
  subscriptionTtlSeconds: number;
  createdAt: string;
  updatedAt: string;
  /** Variants sold on this group. */
  variantCount: number;
  members: PanelGroupMember[];
}

/** `createPanelGroupSchema`'s fields; `strategy` is never sent (billing rule 21). */
export type PanelGroupBody = Partial<Pick<PanelGroup, "name" | "minHealthyPanels" | "subscriptionTtlSeconds">>;

/** `network.InboundPlacement` (F-114-b): a config on every picked inbound, or one on the emptiest. */
export type InboundPlacement = "all" | "spread";

/** One inbound as `network-service` last read it, the admin's pick, and how many live configs it holds. */
export interface PanelInbound {
  remoteId: string;
  tag: string;
  /** Null: a protocol we do not sell — listed, never sellable. */
  protocol: ConfigProtocol | null;
  port: number;
  host: string;
  enabled: boolean;
  /** When a read stopped listing it; null while it is listed. */
  goneAt: string | null;
  seenAt: string;
  sold: boolean;
  maxClients: number | null;
  clients: number;
  /** The group whose membership holds it (F-027-ch); null = the panel's pool. */
  assignedTo: { id: string; name: string } | null;
}

/** `GET /systems/panels/:id/inbounds` (billing `panel-inbounds.ts`). */
export interface PanelInbounds {
  panelId: string;
  /** The panel's own layer; null = the platform default (F-027-cg). */
  inboundPlacement: InboundPlacement | null;
  maxClients: number | null;
  priority: number | null;
  weight: number | null;
  /** Each value as fulfilment reads it for a member that sets none, with `panel` or `platform`. */
  effective: EffectiveSellingSettings;
  /** Null until the first read, and again after a refresh until the next pass reads. */
  inboundsReadAt: string | null;
  /** Grants with a live config on the panel — what `maxClients` caps. */
  users: number;
  inbounds: PanelInbound[];
}

/** `updatePanelInboundsSchema`: what is left out keeps its value; null hands a setting to the platform default. */
export type PanelInboundsBody = {
  inboundPlacement?: InboundPlacement | null;
  maxClients?: number | null;
  priority?: number | null;
  weight?: number | null;
  inbounds?: { remoteId: string; sold: boolean; maxClients?: number | null }[];
};

/** A member's own selling settings (F-027-cg): any of them, at least one; null inherits the panel's. */
export type MemberSellingBody = Partial<Pick<PanelGroupMember, "inboundPlacement" | "maxClients" | "priority" | "weight">>;

export type DrainedMember = PanelGroupMember & { waitSeconds: number };
export type RemovedMember = { groupId: string; panelId: string; removed: true };

/** billing `updatePanelSchema` (F-027-by): any of these, at least one. `apiBaseUrl` is never cleared. */
export type PanelSettingsBody = Partial<{
  name: string;
  region: string;
  ipAddress: string | null;
  apiBaseUrl: string;
  clientBaseUrl: string | null;
  maxRequestsPerMinute: number;
}>;

export type UpdatedPanel = { id: string; reviewState: PanelReviewState; retest: boolean };

export type RemovedPanel = { id: string; outcome: "deleted" | "archived" };

/** What re-submitting a login answers (F-027-au). `retest`: the next tick tests the panel again. */
export interface ResubmittedLogin {
  id: string;
  reviewState: PanelReviewState;
  retest: boolean;
  credentials: RegisteredPanel["credentials"];
}

/** What re-submitting a push panel's RADIUS secret answers (F-027-az). Nothing is re-tested. */
export interface ResubmittedRadiusSecret {
  id: string;
  reviewState: PanelReviewState;
  radiusSecret: RegisteredPanel["credentials"];
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
  /** A push panel's NAS address, its allowlist entry: required there, never sent for a pull panel (F-027-br). */
  ipAddress?: string;
  apiBaseUrl?: string;
  /** Where users are served their links — Hiddify's client proxy path (F-027-bg). Refused on a push panel. */
  clientBaseUrl?: string;
  driverType: string;
  counterSemantics: string;
  transport: "pull" | "push";
  role: "active" | "passive";
  region: string;
  maxRequestsPerMinute?: number;
  /** The panel's login. Relayed once to the vault and never answered back. */
  credentials: string;
  /** A push panel's RADIUS shared secret (F-027-az): required there, refused on a pull panel. */
  radiusSecret?: string;
}

export interface RegisteredPanel {
  id: string;
  reviewState: "pending";
  credentials: { configured: boolean; version: number | null; rotatedAt: string | null };
  /** Present for a push panel only (F-027-az). */
  radiusSecret?: { configured: boolean; version: number | null; rotatedAt: string | null };
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
  /** Tax on a top-up through this gateway, a percentage; `null` inherits the tenant's default (ADR-0076). */
  taxRatePercent: string | null;
  /** The gateway's own currency: what its limits, fixed fee, fixed modifier and presets are in (F-116-h2). */
  currencyCode: string;
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
  /** `null` inherits the tenant's default tax (ADR-0076). */
  taxRatePercent?: string | null;
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
