// A reseller's users' Grants, limits, revenue and bulk jobs, scoped by tenant id (F-311-v, F-019-r).
import { type Paged, call } from "./client";
import type { ConfigActionRefusal, GrantRow, GrantScope, GrantStatus, GrantUsage, GrantsPage, UserConfigRow } from "./grants";

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

/** The metered cap as staff read it (F-118-ap): billing computes `effective`, never the panel. */
export interface TenantGrantLimit {
  platformDefault: number;
  /** The tenant's own default, or `null` when the platform's applies. */
  tenantDefault: number | null;
  effective: number;
  /** The reseller's ceiling (F-019-n): nothing is in effect above it; absent or null: none. */
  ceiling?: number | null;
}

export interface UserGrantLimit {
  userId: string;
  /** The number staff set for this user, or `null` when a default applies. */
  own: { meteredOpenCap: number; reason: string | null; setByUserId: string; updatedAt: string } | null;
  tenantDefault: number | null;
  platformDefault: number;
  effective: number;
  /** The reseller's ceiling (F-019-n); absent or null: none. */
  ceiling?: number | null;
  /** Open pay-as-you-go services the user holds now. */
  open: number;
}

/** Days and bytes (a string: past 2^53 a number loses them) per Grant over the window (KS-1-c). */
export interface CompensationFigures {
  days: number;
  bytes: string;
}

/** The compensation cap (KS-1-c): billing says which one is in effect, never the panel. */
export interface CompensationCap {
  /** The tenant's own, or `null` when the platform's applies. */
  own: CompensationFigures | null;
  platform: CompensationFigures;
  effective: CompensationFigures;
  windowDays: number;
}

/**
 * How many open pay-as-you-go services a user may hold (F-118-ap,
 * `entitlement/contract.limits.md`): the tenant's default and one user's own
 * number, on the users-admin door by the **path's** tenant. Every answer is
 * the whole view, so a save shows what billing kept.
 */
export function grantLimitsApi(tenantId: string) {
  const at = `/tenants/${encodeURIComponent(tenantId)}`;
  const user = (userId: string) => `${at}/users/${encodeURIComponent(userId)}/grant-limit`;
  return {
    tenant: () => call<TenantGrantLimit>(`${at}/grant-limits`, { method: "GET" }),
    /** `null` goes back to the platform's default. */
    setTenant: (meteredOpenCap: number | null) =>
      call<TenantGrantLimit>(`${at}/grant-limits`, { method: "PUT", body: JSON.stringify({ meteredOpenCap }) }),
    /** Read only: their own number is the `metered_services_max` restriction (F-030-e, `userRestrictionsApi`). */
    user: (userId: string) => call<UserGrantLimit>(user(userId), { method: "GET" }),
    /** What `grant.compensate` may add per Grant over 30 days (KS-1-c): read with it or `grant.assign`. */
    compensation: () => call<CompensationCap>(`${at}/compensation-cap`, { method: "GET" }),
    /** Set with `grant.assign` only; `null` goes back to the platform's default. */
    setCompensation: (cap: { days: number; gb: number } | null) =>
      call<CompensationCap>(`${at}/compensation-cap`, { method: "PUT", body: JSON.stringify({ cap }) }),
  };
}

/**
 * A reseller's services across all its users (F-311-t, -u): `/tenants/:tenantId/grants`,
 * no user in the path — the paste or the ticked ids name them, each fenced by
 * the reseller's tenant (C-15).
 */
/**
 * A reseller's own revenue over a window (F-311-b, billing `reseller-revenue.controller.ts`):
 * what it sold and what its users paid in. `total` is in `currencyCode`, the
 * reseller's operating currency, and `null` when a currency it was written in
 * has no way into it. The door is `ResellerAccess`'s figures door: a
 * reseller's owner, member or the platform's staff, and the platform's own
 * tenant to its staff (UX-1-r2).
 */
export interface ResellerRevenueTotals {
  from: string;
  to: string;
  currencyCode: string;
  sales: { total: string | null; count: number };
  topUps: { total: string | null; count: number };
  /** The platform's own tenant only (UX-1-r3): what it charged its resellers, and what they paid in. */
  fromResellers?: { charged: { total: string | null; count: number }; paidIn: { total: string | null; count: number } };
}

export const resellerRevenueApi = {
  /** `from`/`to` are instants; billing refuses a window over 366 days. */
  async totals(tenantId: string, window: { from: string; to: string }): Promise<ResellerRevenueTotals> {
    const q = new URLSearchParams(window).toString();
    return call<ResellerRevenueTotals>(`/tenants/${encodeURIComponent(tenantId)}/revenue?${q}`, { method: "GET" });
  },
};

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
     * `forUser`: only what may be issued to that user — a product sold to groups they are in none of is left out (PT-1-b).
     */
    usersCatalog: async (forUser?: string) =>
      (
        await call<{ products: UsersCatalogProduct[] }>(
          `${resellerUsersCatalogPath(tenantId)}${forUser ? `?userId=${encodeURIComponent(forUser)}` : ""}`,
          { method: "GET" },
        )
      ).products,
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
