// A reseller's data export (F-212-a, tenant `contract.data-export.md`): its own
// module beside `tenant-api.ts`, on the same tenant-service caller.
import { call } from "./tenant-call";

/** `queued` → `building` → `ready` → `expired`, or `failed` (contract "The routes"). */
export type DataExportStatus = "queued" | "building" | "ready" | "expired" | "failed";

/** One export, as `GET /api/tenants/:id/data-exports` lists it. */
export interface DataExportView {
  id: string;
  status: DataExportStatus;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
}

/** The newest ten, and when the next may be asked for — `null` when one may be now (rule 2, once per 24 h). */
export interface DataExportList {
  exports: DataExportView[];
  nextAllowedAt: string | null;
}

/** A signed path on the caller's own host, good for five minutes; minted per download and audited (rule 3). */
export interface DataExportLink {
  url: string;
  expiresAt: string;
}

const base = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/data-exports`;

/** The three routes, each admitting the reseller's owner or platform staff only (`ResellerAccess`, invariant 21). */
export const tenantDataExportApi = {
  async list(tenantId: string): Promise<DataExportList> {
    return call<DataExportList>(base(tenantId), { method: "GET" });
  },
  /** 202 with the queued export; `export_too_soon` (429) inside the 24 h. */
  async request(tenantId: string): Promise<DataExportView> {
    return call<DataExportView>(base(tenantId), { method: "POST" });
  },
  async link(tenantId: string, exportId: string): Promise<DataExportLink> {
    return call<DataExportLink>(`${base(tenantId)}/${encodeURIComponent(exportId)}/link`, { method: "POST" });
  },
};
