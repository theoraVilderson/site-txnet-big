// A reseller's configs moved to another panel as a job (F-311-ae -> billing F-311-ad, D-63).
import { call, type Paged } from "./client";
import type { BulkPanel, JobProgress, MoveTarget } from "./reseller-grants";

/** Every live config on one panel, or of the users ticked (1–500, each once): billing takes exactly one. */
export type ConfigMoveSource = { panelId: string } | { userIds: string[] };

export type ConfigMoveSelection = { source: ConfigMoveSource; toPanelId: string };

export type ConfigMoveBody = ConfigMoveSelection & { requestId: string; reason: string };

/** A `to_panel` config move job as billing's `moveJobView` answers it. */
export interface ConfigMoveJob extends JobProgress {
  id: string;
  requestId: string;
  source: ConfigMoveSource;
  toPanelId: string;
  reason: string;
}

/** One config the job reached; `movedTo` is its new config on the target. */
export type ConfigMoveOutcome = { configId: string; ok: true; movedTo: string | null } | { configId: string; ok: false; reason: string };

export type ConfigMoveOutcomesPage = { rows: ConfigMoveOutcome[]; page: number; pageSize: number; purgedAt: string | null };

/** The sheet's two pickers: the panels the reseller's services are on (the retired included), and the move targets. */
export type ConfigMovePanels = { sources: BulkPanel[]; targets: MoveTarget[] };

/** The move job routes of tenant `tenantId`, all behind billing's move door (`grant.repair`). */
export function configMoveJobsApi(tenantId: string) {
  const at = `/tenants/${encodeURIComponent(tenantId)}/configs/move-jobs`;
  const job = (jobId: string) => `${at}/${encodeURIComponent(jobId)}`;
  const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  return {
    panels: () => call<ConfigMovePanels>(`${at}/panels`, { method: "GET" }),
    /** How many configs the selection takes now: what the confirm shows. */
    count: async (selection: ConfigMoveSelection) => (await call<{ count: number }>(`${at}/count`, json(selection))).count,
    /** 202 the job; a repeated `requestId` answers the same job. */
    start: (body: ConfigMoveBody) => call<ConfigMoveJob>(at, json(body)),
    jobs: (page: number, pageSize: number) =>
      call<Paged<ConfigMoveJob>>(`${at}?${new URLSearchParams({ page: String(page), pageSize: String(pageSize) })}`, { method: "GET" }),
    job: (jobId: string) => call<ConfigMoveJob>(job(jobId), { method: "GET" }),
    /** The refused and failed configs only: what the sheet lists with their reasons. */
    outcomes: (jobId: string, page: number, pageSize: number) =>
      call<ConfigMoveOutcomesPage>(`${job(jobId)}/outcomes?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), problems: "true" })}`, { method: "GET" }),
    /** Stops it: the configs moved stay moved. */
    cancel: (jobId: string) => call<ConfigMoveJob>(`${job(jobId)}/cancel`, { method: "POST" }),
  };
}

export type ConfigMoveJobsApi = ReturnType<typeof configMoveJobsApi>;
