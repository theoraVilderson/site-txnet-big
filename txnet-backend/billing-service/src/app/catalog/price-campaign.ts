import type { Prisma } from '@prisma/client';
import { priceAt } from '@txnet-backend/shared-core';

/**
 * F-503-a (D-45; F-503's rule — never overwrite a price, the server's clock
 * decides): the rules of a variant's time-boxed price, decided on rows in
 * hand. `CatalogAdminService` reads them in its transaction and writes what
 * these allow.
 *
 * A campaign is two new price rows: its amount from `startsAt`, and the price
 * in effect at `startsAt` back from `endsAt`. That restore row is why the
 * rest holds: a plain price written before a campaign ends — or one already
 * scheduled inside it — would be undone by it, and two campaigns that overlap
 * would restore each other's prices; all are refused, never half-written.
 */

/** A server's "now" that is a second behind a client's "now" is not the past. */
const PAST_SKEW_MS = 60_000;

export type CampaignRow = { id: string; startsAt: Date; endsAt: Date; cancelledAt: Date | null };
type PriceLike = { amount: Prisma.Decimal; currencyCode: string; effectiveFrom: Date; isActive: boolean; campaignId: string | null };

export type CampaignRefusal = 'price_in_the_past' | 'no_price_to_restore' | 'price_scheduled_in_campaign' | 'campaign_overlaps';

const live = (c: CampaignRow) => c.cancelledAt === null;

/** What a new campaign restores at its end, or why it is refused. `prices` are the variant's, every row. */
export function campaignPlan(input: {
  startsAt: Date;
  endsAt: Date;
  now: Date;
  currencyCode: string;
  prices: readonly PriceLike[];
  campaigns: readonly CampaignRow[];
}): { restore: Prisma.Decimal } | { refused: CampaignRefusal } {
  const { startsAt, endsAt, now } = input;
  if (startsAt.getTime() < now.getTime() - PAST_SKEW_MS) return { refused: 'price_in_the_past' };
  if (input.campaigns.some((c) => live(c) && c.startsAt.getTime() < endsAt.getTime() && startsAt.getTime() < c.endsAt.getTime())) {
    return { refused: 'campaign_overlaps' };
  }
  // A plain price that takes effect after the campaign starts and before it ends: the restore row would undo it.
  const scheduled = input.prices.some(
    (p) => p.isActive && p.campaignId === null && p.currencyCode === input.currencyCode && p.effectiveFrom.getTime() > startsAt.getTime() && p.effectiveFrom.getTime() < endsAt.getTime(),
  );
  if (scheduled) return { refused: 'price_scheduled_in_campaign' };
  const before = priceAt(input.prices as Array<PriceLike & { id: string }>, startsAt, input.currencyCode);
  if (!before) return { refused: 'no_price_to_restore' };
  return { restore: before.amount };
}

/** A plain price from `effectiveFrom`: refused while a campaign not cancelled ends after it — its restore row would undo the price. */
export function priceWriteVerdict(effectiveFrom: Date, campaigns: readonly CampaignRow[]): { ok: true } | { refused: 'campaign_pending' } {
  return campaigns.some((c) => live(c) && c.endsAt.getTime() > effectiveFrom.getTime()) ? { refused: 'campaign_pending' } : { ok: true };
}

/** Cancelled only before it starts — after, half of it is history an invoice may already carry. A second cancel is no change. */
export function cancelVerdict(c: CampaignRow, now: Date): { cancel: true } | { already: true } | { refused: 'campaign_started' } {
  if (c.cancelledAt !== null) return { already: true };
  if (c.startsAt.getTime() <= now.getTime()) return { refused: 'campaign_started' };
  return { cancel: true };
}

/** What an offer counts down to (F-503's countdown): the end of the campaign whose price it carries, while it runs. */
export function offerCampaignEndsAt(price: { campaignEndsAt: Date | null }, at: Date): Date | null {
  return price.campaignEndsAt && price.campaignEndsAt.getTime() > at.getTime() ? price.campaignEndsAt : null;
}
