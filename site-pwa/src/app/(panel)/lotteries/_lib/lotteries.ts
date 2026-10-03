import type { LotteryResult, UserLottery } from "@/lib/engagement-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { LOTTERY_ALGORITHM, lotteryListHash, lotteryPlaces } from "@/lib/lottery-draw";

/** The page's strings as generated constants (C-06). */
export const LOTTERY_KEYS = FrontendI18nKeys.common.lotteries;
const K = LOTTERY_KEYS;

/** Billing's `ExclusionReason` (the close, F-707-k); the spec reads the union from the service. */
export type ExclusionReason = "not_in_group" | "inactive" | "account_too_new" | "phone_unverified" | "flagged" | "shared_device";
export const EXCLUDED_KEYS: Record<ExclusionReason, string> = K.excluded;

/** Billing's `LotteryEntryRejection` (the entry and result routes). */
export type LotteryRefusal = "lottery_not_found" | "not_opt_in" | "closed" | "not_drawn";
export const REFUSAL_KEYS: Record<LotteryRefusal, string> = K.refusals;

const keyIn = <T extends string>(table: Record<T, string>, reason: unknown): string | null =>
  typeof reason === "string" && reason in table ? table[reason as T] : null;

/** An exclusion's sentence key, or none for a reason a newer billing added. */
export const excludedKeyOf = (reason: unknown) => keyIn(EXCLUDED_KEYS, reason);
/** The sentence key of a refused call, from the error body. */
export const refusalKey = (e: unknown) => keyIn(REFUSAL_KEYS, (e as { reason?: unknown } | null)?.reason);
/** Why a prize passed on, or none. */
export const passedOnKeyOf = (reason: unknown) => keyIn(K.result.passedOn, reason);

/** The status pill. A published lottery past its close is still `published` until the next minute's freeze. */
export function statusKey(l: Pick<UserLottery, "status" | "open">): string {
  if (l.status === "published") return l.open ? K.status.open : K.status.closing;
  return K.status[l.status];
}

export type EntryState = "can_join" | "can_leave" | "automatic" | "ticket" | "excluded" | "none";

/** What the card offers or says about the caller's entry. Billing still decides (F-707-j rules 1–4). */
export function entryState(l: Pick<UserLottery, "entryMode" | "open" | "entry">): EntryState {
  if (l.entry?.ticketNumber != null) return "ticket";
  if (l.entry?.excludedReason) return "excluded";
  if (l.open) {
    if (l.entryMode === "automatic") return "automatic";
    return l.entry ? "can_leave" : "can_join";
  }
  return "none";
}

export type VerifyOutcome = { outcome: "ok" | "list_mismatch" | "places_mismatch" | "unknown_algorithm"; positions: number[] };

/**
 * Redo the draw from what was published (ADR-0111 point 5), with the same
 * file billing drew with (`@/lib/lottery-draw`, a byte-identical copy of
 * shared-core's — the spec holds it):
 *
 * 1. the ticket list hashes to `listHash`, with `entrantCount` tickets;
 * 2. `lotteryPlaces` over the seed gives every published place its ticket;
 * 3. a place holds the prize the draw gave it — unless it is a reserve that
 *    took over a passed-on place, which then names that place and its prize.
 *
 * Runs only in this browser; nothing is sent.
 */
export async function verifyDraw(r: LotteryResult): Promise<VerifyOutcome> {
  if (r.algorithm !== LOTTERY_ALGORITHM) return { outcome: "unknown_algorithm", positions: [] };
  const hash = await lotteryListHash(r.lotteryId, r.tickets);
  if (hash !== r.listHash || r.tickets.length !== r.entrantCount) return { outcome: "list_mismatch", positions: [] };

  const expected = await lotteryPlaces({ seed: r.seed, listHash: r.listHash, entrantCount: r.entrantCount, prizes: r.prizes, reservesCount: r.reservesCount });
  const byPosition = new Map(r.places.map((p) => [p.position, p]));
  const wrong = new Set<number>();
  for (const p of r.places) if (p.position < 1 || p.position > expected.length) wrong.add(p.position);
  for (const e of expected) {
    const got = byPosition.get(e.position);
    if (!got || got.ticketNumber !== e.ticketNumber) {
      wrong.add(e.position);
      continue;
    }
    const rank = got.prize?.rank ?? null;
    if (got.replacesPosition === null) {
      if (rank !== e.prizeRank) wrong.add(e.position);
      continue;
    }
    const replaced = byPosition.get(got.replacesPosition);
    const tookOver = e.prizeRank === null && replaced?.delivery === "passed_on" && (replaced.prize?.rank ?? null) === rank && rank !== null;
    if (!tookOver) wrong.add(e.position);
  }
  const positions = [...wrong].sort((a, b) => a - b);
  return { outcome: positions.length ? "places_mismatch" : "ok", positions };
}
