import { ApiError } from "@/lib/api-error";
import type { GrantRow } from "@/lib/billing-api";

/** What a card offers the user on their own freeze (F-0401-e); `null` is nothing at all. */
export type OwnFreeze = "freeze" | "unfreeze" | "support";

/**
 * What one service offers its user (billing `contract.gift.md` "Freezing
 * one's own service"): a freeze on a live pay-as-you-go service — a prepaid
 * package frozen by its user would buy free days — and on a frozen one either
 * an unfreeze or support's name. Who may lift it is billing's
 * `userMayUnfreeze`, never re-derived from the mode: a soft freeze waiting
 * for a panel is support's too. A Grant stopped by its quota is not frozen
 * and offers nothing; a top-up lifts it.
 */
export function ownFreezeOf(row: Pick<GrantRow, "status" | "billingMode" | "frozen" | "userMayUnfreeze">): OwnFreeze | null {
  if (row.frozen) return row.userMayUnfreeze ? "unfreeze" : "support";
  return row.status === "active" && row.billingMode === "metered" ? "freeze" : null;
}

/**
 * A per-day cap's refusal with the figures it carries — the limit and when
 * the next act is allowed, as epoch ms (`facts` carries no text) — for the
 * `reason` it came with. Any other refusal, or one missing a figure, is `null`
 * and read as billing's sentence instead.
 */
export function dailyLimitOf(e: unknown, reason: string): { limit: number; nextAt: string } | null {
  if (!(e instanceof ApiError) || e.reason !== reason) return null;
  const { limit, nextAtMs } = e.facts;
  if (typeof limit !== "number" || typeof nextAtMs !== "number" || !Number.isFinite(nextAtMs)) return null;
  return { limit, nextAt: new Date(nextAtMs).toISOString() };
}

/** The fourth freeze of one service in 24 hours (F-0401-c, `SELF_FREEZES_PER_DAY`). */
export const freezeLimitOf = (e: unknown) => dailyLimitOf(e, "self_freeze_limit");
