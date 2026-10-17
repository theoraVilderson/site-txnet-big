// Grants moved to another panel group as a job (F-027-ev -> billing F-027-et, ADR-0127 decision 5).
import { call } from "./client";
import type { PanelGroup } from "./panel-groups";
import type { JobProgress } from "./reseller-grants";

/** The Grants ticked (1–500, each once), or every Grant of one group: billing takes exactly one. */
export type GroupMoveSource = { grantIds: string[] } | { fromGroupId: string };

/** A group a move may target: the owner's every group, a reseller's the groups its tenant sells. */
export interface GroupMoveTarget {
  id: string;
  name: string;
}

/** The confirm's figures: the Grants, the configs that keep their link and those that get a new one. */
export interface GroupMoveCount {
  grants: number;
  keep: number;
  move: number;
}

export type GroupMoveBody = { requestId: string; source: GroupMoveSource; toGroupId: string; reason: string };

/** A `to_group` config move job as billing's `moveJobView` answers it. */
export interface GroupMoveJob extends JobProgress {
  id: string;
  requestId: string;
  source: GroupMoveSource;
  toGroupId: string;
  reason: string;
}

/** An item of a group move is a Grant (`GrantMoveOutcome`). */
export type GroupMoveOutcome = { grantId: string; ok: true } | { grantId: string; ok: false; reason: string };

export type GroupMoveOutcomesPage = { rows: GroupMoveOutcome[]; page: number; pageSize: number; purgedAt: string | null };

/** One door's calls; the sheet takes either, so it never asks who is moving. */
export interface GroupMovesApi {
  targets(): Promise<GroupMoveTarget[]>;
  count(selection: { source: GroupMoveSource; toGroupId: string }): Promise<GroupMoveCount>;
  /** 202 the job; a repeated `requestId` answers the same job. */
  start(body: GroupMoveBody): Promise<GroupMoveJob>;
  job(jobId: string): Promise<GroupMoveJob>;
  /** The refused and failed Grants only: what the sheet lists with their reasons. */
  outcomes(jobId: string, page: number, pageSize: number): Promise<GroupMoveOutcomesPage>;
  /** Stops it: the Grants moved stay moved. */
  cancel(jobId: string): Promise<GroupMoveJob>;
}

function movesAt(at: string, targets: () => Promise<GroupMoveTarget[]>): GroupMovesApi {
  const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  const job = (jobId: string) => `${at}/${encodeURIComponent(jobId)}`;
  return {
    targets,
    count: (selection) => call<GroupMoveCount>(`${at}/count`, json(selection)),
    start: (body) => call<GroupMoveJob>(at, json(body)),
    job: (jobId) => call<GroupMoveJob>(job(jobId), { method: "GET" }),
    outcomes: (jobId, page, pageSize) =>
      call<GroupMoveOutcomesPage>(`${job(jobId)}/outcomes?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), problems: "true" })}`, { method: "GET" }),
    cancel: (jobId) => call<GroupMoveJob>(`${job(jobId)}/cancel`, { method: "POST" }),
  };
}

/** The platform owner's door (`panelScopeOf`): any tenant's Grants, any group. */
export function systemsGroupMovesApi(): GroupMovesApi {
  return movesAt("/systems/grant-group-moves", async () =>
    (await call<PanelGroup[]>("/systems/panel-groups", { method: "GET" })).map((g) => ({ id: g.id, name: g.name })),
  );
}

/** A reseller's door (`grant.assign`): its own Grants, into a group its tenant sells. */
export function resellerGroupMovesApi(tenantId: string): GroupMovesApi {
  const at = `/tenants/${encodeURIComponent(tenantId)}/grant-group-moves`;
  return movesAt(at, async () => (await call<{ groups: GroupMoveTarget[] }>(`${at}/groups`, { method: "GET" })).groups);
}
