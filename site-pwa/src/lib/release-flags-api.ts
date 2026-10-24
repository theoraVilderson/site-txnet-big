import { call } from "./tenant-call";

/** tenant-service's `ReleaseFlagStage`, in its order (OPS-1-ag, `tenant/contract.release-flags.md` R2). */
export const RELEASE_FLAG_STAGES = ["off", "platform", "everyone"] as const;
export type ReleaseFlagStage = (typeof RELEASE_FLAG_STAGES)[number];

/** One flag as `GET /tenants/release-flags` answers it. */
export interface ReleaseFlagRow {
  key: string;
  stage: ReleaseFlagStage;
  /** Resellers whose own answer wins over the stage, oldest first. */
  exceptions: { tenantId: string; isOn: boolean }[];
}

const flagPath = (key: string) => `/tenants/release-flags/${encodeURIComponent(key)}`;
const exceptionPath = (key: string, tenantId: string) => `${flagPath(key)}/tenants/${encodeURIComponent(tenantId)}`;

/** The platform's release-flag routes; tenant-service refuses any tenant but the platform owner's. */
export const releaseFlagsApi = {
  table: () => call<ReleaseFlagRow[]>("/tenants/release-flags", { method: "GET" }),
  setStage: (key: string, stage: ReleaseFlagStage) => call<void>(flagPath(key), { method: "PUT", body: JSON.stringify({ stage }) }),
  setException: (key: string, tenantId: string, isOn: boolean) =>
    call<void>(exceptionPath(key, tenantId), { method: "PUT", body: JSON.stringify({ isOn }) }),
  clearException: (key: string, tenantId: string) => call<void>(exceptionPath(key, tenantId), { method: "DELETE" }),
};
