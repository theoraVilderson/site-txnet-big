import type { Prisma, SeasonKind } from '@prisma/client';
import { seasonOccurrences, type SeasonRule } from '@txnet-backend/shared-core';

/**
 * F-505-a (D-45): which campaigns a tenant's seasons call for, decided on rows
 * in hand. `CatalogAdminService.writeUpcomingSeasons` writes each through the
 * campaign's own rules (F-503-a); this only says what is due.
 */

/** Occurrences are written this far ahead (F-505-b's job runs well inside it). */
export const SEASON_HORIZON_DAYS = 14;

/** A minute's grace: an occurrence starting now is already running, and a campaign never starts in the past. */
const AHEAD_MS = 60_000;

type SeasonWhen = { kind: SeasonKind; month: number | null; day: number | null; weekday: number | null; startMinute: number; durationMinutes: number };

export type SeasonWithPrices = SeasonWhen & {
  id: string;
  tenantId: string | null;
  isActive: boolean;
  prices: Array<{ variantId: string; amount: Prisma.Decimal }>;
};

export type DueSeasonCampaign = { seasonId: string; tenantId: string | null; variantId: string; amount: Prisma.Decimal; startsAt: Date; endsAt: Date };

/** A stored season as shared-core's rule. */
export function seasonRuleOf(s: SeasonWhen): SeasonRule {
  return s.kind === 'dated'
    ? { kind: 'dated', month: s.month as number, day: s.day as number, startMinute: s.startMinute, durationMinutes: s.durationMinutes }
    : { kind: 'weekly', weekday: s.weekday as number, startMinute: s.startMinute, durationMinutes: s.durationMinutes };
}

/** A Jalali day the month never has (the first six months have 31, the rest 30; Esfand's 30th comes in leap years and is kept). */
export function seasonDateRefusal(s: { kind: SeasonKind; month?: number | null; day?: number | null; weekday?: number | null }): 'season_date_invalid' | null {
  if (s.kind !== 'dated') return null;
  const month = s.month ?? 0;
  const day = s.day ?? 0;
  return day > (month <= 6 ? 31 : 30) ? 'season_date_invalid' : null;
}

/** The written key of a season's campaign — the partial unique index's (season, variant, start). */
export const seasonCampaignKey = (seasonId: string, variantId: string, startsAt: Date) => `${seasonId}|${variantId}|${startsAt.toISOString()}`;

/**
 * Every campaign due from active seasons: each occurrence that starts ahead
 * of `now` and within `horizonDays`, for every variant the season prices, not
 * already written (`written`, by {@link seasonCampaignKey}). One running now
 * is never written — a campaign cannot start in the past.
 */
export function upcomingSeasonCampaigns(
  seasons: readonly SeasonWithPrices[],
  zoneOf: (tenantId: string | null) => string,
  now: Date,
  horizonDays: number,
  written: ReadonlySet<string>,
): DueSeasonCampaign[] {
  const until = new Date(now.getTime() + horizonDays * 86_400_000);
  const out: DueSeasonCampaign[] = [];
  for (const s of seasons) {
    if (!s.isActive || s.prices.length === 0) continue;
    for (const o of seasonOccurrences(seasonRuleOf(s), zoneOf(s.tenantId), now, until)) {
      if (o.startsAt.getTime() <= now.getTime() + AHEAD_MS) continue;
      for (const p of s.prices) {
        if (written.has(seasonCampaignKey(s.id, p.variantId, o.startsAt))) continue;
        out.push({ seasonId: s.id, tenantId: s.tenantId, variantId: p.variantId, amount: p.amount, startsAt: o.startsAt, endsAt: o.endsAt });
      }
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.variantId.localeCompare(b.variantId));
}
