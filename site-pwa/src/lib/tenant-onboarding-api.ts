// A reseller's onboarding checklist (F-018-l) and an optional step's skip
// (F-213), tenant `contract.onboarding.md` "The checklist": its own module
// beside `tenant-api.ts`, on the same tenant-service caller.
import { call } from "./tenant-call";

/** The step a reseller may skip: counts toward nothing (user, 2026-10-22). */
export type OnboardingOptionalStepKey = "import";

/** A step of the checklist, in the route's order: the optional `import` first, then the gate. */
export type OnboardingStepKey = OnboardingOptionalStepKey | "domain" | "gateway" | "bot" | "pricing";

/** One step: `gate` closes capabilities, `optional` counts toward nothing, `skipped` is done by the reseller's word. */
export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  gate: boolean;
  optional: boolean;
  skipped: boolean;
}

/** `GET /api/tenants/:id/onboarding`: every field computed from live rows, but a skip. */
export interface ResellerOnboarding {
  tenantId: string;
  /** The gate: true while no panel domain is proved. The same answer the guard enforces. */
  onboarding: boolean;
  /** What the gate closes while `onboarding`; empty otherwise. */
  closed: string[];
  steps: OnboardingStep[];
  /** Every required step done — a reseller can be open well before this. */
  complete: boolean;
}

const base = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/onboarding`;

/**
 * The checklist, admitted by the path's reseller (invariant 21) as a `read`;
 * a skip and its undo as the migration page's write (`migration.manage`) —
 * 204, the caller re-reads.
 */
export const resellerOnboardingApi = {
  async get(tenantId: string): Promise<ResellerOnboarding> {
    return call<ResellerOnboarding>(base(tenantId), { method: "GET" });
  },
  async skip(tenantId: string, step: OnboardingOptionalStepKey): Promise<void> {
    await call<void>(`${base(tenantId)}/skips/${step}`, { method: "PUT" });
  },
  async unskip(tenantId: string, step: OnboardingOptionalStepKey): Promise<void> {
    await call<void>(`${base(tenantId)}/skips/${step}`, { method: "DELETE" });
  },
};
