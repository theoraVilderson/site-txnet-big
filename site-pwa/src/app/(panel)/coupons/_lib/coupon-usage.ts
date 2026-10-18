import type { RedemptionStatus, UsageQuery } from "@/lib/billing-api";
import { REDEMPTION_STATUSES } from "@/lib/billing-api";
import { PLATFORM_UTC_OFFSET } from "../../_lib/datetime";
import { COUPON_KEYS, dayToInstant } from "./coupon-form";

// The usage report's filters (F-502-i): a coupon's and a batch's report alike.

/** The usage report's status filter offers billing's redemption statuses (F-502-i). */
export const USAGE_STATUSES = REDEMPTION_STATUSES;

/** The usage report's filters as picked: `""` is no filter; days are Tehran's `YYYY-MM-DD`. */
export interface UsageFilter {
  status: RedemptionStatus | "";
  from: string;
  to: string;
}

export const emptyUsageFilter = (): UsageFilter => ({ status: "", from: "", to: "" });

const USAGE_PAGE_SIZE = 20;

/**
 * The report's query. Billing reads `from` as `gte` and `to` as `lte`, so the
 * "to" day ends on its own last instant — the next midnight would count a
 * redemption made at exactly 00:00 of the day after.
 */
export function usageQuery(f: UsageFilter, page: number): UsageQuery {
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.from ? { from: dayToInstant(f.from, "start") } : {}),
    ...(f.to ? { to: `${f.to}T23:59:59.999${PLATFORM_UTC_OFFSET}` } : {}),
    page,
    pageSize: USAGE_PAGE_SIZE,
  };
}

/** The sentence key when the range ends before it starts; one day (from = to) is a range. */
export function validateUsageFilter(f: UsageFilter): string | null {
  return f.from && f.to && f.from > f.to ? COUPON_KEYS.usage.filters.badRange : null;
}
