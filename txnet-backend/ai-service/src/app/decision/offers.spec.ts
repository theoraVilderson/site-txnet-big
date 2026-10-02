import { Prisma } from '@prisma/client';

import type { AiReaderPrisma, PrismaService } from '../prisma/prisma.service';
import { OFFER_ACTION_TYPES, OfferRefused, Offers, offerBodySchema, offerPatchSchema } from './offers';

/**
 * F-038-f1 (ADR-0110 point 4, ADR-0109 point 9): the offers a tenant defines —
 * the only discounts the engine may ever give. The AI page (F-038-j) creates,
 * edits and lists them through these seams.
 *
 * The failures worth a spec: a template that is another tenant's coupon or the
 * platform's (its users cannot use it — ADR-0099); a gift code or a free
 * service as a "discount"; a deleted coupon; a variant no longer sold; an
 * offer that targets both or neither; a discount over 100 % or a budget as a
 * float (C-02); another tenant's offer edited; a patch that changes what an
 * offer targets (the actions that cite it would change meaning); and an offer
 * switched off while a suggestion carrying it is still queued.
 */

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const ADMIN = '00000000-0000-4000-8000-0000000000a3';
const COUPON = '00000000-0000-4000-8000-0000000000c1';
const VARIANT = '00000000-0000-4000-8000-0000000000d1';
const OFFER = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-10-02T12:00:00Z');

const coupon = (over: Record<string, unknown> = {}) => ({ id: COUPON, tenantId: TENANT, discountType: 'percentage', deletedAt: null, ...over });
const row = (over: Record<string, unknown> = {}) => ({
  id: OFFER, tenantId: TENANT, name: 'Stay with us', actionType: 'retain_offer', couponTemplateId: COUPON, variantId: null,
  maxDiscountPercent: new Prisma.Decimal('20'), dailyBudget: new Prisma.Decimal('1000000'), currencyCode: 'IRR', isActive: true,
  createdByUserId: ADMIN, createdAt: NOW, updatedAt: NOW, ...over,
});

function fake(opts: { coupon?: unknown; variant?: unknown; offer?: unknown } = {}) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    aiOffer: {
      create: vi.fn(async (a: { data: Record<string, unknown> }) => row({ ...a.data, maxDiscountPercent: new Prisma.Decimal(a.data['maxDiscountPercent'] as string), dailyBudget: new Prisma.Decimal(a.data['dailyBudget'] as string) })),
      findFirst: vi.fn(async () => (opts.offer === undefined ? row() : opts.offer)),
      update: vi.fn(async (a: { data: Record<string, unknown> }) =>
        row(Object.fromEntries(Object.entries(a.data).map(([k, v]) => [k, k === 'dailyBudget' || k === 'maxDiscountPercent' ? new Prisma.Decimal(v as string) : v]))),
      ),
      findMany: vi.fn(async () => [row()]),
    },
    aiAction: { updateMany: vi.fn(async () => ({ count: 2 })) },
  };
  const rtx = {
    $executeRaw: vi.fn(async () => 1),
    coupon: { findFirst: vi.fn(async () => (opts.coupon === undefined ? coupon() : opts.coupon)) },
    productVariant: { findFirst: vi.fn(async () => (opts.variant === undefined ? { id: VARIANT, isActive: true } : opts.variant)) },
  };
  const app = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService;
  const reader = { $transaction: vi.fn(async (fn: (t: typeof rtx) => unknown) => fn(rtx)) } as unknown as AiReaderPrisma;
  return { offers: new Offers(app, reader), tx, rtx };
}

const body = (over: Record<string, unknown> = {}) =>
  offerBodySchema.parse({
    tenantId: TENANT, name: 'Stay with us', actionType: 'retain_offer', couponTemplateId: COUPON,
    maxDiscountPercent: '20', dailyBudget: '1000000', currencyCode: 'IRR', createdByUserId: ADMIN, ...over,
  });

const refusal = async (p: Promise<unknown>) => p.then(() => 'none', (e: unknown) => (e instanceof OfferRefused ? e.reason : String(e)));

describe('offer bodies (F-038-f1)', () => {
  it('takes exactly one target, a discount in (0, 100] and money as decimal strings', () => {
    const base = { tenantId: TENANT, name: 'x', actionType: 'retain_offer', maxDiscountPercent: '20', dailyBudget: '1000000', currencyCode: 'IRR', createdByUserId: ADMIN };
    expect(offerBodySchema.safeParse({ ...base, couponTemplateId: COUPON }).success).toBe(true);
    expect(offerBodySchema.safeParse({ ...base, variantId: VARIANT }).success).toBe(true);
    expect(offerBodySchema.safeParse({ ...base, couponTemplateId: COUPON, variantId: VARIANT }).success).toBe(false);
    expect(offerBodySchema.safeParse(base).success).toBe(false);
    for (const maxDiscountPercent of ['0', '100.01', '-5', 20]) expect(offerBodySchema.safeParse({ ...base, couponTemplateId: COUPON, maxDiscountPercent }).success).toBe(false);
    expect(offerBodySchema.safeParse({ ...base, couponTemplateId: COUPON, maxDiscountPercent: '100' }).success).toBe(true);
    for (const dailyBudget of [1000, '-1', '1.005', 'lots']) expect(offerBodySchema.safeParse({ ...base, couponTemplateId: COUPON, dailyBudget }).success).toBe(false);
    expect(offerBodySchema.safeParse({ ...base, couponTemplateId: COUPON, currencyCode: 'irr' }).success).toBe(false);
  });

  it('only for the types an offer can ride on', () => {
    expect(OFFER_ACTION_TYPES).toEqual(['retain_offer']);
    expect(offerBodySchema.safeParse({ ...body(), actionType: 'renew' }).success).toBe(false);
  });

  it('a patch never changes what an offer targets, or whose it is', () => {
    expect(offerPatchSchema.safeParse({ tenantId: TENANT, isActive: false }).success).toBe(true);
    for (const extra of [{ couponTemplateId: COUPON }, { variantId: VARIANT }, { actionType: 'retain_offer' }, { createdByUserId: ADMIN }]) {
      expect(offerPatchSchema.safeParse({ tenantId: TENANT, ...extra }).success).toBe(false);
    }
  });
});

describe('Offers.create (F-038-f1)', () => {
  it('stores an offer on the tenant’s own discount coupon, money exact', async () => {
    const { offers, tx } = fake();
    const view = await offers.create(body());
    expect(tx.aiOffer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: TENANT, couponTemplateId: COUPON, variantId: null, maxDiscountPercent: '20', dailyBudget: '1000000', currencyCode: 'IRR', createdByUserId: ADMIN }),
    });
    expect(view).toMatchObject({ id: OFFER, maxDiscountPercent: '20.00', dailyBudget: '1000000.00', currencyCode: 'IRR', target: { couponTemplateId: COUPON, variantId: null } });
  });

  it('refuses a template the tenant’s users cannot use, a deleted one, and one that is not a discount', async () => {
    expect(await refusal(fake({ coupon: null }).offers.create(body()))).toBe('template_not_found');
    expect(await refusal(fake({ coupon: coupon({ tenantId: OTHER }) }).offers.create(body()))).toBe('template_not_found');
    expect(await refusal(fake({ coupon: coupon({ tenantId: null }) }).offers.create(body()))).toBe('template_not_found');
    expect(await refusal(fake({ coupon: coupon({ deletedAt: NOW }) }).offers.create(body()))).toBe('template_not_found');
    for (const discountType of ['wallet_credit', 'free_grant']) {
      expect(await refusal(fake({ coupon: coupon({ discountType }) }).offers.create(body()))).toBe('template_not_a_discount');
    }
    expect(await refusal(fake({ coupon: coupon({ discountType: 'fixed_amount' }) }).offers.create(body()))).toBe('none');
  });

  it('refuses a variant the tenant does not sell any more', async () => {
    const v = body({ couponTemplateId: undefined, variantId: VARIANT });
    expect(await refusal(fake({ variant: null }).offers.create(v))).toBe('variant_not_found');
    expect(await refusal(fake({ variant: { id: VARIANT, isActive: false } }).offers.create(v))).toBe('variant_not_found');
    expect(await refusal(fake().offers.create(v))).toBe('none');
  });
});

describe('Offers.update and list (F-038-f1)', () => {
  it('edits only the tenant’s own offer', async () => {
    const { offers, tx } = fake({ offer: null });
    expect(await refusal(offers.update(OFFER, offerPatchSchema.parse({ tenantId: OTHER, name: 'mine now' })))).toBe('offer_not_found');
    expect(tx.aiOffer.update).not.toHaveBeenCalled();
    expect(tx.aiOffer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: OFFER, tenantId: OTHER } }));
  });

  it('switching an offer off stops every suggestion still queued with it', async () => {
    const { offers, tx } = fake();
    const view = await offers.update(OFFER, offerPatchSchema.parse({ tenantId: TENANT, isActive: false }));
    expect(view.isActive).toBe(false);
    expect(tx.aiAction.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, offerId: OFFER, status: { in: ['scheduled', 'awaiting_approval'] } },
      data: { status: 'suppressed', suppressedBy: 'offer_guardrail' },
    });
  });

  it('an edit that leaves it on touches no action', async () => {
    const { offers, tx } = fake();
    await offers.update(OFFER, offerPatchSchema.parse({ tenantId: TENANT, dailyBudget: '500000.50' }));
    expect(tx.aiOffer.update).toHaveBeenCalledWith({ where: { id: OFFER }, data: { dailyBudget: '500000.50' } });
    expect(tx.aiAction.updateMany).not.toHaveBeenCalled();
  });

  it('lists the tenant’s offers, newest first, amounts as strings', async () => {
    const { offers, tx } = fake();
    const items = await offers.list(TENANT);
    expect(tx.aiOffer.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT }, orderBy: { createdAt: 'desc' } }));
    expect(items).toEqual([expect.objectContaining({ id: OFFER, maxDiscountPercent: '20.00', dailyBudget: '1000000.00', isActive: true })]);
  });
});
