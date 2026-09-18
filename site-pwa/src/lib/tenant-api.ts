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
