/**
 * F-038-f3 / ADR-0110 points 1, 2: an AI offer reaches one user as a personal
 * coupon, issued by billing when the suggestion is delivered — cloned from
 * the tenant's template (its gateways and channels), the discount the lower
 * of the template's and the offer's cap, single-use, for that user and that
 * plan only, expiring at the suggestion's deadline. The offer's daily budget
 * is spent at issue, in the tenant's own day.
 *
 * What breaks without anyone seeing it:
 *  - **a discount bigger than the seller allowed** — the template's 30 %
 *    under an offer capped at 20 %, or a fixed amount over the cap;
 *  - **the budget overrun** — every issue past it is real money once
 *    redeemed, and two deliveries at once must not both fit the last slot;
 *  - **two coupons for one suggestion** — the worker retries a delivery, and
 *    a second coupon would charge the budget twice;
 *  - **a coupon anyone can type** — it must be `targeted` at the one user,
 *    limited to the plan, used once.
 */
import { Prisma } from '@prisma/client';

import { AiOfferCouponService, personalCouponTerms, type AiOfferCouponBody } from './ai-offer-coupon';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const ACTION = '66666666-6666-4666-8666-666666666666';
const OFFER = '77777777-7777-4777-8777-777777777777';
const TEMPLATE = '88888888-8888-4888-8888-888888888888';
const VARIANT = '99999999-9999-4999-8999-999999999999';
const GATEWAY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// 2026-10-05 23:30 in Tehran (+03:30): the tenant's day began at 2026-10-04T20:30Z.
const NOW = new Date('2026-10-05T20:00:00Z');
const D = (v: string) => new Prisma.Decimal(v);

const body = (over: Partial<AiOfferCouponBody> = {}): AiOfferCouponBody => ({
  tenantId: TENANT,
  userId: USER,
  actionId: ACTION,
  offerId: OFFER,
  createdByUserId: ADMIN,
  variantId: VARIANT,
  couponTemplateId: TEMPLATE,
  maxDiscountPercent: '20.00',
  dailyBudget: '100000.00',
  currencyCode: 'IRR',
  expiresAt: '2026-10-10T12:00:00.000Z',
  ...over,
});

type Template = {
  id: string; tenantId: string; discountType: string; discountValue: Prisma.Decimal; maxDiscountCap: Prisma.Decimal | null; currencyCode: string;
  allowedChannels: string[]; gateways: Array<{ gatewayId: string | null; tenantGatewayConfigId: string | null }>; serviceScopes: Array<{ productId: string | null; variantId: string | null }>;
};
const template = (over: Partial<Template> = {}): Template => ({
  id: TEMPLATE, tenantId: TENANT, discountType: 'percentage', discountValue: D('30'), maxDiscountCap: null, currencyCode: 'IRR',
  allowedChannels: ['panel'], gateways: [{ gatewayId: null, tenantGatewayConfigId: GATEWAY }], serviceScopes: [], ...over,
});

function build(opts: { template?: Template | null; spentToday?: string; existing?: Record<string, unknown> | null; price?: string | null; priceCurrency?: string } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const asked: { spentSince?: Date; locked?: boolean } = {};
  const tx = {
    $executeRaw: async () => {
      asked.locked = true;
      return 1;
    },
    tenant: { findUnique: async () => ({ timezone: 'Asia/Tehran' }) },
    // The registry: a rial has no minor unit.
    currency: { findUnique: async () => ({ decimalPlaces: 0 }) },
    coupon: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if ('aiActionId' in where) return opts.existing ?? null;
        return opts.template === undefined ? template() : opts.template;
      },
      aggregate: async ({ where }: { where: { createdAt: { gte: Date } } }) => {
        asked.spentSince = where.createdAt.gte;
        return { _sum: { aiBudgetCharge: opts.spentToday ? D(opts.spentToday) : null } };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'c1', ...data };
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  const offerOf = async () =>
    opts.price === null ? null : ({ variantId: VARIANT, productId: 'p1', price: { amount: opts.price ?? '200000.00', currencyCode: opts.priceCurrency ?? 'IRR' } } as never);
  const service = new AiOfferCouponService(prisma as never);
  return { issue: (b: AiOfferCouponBody) => service.issue(b, NOW, offerOf), created, asked };
}

describe('personalCouponTerms (F-038-f3)', () => {
  const price = { amount: D('200000'), places: 0 };

  it('takes the lower of the template\'s percentage and the offer\'s cap, and the template\'s money cap', () => {
    expect(personalCouponTerms(price, D('20'), template())).toMatchObject({ discountType: 'percentage', discountValue: '20.00', charge: '40000.00' });
    expect(personalCouponTerms(price, D('20'), template({ discountValue: D('10') }))).toMatchObject({ discountValue: '10.00', charge: '20000.00' });
    expect(personalCouponTerms(price, D('20'), template({ maxDiscountCap: D('25000') }))).toMatchObject({ discountValue: '20.00', maxDiscountCap: '25000.00', charge: '25000.00' });
  });

  it('keeps a fixed amount fixed, never above the cap on this plan', () => {
    expect(personalCouponTerms(price, D('20'), template({ discountType: 'fixed_amount', discountValue: D('30000') }))).toMatchObject({ discountType: 'fixed_amount', discountValue: '30000.00', charge: '30000.00' });
    expect(personalCouponTerms(price, D('10'), template({ discountType: 'fixed_amount', discountValue: D('30000') }))).toMatchObject({ discountValue: '20000.00', charge: '20000.00' });
  });

  it('is the offer\'s own percentage for a variant offer, which has no template', () => {
    expect(personalCouponTerms(price, D('15'), null)).toMatchObject({ discountType: 'percentage', discountValue: '15.00', maxDiscountCap: null, charge: '30000.00' });
  });
});

describe('AiOfferCouponService.issue (F-038-f3)', () => {
  it('issues one targeted, single-use coupon for the user and the plan, cloned from the template, charged to the budget', async () => {
    const { issue, created, asked } = build();
    const out = await issue(body());
    expect(out).toMatchObject({
      issued: {
        code: expect.stringMatching(/^AI-[A-Z2-9]{10}$/),
        discount: { amount: '40000.00', currencyCode: 'IRR' },
        priceAfter: { amount: '160000.00', currencyCode: 'IRR' },
        expiresAt: '2026-10-10T12:00:00.000Z',
      },
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tenantId: TENANT,
      discountType: 'percentage',
      discountValue: '20.00',
      currencyCode: 'IRR',
      totalUsageLimit: 1,
      perUserUsageLimit: 1,
      visibility: 'targeted',
      isActive: true,
      expiresAt: new Date('2026-10-10T12:00:00.000Z'),
      allowedChannels: ['panel'],
      createdByAdminId: ADMIN,
      aiActionId: ACTION,
      aiOfferId: OFFER,
      aiBudgetCharge: '40000.00',
      allowedUsers: { create: [{ userId: USER }] },
      serviceScopes: { create: [{ variantId: VARIANT }] },
      gateways: { create: [{ gatewayId: null, tenantGatewayConfigId: GATEWAY }] },
    });
    expect(asked.locked).toBe(true);
    // The budget day is the tenant's: Tehran midnight, not UTC's.
    expect(asked.spentSince).toEqual(new Date('2026-10-04T20:30:00Z'));
  });

  it('refuses past the day\'s budget, and says when the next day starts', async () => {
    const { issue, created } = build({ spentToday: '70000.00' });
    expect(await issue(body())).toEqual({ refused: 'budget_spent', retryAt: '2026-10-05T20:30:00.000Z' });
    expect(created).toHaveLength(0);
    expect(await build({ spentToday: '60000.00' }).issue(body())).toHaveProperty('issued');
  });

  it('answers the same coupon to a second delivery of one suggestion, charging nothing again', async () => {
    const existing = { code: 'AI-ABCDEFGHJK', discountValue: D('20'), aiBudgetCharge: D('40000'), currencyCode: 'IRR', expiresAt: new Date('2026-10-10T12:00:00Z') };
    const { issue, created } = build({ existing });
    expect(await issue(body())).toMatchObject({ issued: { code: 'AI-ABCDEFGHJK', discount: { amount: '40000.00', currencyCode: 'IRR' }, priceAfter: { amount: '160000.00' } } });
    expect(created).toHaveLength(0);
  });

  it('refuses what it cannot issue: a plan no longer sold, a template gone, out of scope or in another currency', async () => {
    expect(await build({ price: null }).issue(body())).toEqual({ refused: 'plan_unavailable' });
    expect(await build({ template: null }).issue(body())).toEqual({ refused: 'offer_unavailable' });
    expect(await build({ template: template({ discountType: 'wallet_credit' }) }).issue(body())).toEqual({ refused: 'offer_unavailable' });
    expect(await build({ template: template({ serviceScopes: [{ productId: 'p-other', variantId: null }] }) }).issue(body())).toEqual({ refused: 'offer_unavailable' });
    expect(await build({ template: template({ serviceScopes: [{ productId: 'p1', variantId: null }] }) }).issue(body())).toHaveProperty('issued');
    expect(await build({ priceCurrency: 'USD' }).issue(body())).toEqual({ refused: 'offer_unavailable' });
  });
});
