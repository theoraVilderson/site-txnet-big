import { Prisma } from '@prisma/client';

import { campaignPlan, cancelVerdict, offerCampaignEndsAt, priceWriteVerdict, type CampaignRow } from './price-campaign';

/**
 * F-503-a (D-45; F-503's rule: never overwrite a price — the server's clock
 * decides). A campaign is two new price rows: its amount from `startsAt`, the
 * price before it back from `endsAt`.
 *
 * The failures worth a spec: a restore row that brings back a price the admin
 * changed meanwhile (a plain price written before the campaign ends, or one
 * already scheduled inside it); two campaigns on one variant that undo each
 * other's restore; a campaign with nothing to return to; a campaign cancelled
 * after it started, half-applied; an offer counting down to a campaign that is
 * over, or to one that was cancelled.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date('2026-10-02T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const price = (amount: string, effectiveFrom: Date, over: Record<string, unknown> = {}) => ({
  amount: new Prisma.Decimal(amount), currencyCode: 'IRR', effectiveFrom, isActive: true, campaignId: null, ...over,
});
const campaign = (startsAt: Date, endsAt: Date, over: Partial<CampaignRow> = {}): CampaignRow => ({ id: 'c-1', startsAt, endsAt, cancelledAt: null, ...over });

describe('campaignPlan', () => {
  it('restores the price in effect when it starts, in the variant\'s currency', () => {
    const plan = campaignPlan({ startsAt: at(DAY), endsAt: at(3 * DAY), now, currencyCode: 'IRR', prices: [price('100000.00', at(-30 * DAY)), price('120000.00', at(-DAY))], campaigns: [] });
    expect(plan).toEqual({ restore: new Prisma.Decimal('120000.00') });
  });

  it('refuses a start in the past, nothing to return to, and a plain price already scheduled before its end', () => {
    expect(campaignPlan({ startsAt: at(-HOUR), endsAt: at(DAY), now, currencyCode: 'IRR', prices: [price('1.00', at(-DAY))], campaigns: [] })).toEqual({ refused: 'price_in_the_past' });
    expect(campaignPlan({ startsAt: at(DAY), endsAt: at(2 * DAY), now, currencyCode: 'IRR', prices: [price('1.00', at(-DAY), { currencyCode: 'USD' })], campaigns: [] })).toEqual({ refused: 'no_price_to_restore' });
    // A price scheduled for the middle of the window: the restore row would undo it.
    expect(campaignPlan({ startsAt: at(DAY), endsAt: at(3 * DAY), now, currencyCode: 'IRR', prices: [price('1.00', at(-DAY)), price('2.00', at(2 * DAY))], campaigns: [] })).toEqual({ refused: 'price_scheduled_in_campaign' });
  });

  it('refuses one that overlaps a campaign not cancelled; a cancelled or back-to-back one is no overlap', () => {
    const base = { now, currencyCode: 'IRR', prices: [price('1.00', at(-DAY))] };
    expect(campaignPlan({ ...base, startsAt: at(2 * DAY), endsAt: at(4 * DAY), campaigns: [campaign(at(DAY), at(3 * DAY))] })).toEqual({ refused: 'campaign_overlaps' });
    expect(campaignPlan({ ...base, startsAt: at(2 * DAY), endsAt: at(4 * DAY), campaigns: [campaign(at(DAY), at(3 * DAY), { cancelledAt: now })] })).toHaveProperty('restore');
    expect(campaignPlan({ ...base, startsAt: at(3 * DAY), endsAt: at(4 * DAY), campaigns: [campaign(at(DAY), at(3 * DAY))] })).toHaveProperty('restore');
  });
});

describe('priceWriteVerdict', () => {
  it('a plain price from before a campaign\'s end is refused — its restore row would undo it; from its end on, or once cancelled, it is fine', () => {
    const c = campaign(at(DAY), at(3 * DAY));
    expect(priceWriteVerdict(at(2 * DAY), [c])).toEqual({ refused: 'campaign_pending' });
    expect(priceWriteVerdict(now, [c])).toEqual({ refused: 'campaign_pending' });
    expect(priceWriteVerdict(at(3 * DAY), [c])).toEqual({ ok: true });
    expect(priceWriteVerdict(now, [{ ...c, cancelledAt: now }])).toEqual({ ok: true });
  });
});

describe('cancelVerdict', () => {
  it('before it starts only; a second cancel answers the same', () => {
    expect(cancelVerdict(campaign(at(DAY), at(2 * DAY)), now)).toEqual({ cancel: true });
    expect(cancelVerdict(campaign(at(-HOUR), at(DAY)), now)).toEqual({ refused: 'campaign_started' });
    expect(cancelVerdict(campaign(at(DAY), at(2 * DAY), { cancelledAt: at(-HOUR) }), now)).toEqual({ already: true });
  });
});

describe('offerCampaignEndsAt', () => {
  it('the offer counts down to the end of the campaign whose price it carries, and only while it runs', () => {
    expect(offerCampaignEndsAt({ campaignEndsAt: at(DAY) }, now)).toEqual(at(DAY));
    expect(offerCampaignEndsAt({ campaignEndsAt: at(-HOUR) }, now)).toBeNull();
    expect(offerCampaignEndsAt({ campaignEndsAt: null }, now)).toBeNull();
  });
});
