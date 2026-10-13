import { GatewayCategory, type Prisma } from '@prisma/client';

import type { ResellerLimitKey } from '../tenant/reseller-limits';

/**
 * A whole number from 0 to `max` — a ceiling on how many of something the
 * person may hold. `ceiling`: a reseller limit no number set may pass (ADR-0106).
 */
type CountRestriction = { kind: 'count'; max: number; ceiling?: ResellerLimitKey };
/** Some of `options`, at least one — the things the person is barred from. */
type SetRestriction = { kind: 'set'; options: readonly string[] };

/**
 * What staff may restrict on one person (F-030-d, §3.9): one registry of keys,
 * each a value kind. A new restriction is a new key here plus the one place
 * that refuses past it (F-030-e) — no table changes, as `RESELLER_LIMITS`.
 *
 * Not the `restricted` status (ADR-0133): that closes the account to all but
 * support; these narrow one thing and leave the rest open.
 */
export const USER_RESTRICTIONS = {
  /** Services (open Grants) the person may hold at once. */
  services_active_max: { kind: 'count', max: 10_000 },
  /**
   * Open metered (pay-as-you-go) services — F-118-ao's own number for one
   * person, moved here (F-030-e). Unset, the tenant's default and the
   * platform's apply (`metered-cap.ts`); never above the reseller's
   * `user_metered_cap_max` (F-019-n), and `MAX_METERED_CAP` is this `max`.
   */
  metered_services_max: { kind: 'count', max: 1000, ceiling: 'user_metered_cap_max' },
  /** Configs the person may hold across their services. */
  configs_max: { kind: 'count', max: 100_000 },
  /** Top-up methods the person may not pay with, by gateway category. */
  topup_categories_barred: { kind: 'set', options: Object.values(GatewayCategory) },
} as const satisfies Record<string, CountRestriction | SetRestriction>;

export type UserRestrictionKey = keyof typeof USER_RESTRICTIONS;

export const USER_RESTRICTION_KEYS = Object.keys(USER_RESTRICTIONS) as UserRestrictionKey[];

export const isUserRestrictionKey = (key: string): key is UserRestrictionKey => Object.prototype.hasOwnProperty.call(USER_RESTRICTIONS, key);

/** A restriction's value: a count, or the barred options sorted. */
export type UserRestrictionValue = number | string[];

/** `raw` as `key`'s kind reads it, or null when it is not one: a count out of range, an unknown option, an empty or repeated set. */
export function restrictionValueOf(key: UserRestrictionKey, raw: unknown): UserRestrictionValue | null {
  const rule: CountRestriction | SetRestriction = USER_RESTRICTIONS[key];
  if (rule.kind === 'count') return Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= rule.max ? (raw as number) : null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const picked = new Set(raw);
  if (picked.size !== raw.length || ![...picked].every((o) => typeof o === 'string' && rule.options.includes(o))) return null;
  return [...(picked as Set<string>)].sort();
}

/** Reads `userRestriction` only, so a service's transaction client and a spec's fake both fit. */
type RestrictionReader = { userRestriction: { findMany(args: { where: Prisma.UserRestrictionWhereInput; select: { key: true; value: true } }): Promise<Array<{ key: string; value: Prisma.JsonValue }>> } };

/**
 * The restrictions on `userId` that hold at `now`, by key (F-030-e) — `keys`
 * narrows the read. In the person's tenant scope: the table is strict RLS. A
 * stored value the registry no longer reads is skipped, never guessed at.
 */
export async function liveRestrictionsOf(
  tx: RestrictionReader,
  userId: string,
  keys?: readonly UserRestrictionKey[],
  now: Date = new Date(),
): Promise<Map<UserRestrictionKey, UserRestrictionValue>> {
  const rows = await tx.userRestriction.findMany({
    where: { userId, ...(keys ? { key: { in: [...keys] } } : {}), ...liveRestriction(now) },
    select: { key: true, value: true },
  });
  const live = new Map<UserRestrictionKey, UserRestrictionValue>();
  for (const r of rows) {
    if (!isUserRestrictionKey(r.key)) continue;
    const value = restrictionValueOf(r.key, r.value);
    if (value !== null) live.set(r.key, value);
  }
  return live;
}

/** A restriction that holds at `now`: no expiry, or one still ahead. Every read that applies one adds it. */
export function liveRestriction(now: Date = new Date()): Prisma.UserRestrictionWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}
