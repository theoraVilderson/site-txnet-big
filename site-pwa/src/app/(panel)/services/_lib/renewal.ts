import type { GrantRow, GrantStatus, RenewalPlan } from "@/lib/billing-api";

/**
 * The renewal sheet's rules that are not layout (F-305-f, panel-web
 * `contract.renewal.md`).
 */

/** The statuses billing renews (billing `contract.renewal.md` rule 1); any other is refused `grant_not_renewable`. */
const RENEWABLE: ReadonlySet<GrantStatus> = new Set<GrantStatus>(["active", "suspended"]);

/**
 * Whether a row offers «تمدید» (rule 1): a Grant billing would renew. One
 * issued with no plan (an import) has no product to renew within, so billing
 * lists it nothing — a button that can only be refused is not drawn.
 */
export function renewalOffered(row: Pick<GrantRow, "status" | "variant">): boolean {
  return RENEWABLE.has(row.status) && row.variant !== null;
}

/**
 * What one plan adds to this Grant, as the sheet says it (rule 2): its bytes,
 * or "unlimited" on a Grant whose traffic is — billing answers `"0"` for both
 * that and a metered Grant, whose bytes are bought in blocks and so say
 * nothing here. `days` is `null` on a permanent Grant, which gains none.
 */
export function planAdds(plan: Pick<RenewalPlan, "bytes" | "days">, row: Pick<GrantRow, "trafficUnlimited">): {
  traffic: { bytes: string } | "unlimited" | null;
  days: number | null;
} {
  const traffic = plan.bytes !== "0" ? { bytes: plan.bytes } : row.trafficUnlimited ? "unlimited" : null;
  return { traffic, days: plan.days > 0 ? plan.days : null };
}
