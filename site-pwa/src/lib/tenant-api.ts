// Tenant administration (F-018-c/e/f) is served by tenant-service on its own
// public paths, `/api/tenants` and `/api/tenant-packages` on the page's own
// domain (ADR-0058, ADR-0060). The access token as a Bearer header, exactly as
// `billing-api.ts` calls billing: the same gate, the same credential.
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const call = createApiClient({
  baseUrl: API_BASE,
  service: "tenant-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});

/** Prisma's `TenantStatus`. */
export type TenantStatus = "trial" | "active" | "suspended" | "terminated";
/** The periods a reseller is created or subscribed on (D-41: no metering). */
export type ResellerBillingModel = "subscription_monthly" | "subscription_yearly";
/** What `PUT /tenants/:id/status` takes: `trial` is only ever a start. */
export type SettableStatus = Exclude<TenantStatus, "trial">;

/** A reseller view (`tenant/contract.admin.md` "Routes"). */
export interface Reseller {
  id: string;
  slug: string;
  status: TenantStatus;
  billingModel: ResellerBillingModel | "pay_as_you_go_metered";
  createdAt: string;
  owner: { id: string; fullName: string; username: string; phoneNumber: string | null } | null;
  domains: { domainValue: string; domainType: string; purpose: string; verificationStatus: string }[];
  /** The billing wallet's `cachedBalance`, a decimal string (C-02). */
  billingBalance: string;
  /** What `billingBalance` is in: the wallet's; the platform's with none yet (F-116-h2). */
  billingCurrencyCode: string;
}

export interface CreateResellerBody {
  slug: string;
  billingModel: ResellerBillingModel;
  ownerUserId: string;
}

/** A package view (F-018-d). A price is a decimal string, `null` when not sold for that period. */
export interface TenantPackage {
  id: string;
  name: string;
  monthlyPrice: string | null;
  yearlyPrice: string | null;
  /** What both prices are in: the package's own, the platform's (F-116-h3). */
  currencyCode: string;
  includedFeatureKeys: string[];
  isActive: boolean;
  /** The wholesale rates in force, one per meter (F-118-n1), in `currencyCode`. */
  meterRates: PackageMeterRate[];
}

/**
 * What the platform charges a reseller on a package for `unitSize` of a
 * platform meter (F-118-n1) — 2^30 bytes for a GiB of `vpn.traffic`. Strings:
 * `unitSize` passes 2^53, `unitPrice` has 8 places.
 */
export interface PackageMeterRate {
  meterKey: string;
  unitSize: string;
  unitPrice: string;
  currencyCode: string;
  effectiveFrom: string;
}

/** A rate as the package routes take it; on an edit `unitPrice: null` switches the meter off. */
export type MeterRateInput = { meterKey: string; unitSize: string; unitPrice: string };
export type MeterRateEdit = MeterRateInput | { meterKey: string; unitPrice: null };

/** `POST /tenant-packages`, `.strict()`: at least one of the two prices. */
export interface CreatePackageBody {
  name: string;
  monthlyPrice?: string;
  yearlyPrice?: string;
  includedFeatureKeys: string[];
  meterRates?: MeterRateInput[];
}

/** `PATCH /tenant-packages/:id`: only what changed; a price may be `null`. */
export interface UpdatePackageBody {
  name?: string;
  monthlyPrice?: string | null;
  yearlyPrice?: string | null;
  includedFeatureKeys?: string[];
  isActive?: boolean;
  meterRates?: MeterRateEdit[];
}

/** What `apply` answers: the list forced on every subscriber, and how many. */
export interface PackageApplied {
  packageId: string;
  includedFeatureKeys: string[];
  subscribers: number;
}

/** A subscription view (F-018-e). */
export interface TenantSubscription {
  tenantId: string;
  packageId: string;
  packageName: string;
  billingModel: ResellerBillingModel;
  currentPeriodEnd: string;
  startedAt: string;
  includedFeatureKeys: string[];
}

/**
 * A package as the purchase offers it (F-019-i). Not {@link TenantPackage}:
 * `GET /tenants/purchase/packages` answers a buyer, so it lists the active
 * ones only and carries no `isActive`.
 */
export interface PackageOffer {
  id: string;
  name: string;
  monthlyPrice: string | null;
  yearlyPrice: string | null;
  /** What both prices are in (F-116-h3). */
  currencyCode: string;
  includedFeatureKeys: string[];
}

/** `POST /tenants/purchase`'s body. The route is `.strict()`: `slug` is sent only when the buyer kept one. */
export interface PurchaseBody {
  packageId: string;
  billingModel: ResellerBillingModel;
  name: string;
  slug?: string;
}

/** What the purchase answers: the new reseller, plus what it cost and what is left. */
export type Purchased = Reseller & {
  packageId: string;
  currentPeriodEnd: string;
  /** What was taken from the buyer's wallet, a decimal string (C-02). */
  charged: string;
  /** The buyer's wallet balance after the charge. */
  walletBalance: string;
  /** What `charged` and `walletBalance` are in: the buyer's wallet's (F-116-h2). */
  currencyCode: string;
};

/**
 * `GET /tenants/purchase/mine` (F-019-l): the reseller the caller already
 * holds — the same "live" the purchase's `already_reseller` counts. `package`
 * and `currentPeriodEnd` are null only for one never put on a package.
 */
export interface OwnedReseller {
  id: string;
  slug: string;
  status: TenantStatus;
  billingModel: Reseller["billingModel"];
  package: { id: string; name: string } | null;
  currentPeriodEnd: string | null;
  domains: Reseller["domains"];
}

export interface StatusChange {
  tenantId: string;
  status: TenantStatus;
  suspensionCause: string | null;
  suspendedAt: string | null;
  graceEndsAt: string | null;
  suspendedReason: string | null;
}

export const tenantApi = {
  /** Newest first; the route answers a plain page, no total. */
  async resellers(limit: number, offset: number): Promise<Reseller[]> {
    return call<Reseller[]>(`/tenants?limit=${limit}&offset=${offset}`, { method: "GET" });
  },
  async reseller(id: string): Promise<Reseller> {
    return call<Reseller>(`/tenants/${encodeURIComponent(id)}`, { method: "GET" });
  },
  async createReseller(body: CreateResellerBody): Promise<Reseller> {
    return call<Reseller>("/tenants", { method: "POST", body: JSON.stringify(body) });
  },
  /** `subscription_not_found` (404) is the normal answer for a reseller not on a package yet. */
  async subscription(id: string): Promise<TenantSubscription> {
    return call<TenantSubscription>(`/tenants/${encodeURIComponent(id)}/subscription`, { method: "GET" });
  },
  async setSubscription(id: string, body: { packageId: string; billingModel: ResellerBillingModel }): Promise<TenantSubscription> {
    return call<TenantSubscription>(`/tenants/${encodeURIComponent(id)}/subscription`, { method: "PUT", body: JSON.stringify(body) });
  },
  async setStatus(id: string, body: { status: SettableStatus; reason?: string }): Promise<StatusChange> {
    return call<StatusChange>(`/tenants/${encodeURIComponent(id)}/status`, { method: "PUT", body: JSON.stringify(body) });
  },
  /** Every package, active or not: a reseller may stay on a deactivated one. */
  async packages(): Promise<TenantPackage[]> {
    return call<TenantPackage[]>("/tenant-packages", { method: "GET" });
  },
  async createPackage(body: CreatePackageBody): Promise<TenantPackage> {
    return call<TenantPackage>("/tenant-packages", { method: "POST", body: JSON.stringify(body) });
  },
  async updatePackage(id: string, body: UpdatePackageBody): Promise<TenantPackage> {
    return call<TenantPackage>(`/tenant-packages/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  /** Every subscriber's package features replaced by the package's now, removals included (F-018-o). */
  async applyPackage(id: string): Promise<PackageApplied> {
    return call<PackageApplied>(`/tenant-packages/${encodeURIComponent(id)}/apply`, { method: "POST" });
  },
};

/** A reseller limit key (ADR-0106): shared-core's `RESELLER_LIMITS`; `resellers/_lib/limits.ts` holds the list. */
export type ResellerLimitKey = "user_metered_cap_max" | "platform_open_grants_max" | "admin_issues_30d_max" | "custom_domains_max" | "staff_members_max" | "bulk_job_grants_max" | "campaign_sends_daily_max";

/** `GET /tenants/limits/settings`: one key, every level that sets it. A `value` null is no limit; `platform` null is "not set" (the code default). */
export interface ResellerLimitRow {
  key: ResellerLimitKey;
  codeDefault: number | null;
  max: number;
  platform: { value: number | null } | null;
  packages: { packageId: string; name: string; value: number | null }[];
  resellers: { tenantId: string; slug: string; value: number | null; reason: string }[];
}

/** Where a reseller's limit in effect came from. */
export type ResellerLimitSource = "reseller" | "package" | "platform" | "default" | "exempt";

/** `GET /tenants/:id/limits`: the resolver's answer for one reseller; `limit` null is no limit. */
export interface ResellerLimitInEffect {
  key: ResellerLimitKey;
  limit: number | null;
  source: ResellerLimitSource;
  /** What the reseller holds of it — the count its refusal compares; `null` for a key that counts nothing (F-019-s). */
  used: number | null;
}

/**
 * Reseller limits at three levels (F-019-m/r, ADR-0106) — the platform
 * owner's. `value` null is no limit; clearing a level hands the key to the
 * next one down.
 */
export const resellerLimitsApi = {
  table: () => call<ResellerLimitRow[]>("/tenants/limits/settings", { method: "GET" }),
  ofReseller: (tenantId: string) => call<ResellerLimitInEffect[]>(`/tenants/${encodeURIComponent(tenantId)}/limits`, { method: "GET" }),
  setPlatform: (key: ResellerLimitKey, value: number | null) =>
    call<void>(`/tenants/limits/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) }),
  clearPlatform: (key: ResellerLimitKey) => call<void>(`/tenants/limits/settings/${key}`, { method: "DELETE" }),
  setPackage: (packageId: string, key: ResellerLimitKey, value: number | null) =>
    call<void>(`/tenants/limits/packages/${encodeURIComponent(packageId)}/${key}`, { method: "PUT", body: JSON.stringify({ value }) }),
  clearPackage: (packageId: string, key: ResellerLimitKey) =>
    call<void>(`/tenants/limits/packages/${encodeURIComponent(packageId)}/${key}`, { method: "DELETE" }),
  /** One or several resellers at once, all or none, with a reason kept on each. */
  setResellers: (key: ResellerLimitKey, tenantIds: string[], value: number | null, reason: string) =>
    call<{ key: ResellerLimitKey; value: number | null; tenantIds: string[] }>(`/tenants/limits/resellers/${key}`, {
      method: "PUT",
      body: JSON.stringify({ tenantIds, value, reason }),
    }),
  clearResellers: (key: ResellerLimitKey, tenantIds: string[]) =>
    call<{ key: ResellerLimitKey; cleared: number }>(`/tenants/limits/resellers/${key}/clear`, { method: "POST", body: JSON.stringify({ tenantIds }) }),
};

/** A custom domain as the reseller sees it; `revalidating` is `verified` inside its grace. */
export type DomainStatus = "pending" | "verifying" | "verified" | "revalidating" | "failed";
/** Prisma's `TenantDomainPurpose`. */
export type DomainPurpose = "panel" | "subscription" | "assets";
export type CheckName = "txt" | "cname" | "http" | "https";
/** One line of a check: what it expected, what it found (`tenant/contract.domains.md` "What a check is"). */
export interface CheckLine {
  check: CheckName;
  expected: string[];
  found: string[];
  ok: boolean;
}

/** The domain view (`tenant/contract.domains.md` "The routes"). */
export interface ResellerDomain {
  id: string;
  domainValue: string;
  purpose: DomainPurpose;
  status: DomainStatus;
  /** The record to publish at the reseller's own DNS provider. */
  record: { type: "TXT"; name: string; value: string };
  /** Where the domain, or its CDN's origin, points. */
  cnameTarget: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheck: { at: string; ok: boolean; lines: CheckLine[] } | null;
}

/**
 * A reseller's custom domains (F-018-i), by the reseller the path names
 * (ADR-0064): the owner, a staff seat with `tenant.manage`, or platform staff
 * are admitted there (invariant 21) — so no permission key is checked here.
 */
/** A step of the checklist (`tenant/contract.onboarding.md` "The checklist"). */
export type OnboardingStepKey = "domain" | "gateway" | "bot" | "pricing";

/** `GET /api/tenants/:id/onboarding`: every field computed from live rows, nothing stored. */
export interface ResellerOnboarding {
  tenantId: string;
  /** The gate: true while no panel domain is proved. The same answer the guard enforces. */
  onboarding: boolean;
  /** What the gate closes while `onboarding`; empty otherwise. */
  closed: string[];
  steps: { key: OnboardingStepKey; done: boolean; gate: boolean }[];
  /** Every step done — a reseller can be open well before this. */
  complete: boolean;
}

/** The onboarding checklist (F-018-l), admitted by the path's reseller (invariant 21) as a `read`. */
export const resellerOnboardingApi = {
  async get(tenantId: string): Promise<ResellerOnboarding> {
    return call<ResellerOnboarding>(`/tenants/${encodeURIComponent(tenantId)}/onboarding`, { method: "GET" });
  },
};

/**
 * The door's verdict on the caller for one tenant (F-311-e): never refuses, a
 * refused caller gets `canRead: false`. Uncached — a seat revoked a second ago
 * must stop administering.
 */
export interface TenantAccess {
  tenantId: string;
  canRead: boolean;
  canWrite: boolean;
  reason?: string;
}

export const tenantAccessApi = {
  async get(tenantId: string): Promise<TenantAccess> {
    return call<TenantAccess>(`/tenants/${encodeURIComponent(tenantId)}/access`, { method: "GET" });
  },
};

/** A currency a tenant may keep its books in (`tenant/contract.currency.md` rule 2). */
export interface CurrencyChoice {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
}

export interface OperatingCurrency {
  code: string;
  choices: CurrencyChoice[];
}

/** shared-core's `CurrencyChangeSummary`: how many live rows of each kind a change converted. */
export type CurrencyChangeSummary = Record<
  | "wallets"
  | "prices"
  | "meteredRates"
  | "grants"
  | "coupons"
  | "rules"
  | "depositSettings"
  | "gateways"
  | "invoicesCancelled"
  | "billingWallets"
  | "packages"
  | "usageMeters",
  number
>;

/** A set's answer: `conversion` is `null` when the code was already the tenant's (rule 4). */
export interface OperatingCurrencyChange extends OperatingCurrency {
  conversion: { changeId: string; fromCode: string; rate: string; summary: CurrencyChangeSummary } | null;
}

/**
 * A tenant's operating currency (F-116-a/f, ADR-0098). The same two routes
 * serve a reseller — admitted by the path's reseller (invariant 21) — and the
 * platform's own tenant, which only its staff with `tenant.manage` may read.
 */
export const operatingCurrencyApi = {
  async get(tenantId: string): Promise<OperatingCurrency> {
    return call<OperatingCurrency>(`/tenants/${encodeURIComponent(tenantId)}/operating-currency`, { method: "GET" });
  },
  /** Converts the tenant's live money at one rate snapshot (F-116-f); history keeps its currency. */
  async set(tenantId: string, code: string): Promise<OperatingCurrencyChange> {
    return call<OperatingCurrencyChange>(`/tenants/${encodeURIComponent(tenantId)}/operating-currency`, {
      method: "PUT",
      body: JSON.stringify({ code }),
    });
  },
};

/** shared-core's `LineNameTemplateProblem`: why a line-name template would be refused. */
export type LineNameTemplateProblem = "too_long" | "unknown_placeholder" | "control_character";

/** The part of the branding view this panel edits (`tenant/contract.branding.md`). */
export interface ResellerBranding {
  brandName: string;
  /** The default name of a config line in a buyer's app (F-307-j); `null` is the platform's `{region}`. */
  lineNameTemplate: string | null;
}

/** One line's name under a template, evaluated by tenant-service, or why it would be refused. */
export interface LineNamePreview {
  name: string | null;
  problem: LineNameTemplateProblem | null;
}

export const resellerBrandingApi = {
  async get(tenantId: string): Promise<ResellerBranding> {
    return call<ResellerBranding>(`/tenants/${encodeURIComponent(tenantId)}/branding`, { method: "GET" });
  },
  /** Its own route: the whole-text `PUT` would clear what it is not sent. `null` is the platform default. */
  async setLineNameTemplate(tenantId: string, template: string | null): Promise<ResellerBranding> {
    return call<ResellerBranding>(`/tenants/${encodeURIComponent(tenantId)}/branding/line-name-template`, {
      method: "PUT",
      body: JSON.stringify({ template }),
    });
  },
  /** Writes nothing. The panel never builds a line's name itself (ADR-0089). */
  async previewLineName(tenantId: string, template: string | null, region: string): Promise<LineNamePreview> {
    return call<LineNamePreview>(`/tenants/${encodeURIComponent(tenantId)}/branding/line-name-template/preview`, {
      method: "POST",
      body: JSON.stringify({ template, region }),
    });
  },
};

export const resellerDomainsApi = {
  async list(tenantId: string): Promise<ResellerDomain[]> {
    return call<ResellerDomain[]>(`/tenants/${encodeURIComponent(tenantId)}/domains`, { method: "GET" });
  },
  async add(tenantId: string, body: { domainValue: string; purpose: DomainPurpose }): Promise<ResellerDomain> {
    return call<ResellerDomain>(`/tenants/${encodeURIComponent(tenantId)}/domains`, { method: "POST", body: JSON.stringify(body) });
  },
  /** `pending` / `failed` -> `verifying`; the sweep does the checking, within five minutes. */
  async check(tenantId: string, domainId: string): Promise<ResellerDomain> {
    return call<ResellerDomain>(
      `/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domainId)}/check`,
      { method: "POST" },
    );
  },
};

/**
 * A platform user buying a reseller of their own (F-019-i,
 * `tenant/contract.admin.md` "A platform user buys a reseller"). Its own
 * object, not a member of {@link tenantApi}: these four routes take no
 * permission key and admit any user of the platform owner's tenant, where
 * every route above wants `tenant.manage`.
 */
export const resellerPurchaseApi = {
  /** The packages on sale, by name. Shares a rate-limit budget with {@link suggestSlug}. */
  async packages(): Promise<PackageOffer[]> {
    return call<PackageOffer[]>("/tenants/purchase/packages", { method: "GET" });
  },
  /** The reseller the caller already holds, or `null` — a 200 either way (F-019-l). Shares the read budget. */
  async mine(): Promise<{ reseller: OwnedReseller | null }> {
    return call<{ reseller: OwnedReseller | null }>("/tenants/purchase/mine", { method: "GET" });
  },
  /** The address `name` suggests. A suggestion only: the purchase checks it again. */
  async suggestSlug(name: string): Promise<{ slug: string }> {
    return call<{ slug: string }>(`/tenants/purchase/slug?name=${encodeURIComponent(name)}`, { method: "GET" });
  },
  /** Pays the first period from the buyer's wallet and opens the reseller `active` (ADR-0061). */
  async purchase(body: PurchaseBody): Promise<Purchased> {
    return call<Purchased>("/tenants/purchase", { method: "POST", body: JSON.stringify(body) });
  },
};
