import type { PanelGroup, SystemsPanel } from "@/lib/billing-api";
import { groupHealth } from "./panel-groups";
import { isArchived } from "./panel-lifecycle";
import { SYSTEMS_KEYS, radiusSecretMissing } from "./systems";

/**
 * The systems page for someone who has never used it (F-027-ck): the order
 * the work is done in, ticked from what the page already read, and one
 * status per panel instead of a row of pills. Nothing here is a verdict of
 * its own — every input is a column billing answered (panel-web rule 2).
 */
const K = SYSTEMS_KEYS;

/** Register, wait for the test, put an accepted panel in a group, then name that group on a product. */
export const GUIDE_STEPS = ["register", "accepted", "group", "product"] as const;
export type GuideStep = (typeof GUIDE_STEPS)[number];
export type StepState = "done" | "current" | "todo";

export function guideOf(panels: readonly SystemsPanel[], groups: readonly PanelGroup[]): { steps: { step: GuideStep; state: StepState }[]; done: boolean } {
  const live = panels.filter((p) => !isArchived(p));
  const done: Record<GuideStep, boolean> = {
    register: live.length > 0,
    accepted: live.some((p) => p.review.reviewState === "accepted" || p.review.reviewState === "accepted_low_trust"),
    group: groups.some((g) => g.members.length > 0),
    product: groups.some((g) => g.variantCount > 0),
  };
  const current = GUIDE_STEPS.find((s) => !done[s]);
  return {
    steps: GUIDE_STEPS.map((step) => ({ step, state: done[step] ? "done" : step === current ? "current" : "todo" })),
    done: current === undefined,
  };
}

export type PanelStatus = "ready" | "limited" | "testing" | "refused" | "problem" | "archived";

/** One word for a card, the worst first: a refusal is fixed at registration, so it outranks a stopped collection. */
export function panelStatusOf(panel: SystemsPanel): PanelStatus {
  if (isArchived(panel)) return "archived";
  const { reviewState } = panel.review;
  if (reviewState === "refused") return "refused";
  if (reviewState === "pending") return "testing";
  const { collectionHalted, panelState } = panel.health;
  if (collectionHalted || panelState === "down" || panelState === "throttled_or_blocked" || panel.budget.blockedSince || radiusSecretMissing(panel)) {
    return "problem";
  }
  return reviewState === "accepted_low_trust" ? "limited" : "ready";
}

export const PANEL_STATUS_KEYS: Record<PanelStatus, { label: string; hint: string }> = {
  ready: K.status.ready,
  limited: K.status.limited,
  testing: K.status.testing,
  refused: K.status.refused,
  problem: K.status.problem,
  archived: K.status.archived,
};

export type SystemsTab = "panels" | "groups" | "reports";

/** A tab's badge: refused or stopped panels, groups short of their minimum, open drift events. Archived panels are out of every count. */
export function attentionOf(panels: readonly SystemsPanel[], groups: readonly PanelGroup[]): Record<SystemsTab, number> {
  const live = panels.filter((p) => !isArchived(p));
  return {
    panels: live.filter((p) => ["refused", "problem"].includes(panelStatusOf(p))).length,
    groups: groups.filter((g) => groupHealth(g).short).length,
    reports: live.reduce((n, p) => n + p.health.openDriftEvents, 0),
  };
}
