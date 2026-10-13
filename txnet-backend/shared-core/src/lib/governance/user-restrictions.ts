import { GatewayCategory, type Prisma } from '@prisma/client';

/** A whole number from 0 to `max` — a ceiling on how many of something the person may hold. */
type CountRestriction = { kind: 'count'; max: number };
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

/** A restriction that holds at `now`: no expiry, or one still ahead. Every read that applies one adds it. */
export function liveRestriction(now: Date = new Date()): Prisma.UserRestrictionWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}
