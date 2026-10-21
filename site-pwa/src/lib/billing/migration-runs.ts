// A reseller's import from another panel (F-201-f, D-63): billing's
// `/tenants/:id/migration-runs` (entitlement `contract.import.md`) and the
// source login, stored on tenant-service (tenant `contract.source-login.md`).
import { call as tenantCall } from "../tenant-call";
import { call, type Paged } from "./client";

/** `migration_run.status` (entitlement `MigrationRunStatus`). */
export type MigrationRunStatus =
  | "draft"
  | "previewing"
  | "previewed"
  | "committing"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "cancelled"
  | "expired";

/** One source inbound, with the variant the reseller mapped it to (null: none yet). */
export interface MigrationInbound {
  inboundRemoteId: string;
  tag: string;
  protocol: string;
  clientCount: number;
  variantId: string | null;
}

/** A run as billing's `runView` answers it; `inbounds` only on one run. */
export interface MigrationRun {
  id: string;
  kind: "panel" | "link" | "csv";
  sourceFamily: string;
  sourceAddress: string;
  status: MigrationRunStatus;
  failureReason: string | null;
  plannedCreate: number;
  plannedUpdate: number;
  plannedSkip: number;
  committedItems: number;
  failedItems: number;
  rollbackUntil: string | null;
  snapshotsPurgedAt: string | null;
  createdAt: string;
  updatedAt: string;
  inbounds?: MigrationInbound[];
}

/**
 * What the source said of one client, read from the item's snapshot: every
 * cell null for an unreadable client, and for every client once the rollback
 * window ends and the snapshots are cleared (rule 28). 0 bytes is unlimited.
 */
export interface MigrationSourceCells {
  inboundRemoteId: string | null;
  protocol: string | null;
  enabled: boolean | null;
  dataLimitBytes: number | null;
  usedBytes: number | null;
  expiresAt: string | null;
}

/** One row of the report's per-user table (`MigrationItemView`): the source's cells, the plan and what it came to. */
export interface MigrationItem extends MigrationSourceCells {
  remoteIdentity: string;
  label: string;
  plannedAction: "create" | "update" | "skip";
  skipReason: string | null;
  outcome: "pending" | "created" | "updated" | "skipped" | "failed" | "rolled_back" | "kept";
  failureReason: string | null;
  keptReason: string | null;
}

/** What is sealed in the vault for one run: the full address (its web path too) and the login in the family's form. */
export interface SourceLoginBody {
  apiBaseUrl: string;
  clientBaseUrl?: string;
  login: string;
}

/** One reseller's import calls, by the path's tenant — never the session's (ADR-0064). */
export function migrationRunsApi(tenantId: string) {
  const at = `/tenants/${encodeURIComponent(tenantId)}/migration-runs`;
  const run = (runId: string) => `${at}/${encodeURIComponent(runId)}`;
  const post = (path: string) => call<MigrationRun>(path, { method: "POST" });
  return {
    create: (body: { family: string; sourceAddress: string }) => call<MigrationRun>(at, { method: "POST", body: JSON.stringify(body) }),
    list: (page: number, pageSize: number) =>
      call<Paged<MigrationRun>>(`${at}?${new URLSearchParams({ page: String(page), pageSize: String(pageSize) })}`, { method: "GET" }),
    get: (runId: string) => call<MigrationRun>(run(runId), { method: "GET" }),
    /** A previewed run's mapping changed is previewed again by billing. */
    setInbounds: (runId: string, inbounds: { inboundRemoteId: string; variantId: string | null }[]) =>
      call<MigrationRun>(`${run(runId)}/inbounds`, { method: "PUT", body: JSON.stringify({ inbounds }) }),
    preview: (runId: string) => post(`${run(runId)}/preview`),
    commit: (runId: string) => post(`${run(runId)}/commit`),
    rollback: (runId: string) => post(`${run(runId)}/rollback`),
    cancel: (runId: string) => post(`${run(runId)}/cancel`),
    /** `problems`: the skipped, the failed and what a rollback kept, only. */
    outcomes: (runId: string, page: number, pageSize: number, problems: boolean) =>
      call<Paged<MigrationItem>>(
        `${run(runId)}/outcomes?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), problems: String(problems) })}`,
        { method: "GET" },
      ),
    /** Sealed on tenant-service; never read back — the answer is `{configured, expiresAt}` (rule 3). */
    storeLogin: (runId: string, body: SourceLoginBody) =>
      tenantCall<{ configured: true; expiresAt: string }>(`/tenants/${encodeURIComponent(tenantId)}/migration-runs/${encodeURIComponent(runId)}/source-login`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
  };
}

export type MigrationRunsApi = ReturnType<typeof migrationRunsApi>;
