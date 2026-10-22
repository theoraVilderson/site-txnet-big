// The user's prize service (F-707-r, engagement `contract.md`): which of their
// services a wheel or lottery prize of GB or days goes to.
import { call } from "./client";

/** A service a prize of GB or days can go to, named as My services names it. */
export interface PrizeService {
  id: string;
  label: string | null;
  variant: { id: string; sku: string; nameKey: string } | null;
  endsAt: string | null;
  /** What is left of a capped service, in bytes; `null` for an unlimited or metered one (F-707-x). */
  remainingBytes: string | null;
  takesTraffic: boolean;
  takesDays: boolean;
}

/** `chosenGrantId: null` is automatic — the service that runs longest. */
export interface RewardTarget {
  chosenGrantId: string | null;
  services: PrizeService[];
}

export const rewardTargetApi = {
  view(): Promise<RewardTarget> {
    return call<RewardTarget>("/reward-target", { method: "GET" });
  },
  /** `null` is automatic again; both routes answer the same view. */
  choose(grantId: string | null): Promise<RewardTarget> {
    return call<RewardTarget>("/reward-target", { method: "PUT", body: JSON.stringify({ grantId }) });
  },
};
