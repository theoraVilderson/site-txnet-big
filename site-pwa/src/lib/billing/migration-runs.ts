// A reseller's import from another panel (F-201-f, D-63), of one user from
// an old link (F-201-h-1), or of its users' balances from a file (F-209-b):
// billing's `/tenants/:id/migration-runs` (entitlement `contract.import.md`,
// `contract.link-import.md`, billing `contract.balance-import.md`) and the
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
  /** A panel run's family; null on a link run. */
  sourceFamily: string | null;
  /** A panel run's origin; a link run's whole old link — its path is its owner's token, never shown; null on a balance file's run. */
  sourceAddress: string | null;
  status: MigrationRunStatus;
  failureReason: string | null;
  plannedCreate: number;
  plannedUpdate: number;
  plannedSkip: number;
  committedItems: number;
  failedItems: number;
  rollbackUntil: string | null;
  snapshotsPurgedAt: string | null;
  /** The person a link run is for; null on a panel run. */
  userId: string | null;
  /** The prepaid plan a link run's client becomes, chosen by the admin; null until then. */
  variantId: string | null;
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
  /** A link run's admin over what the link said; each null keeps the read figure. */
  corrected: { dataLimitBytes: number | null; usedBytes: number | null; expiresAt: string | null };
  /** A balance file's row: its line, the amount and currency as read; each null on another run's row, and once purged. */
  balance: { line: number | null; amount: string | null; currency: string | null };
}

/** What a link run's correction sends: a field left out keeps its value, null clears it (entitlement `contract.link-import.md`). */
export interface LinkCorrectionBody {
  variantId?: string | null;
  dataLimitBytes?: number | null;
  usedBytes?: number | null;
  expiresAt?: string | null;
}

/** An old panel's subscription host the reseller's imported users hold links on (F-204-b). */
export interface LegacyHost {
  host: string;
  links: number;
}

/** One imported link fetched from outside: the servers it carried, or network's reason it did not answer. */
export type LegacyTestResult = { host: string; label: string | null } & ({ outcome: "ok"; servers: number } | { outcome: "failed"; reason: string });

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
    /** One person's import from their old link; billing reads it at once (F-201-g). */
    createLink: (body: { url: string; userId: string }) => call<MigrationRun>(at, { method: "POST", body: JSON.stringify(body) }),
    /** A reseller's balances from a file's text; billing answers it previewed, with its report (F-209-a). */
    createCsv: (csv: string) => call<MigrationRun>(at, { method: "POST", body: JSON.stringify({ csv }) }),
    /** A previewed link run's product and corrected figures; billing re-plans its one item. */
    correctLink: (runId: string, body: LinkCorrectionBody) => call<MigrationRun>(`${run(runId)}/link`, { method: "PUT", body: JSON.stringify(body) }),
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
    /** Tenant-wide, most links first: two imports of one old panel share a host. */
    legacyHosts: () => call<{ hosts: LegacyHost[] }>(`${at}/legacy-hosts`, { method: "GET" }),
    /** One imported link on a verified old host, fetched from outside as an app would (F-204-b). */
    testLegacyHost: (host: string) => call<LegacyTestResult>(`${at}/legacy-hosts/test`, { method: "POST", body: JSON.stringify({ host }) }),
    /** Sealed on tenant-service; never read back — the answer is `{configured, expiresAt}` (rule 3). */
    storeLogin: (runId: string, body: SourceLoginBody) =>
      tenantCall<{ configured: true; expiresAt: string }>(`/tenants/${encodeURIComponent(tenantId)}/migration-runs/${encodeURIComponent(runId)}/source-login`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
  };
}

export type MigrationRunsApi = ReturnType<typeof migrationRunsApi>;
