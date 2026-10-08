import type { OwnedReseller } from "@/lib/tenant-api";

/** What My services says of the caller's reseller subscription (F-502-v). */
export type SubscriptionState = "active" | "grace" | "suspended";

/**
 * The state from tenant's own answer, never from a clock of the panel's: a
 * suspension is the tenant's `status`; a live reseller whose
 * `currentPeriodEnd` has passed is in grace — the renewal is owed and the
 * sweep has not suspended it yet (`tenant/contract.billing.md`, "Subscription
 * renewal"). `/purchase/mine` answers no `graceUntil`, so the deadline is not
 * said. `null` for a terminated one, which that route never answers.
 */
export function subscriptionState(r: OwnedReseller, nowMs: number): SubscriptionState | null {
  if (r.status === "terminated") return null;
  if (r.status === "suspended") return "suspended";
  const end = r.currentPeriodEnd ? Date.parse(r.currentPeriodEnd) : NaN;
  return Number.isFinite(end) && end <= nowMs ? "grace" : "active";
}

/** Theme tokens; gold is a tone here, never a control (user, 2026-09-13). */
export const SUBSCRIPTION_TONES: Record<SubscriptionState, string> = {
  active: "border-primary/20 bg-leaf-bg text-primary",
  grace: "border-gold/20 bg-gold-bg text-gold",
  suspended: "border-error-border bg-error-bg text-error",
};
