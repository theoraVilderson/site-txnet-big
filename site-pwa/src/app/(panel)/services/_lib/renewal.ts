import type { GrantRow, GrantStatus, RenewalCustom, RenewalPlan } from "@/lib/billing-api";
import { toEnglishDigits } from "@/util/helper";

/**
 * The renewal sheet's rules that are not layout (F-305-f/g, panel-web
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

/** The sheet's own choice beside the plans' variant ids (which are uuids): GiB and days typed (rule 4). */
export const CUSTOM_CHOICE = "custom";

/** What the custom fields hold, as typed. */
export interface TypedRenewal {
  gib: string;
  days: string;
}

/**
 * GiB and days typed, as whole numbers to quote — or `null` while there is
 * nothing to ask billing: not a whole number, or both 0. A part with no field
 * (its most is 0 for this Grant) and an empty field are 0, "not this part".
 * The bounds are **not** checked here: billing's `custom_out_of_bounds` says
 * them, so the rule has one home.
 */
export function typedAmount(typed: TypedRenewal, custom: Pick<RenewalCustom, "maxGib" | "maxDays">): { gib: number; days: number } | null {
  const part = (text: string, max: number): number | null => {
    if (max === 0) return 0;
    const s = toEnglishDigits(text.trim());
    if (s === "") return 0;
    return /^\d{1,6}$/.test(s) ? Number(s) : null;
  };
  const gib = part(typed.gib, custom.maxGib);
  const days = part(typed.days, custom.maxDays);
  if (gib === null || days === null || (gib === 0 && days === 0)) return null;
  return { gib, days };
}
