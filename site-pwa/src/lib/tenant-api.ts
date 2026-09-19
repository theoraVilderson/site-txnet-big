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
  includedFeatureKeys: string[];
  isActive: boolean;
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
};

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
 * object, not a member of {@link tenantApi}: these three routes take no
 * permission key and admit any user of the platform owner's tenant, where
 * every route above wants `tenant.manage`.
 */
export const resellerPurchaseApi = {
  /** The packages on sale, by name. Shares a rate-limit budget with {@link suggestSlug}. */
  async packages(): Promise<PackageOffer[]> {
    return call<PackageOffer[]>("/tenants/purchase/packages", { method: "GET" });
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
