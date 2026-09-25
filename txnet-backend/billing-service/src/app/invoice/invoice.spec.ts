/**
 * An invoice for one catalog variant (F-111-a, spec §5.8 step 1), and the
 * clock that closes the ones nobody paid.
 *
 * What would break silently here, and nowhere else:
 *  - the price is the catalog's, in effect now — never a number the client
 *    sent. The body schema strips one, and the service takes none;
 *  - a variant that is not for sale (switched off, `admin_only`, no price in
 *    effect, another tenant's — RLS answers null) is one neutral refusal, and
 *    nothing is written;
 *  - the coupons are validated against **this** variant and product, and held
 *    under the invoice's own id, so the pay step (F-111-b) confirms exactly
 *    them and the sweep releases exactly them;
 *  - the sweep's flip is guarded by the row's status, like the top-up sweep:
 *    an invoice paid between the scan and the write keeps its holds.
 */
import { InvoiceStatus, Prisma, RedemptionStatus, VariantVisibility } from '@prisma/client';
import { TenantContext, runWithTenant } from '@txnet-backend/shared-core';

import { CouponReservationRefused } from '../payment/coupon/coupon-reservation';
import { INVOICE_TTL_MS, InvoiceService, InvoiceVariantNotFound } from './invoice.service';
import { InvoiceExpiryService } from './invoice-expiry.service';
import { invoiceCreateSchema } from './invoice.schema';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const PRICE = '66666666-6666-4666-8666-666666666666';
const COUPON = '77777777-7777-4777-8777-777777777777';
const INVOICE_1 = '88888888-8888-4888-8888-888888888881';
const INVOICE_2 = '88888888-8888-4888-8888-888888888882';

const D = (v: string) => new Prisma.Decimal(v);
const asTenant = <T>(fn: () => Promise<T>, id = TENANT) => runWithTenant({ id }, fn);

type VariantOverrides = {
  visibility?: VariantVisibility;
  isActive?: boolean;
  productActive?: boolean;
  prices?: Array<{ id: string; amount: Prisma.Decimal; effectiveFrom: Date; isActive: boolean }>;
};

function variantRow(o: VariantOverrides = {}) {
  return {
    id: VARIANT,
    sku: 'VPN-30',
    tenantId: null,
    nameKey: null,
    visibility: o.visibility ?? VariantVisibility.public,
    isActive: o.isActive ?? true,
    quotas: {},
    durationDays: 30,
    billingMode: 'prepaid',
    qualityTier: 'standard',
    product: {
      id: PRODUCT,
      key: 'vpn',
      nameKey: 'catalog.product.vpn.name',
      descriptionKey: null,
      fulfilmentKind: 'vpn_config',
      featureKeys: ['vpn'],
      isActive: o.productActive ?? true,
      category: { key: 'vpn', isActive: true },
    },
    prices: o.prices ?? [{ id: PRICE, amount: D('12.50'), effectiveFrom: new Date('2026-01-01T00:00:00Z'), isActive: true }],
  };
}

type CreateSetup = {
  variant?: ReturnType<typeof variantRow> | null;
  /** What coupon validation answers; default: nothing applied. */
  validation?: { applied: Array<{ couponId: string; code: string; discount: Prisma.Decimal }>; rejected: Array<{ code: string; reason: string }> };
  refuseReservation?: boolean;
};

function buildCreate(setup: CreateSetup = {}) {
  const variant = setup.variant === undefined ? variantRow() : setup.variant;
  const calls = {
    created: [] as Array<Record<string, unknown>>,
    validated: [] as Array<Record<string, unknown>>,
    reserved: [] as Array<Record<string, unknown>>,
  };
  const tx = {
    $executeRaw: async () => 0,
    productVariant: { findUnique: async () => variant },
    invoice: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.created.push(data);
        return { ...data, createdAt: new Date() };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const coupons = {
    validate: async (_tx: unknown, request: Record<string, unknown>) => {
      calls.validated.push(request);
      const v = setup.validation ?? { applied: [], rejected: [] };
      const amount = request['amount'] as Prisma.Decimal;
      const total = v.applied.reduce((s, a) => s.plus(a.discount), D('0'));
      return { ...v, totalDiscount: total, payable: amount.minus(total) };
    },
  };
  const reservations = {
    reserve: async (_tx: unknown, r: Record<string, unknown>) => {
      if (setup.refuseReservation) throw new CouponReservationRefused('SPRING', 'capacity_reached');
      calls.reserved.push(r);
    },
  };
  const service = new InvoiceService(prisma as never, coupons as never, reservations as never);
  return { service, calls };
}

describe('POST /api/billing/invoices — the body', () => {
  it('drops a price the client sent: there is nothing to validate it against, because it is never read', () => {
    const body = invoiceCreateSchema.parse({ variantId: VARIANT, price: '0.01', amount: '0.01', total: '0' });
    expect(body).toEqual({ variantId: VARIANT, couponCodes: [] });
  });
});

describe('InvoiceService.create', () => {
  it('prices the invoice from the catalog in effect now, in USD, and stores it pending for 30 minutes', async () => {
    const { service, calls } = buildCreate();
    const before = Date.now();

    const invoice = await asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: [] }));

    expect(calls.created).toHaveLength(1);
    const row = calls.created[0];
    expect(row).toMatchObject({ tenantId: TENANT, userId: USER, variantId: VARIANT, priceId: PRICE, status: InvoiceStatus.pending });
    expect((row['amount'] as Prisma.Decimal).toFixed(2)).toBe('12.50');
    expect((row['discount'] as Prisma.Decimal).toFixed(2)).toBe('0.00');
    expect((row['total'] as Prisma.Decimal).toFixed(2)).toBe('12.50');
    const expiresAt = (row['expiresAt'] as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + INVOICE_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + INVOICE_TTL_MS);
    expect(INVOICE_TTL_MS).toBe(30 * 60 * 1000);
    expect(invoice).toMatchObject({ id: row['id'], amount: '12.50', discount: '0.00', total: '12.50', rejected: [] });
  });

  it('validates coupons against this variant and holds them under the invoice id', async () => {
    const { service, calls } = buildCreate({
      validation: { applied: [{ couponId: COUPON, code: 'SPRING', discount: D('2.50') }], rejected: [{ code: 'OLD', reason: 'expired' }] },
    });

    const invoice = await asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: ['spring', 'old'] }));

    expect(calls.validated[0]).toMatchObject({
      codes: ['spring', 'old'],
      target: { kind: 'purchase', productId: PRODUCT, variantId: VARIANT },
      userId: USER,
    });
    expect((calls.validated[0]['amount'] as Prisma.Decimal).toFixed(2)).toBe('12.50');
    expect(calls.reserved).toEqual([
      { userId: USER, orderReferenceId: invoice.id, applied: [{ couponId: COUPON, code: 'SPRING', discount: D('2.50') }] },
    ]);
    expect(invoice).toMatchObject({ discount: '2.50', total: '10.00', rejected: [{ code: 'OLD', reason: 'expired' }] });
    expect((calls.created[0]['total'] as Prisma.Decimal).toFixed(2)).toBe('10.00');
  });

  it.each([
    ['unknown, or another tenant’s (RLS answers nothing)', null],
    ['admin_only', variantRow({ visibility: VariantVisibility.admin_only })],
    ['switched off', variantRow({ isActive: false })],
    ['under a switched-off product', variantRow({ productActive: false })],
    ['with no price in effect', variantRow({ prices: [] })],
  ])('refuses a variant that is %s, and writes nothing', async (_what, variant) => {
    const { service, calls } = buildCreate({ variant });

    await expect(asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: ['SPRING'] }))).rejects.toBeInstanceOf(
      InvoiceVariantNotFound,
    );
    expect(calls.created).toEqual([]);
    expect(calls.reserved).toEqual([]);
  });

  it('sells an unlisted variant: a direct link is a way to buy it', async () => {
    const { service, calls } = buildCreate({ variant: variantRow({ visibility: VariantVisibility.unlisted }) });
    await asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: [] }));
    expect(calls.created).toHaveLength(1);
  });

  it('lets a hold that can no longer be taken abort the whole transaction', async () => {
    const { service } = buildCreate({
      validation: { applied: [{ couponId: COUPON, code: 'SPRING', discount: D('2.50') }], rejected: [] },
      refuseReservation: true,
    });
    await expect(asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: ['SPRING'] }))).rejects.toBeInstanceOf(
      CouponReservationRefused,
    );
  });

  it('prices a free variant at zero without asking the coupon engine, and rejects every code as nothing to discount', async () => {
    const { service, calls } = buildCreate({
      variant: variantRow({ prices: [{ id: PRICE, amount: D('0'), effectiveFrom: new Date('2026-01-01T00:00:00Z'), isActive: true }] }),
    });
    const invoice = await asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: [' spring '] }));
    expect(calls.validated).toEqual([]);
    expect(invoice).toMatchObject({ total: '0.00', rejected: [{ code: 'SPRING', reason: 'nothing_to_discount' }] });
  });
});

describe('InvoiceExpiryService.expirePending', () => {
  function buildExpiry(due: Array<{ id: string; tenantId: string }>, lost: string[] = []) {
    const calls = {
      updated: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown>; tenant: string | null }>,
      released: [] as Array<{ id: string; outcome: string; tenant: string | null }>,
    };
    const scoped = () => TenantContext.currentOrNull()?.id ?? null;
    const tx = {
      $executeRaw: async () => 0,
      invoice: {
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          calls.updated.push({ where, data, tenant: scoped() });
          return { count: lost.includes(where['id'] as string) ? 0 : 1 };
        },
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    const crossTenant = { invoice: { findMany: async () => due } };
    const reservations = {
      release: async (_tx: unknown, id: string, outcome: RedemptionStatus) => {
        calls.released.push({ id, outcome, tenant: scoped() });
        return 1;
      },
    };
    const config = { get: () => 200 };
    return { service: new InvoiceExpiryService(prisma as never, crossTenant as never, reservations as never, config as never), calls };
  }

  it('expires a due pending invoice in its own tenant and gives its holds back as expired', async () => {
    const { service, calls } = buildExpiry([
      { id: INVOICE_1, tenantId: TENANT },
      { id: INVOICE_2, tenantId: TENANT_B },
    ]);

    const result = await service.expirePending();

    expect(result).toEqual({ scanned: 2, expired: 2, holdsReleased: 2 });
    expect(calls.updated.map((u) => [u.where['id'], u.where['status'], u.data['status'], u.tenant])).toEqual([
      [INVOICE_1, InvoiceStatus.pending, InvoiceStatus.expired, TENANT],
      [INVOICE_2, InvoiceStatus.pending, InvoiceStatus.expired, TENANT_B],
    ]);
    expect(calls.released).toEqual([
      { id: INVOICE_1, outcome: RedemptionStatus.expired, tenant: TENANT },
      { id: INVOICE_2, outcome: RedemptionStatus.expired, tenant: TENANT_B },
    ]);
  });

  it('keeps the holds of an invoice paid between the scan and the flip', async () => {
    const { service, calls } = buildExpiry([{ id: INVOICE_1, tenantId: TENANT }], [INVOICE_1]);

    const result = await service.expirePending();

    expect(result).toEqual({ scanned: 1, expired: 0, holdsReleased: 0 });
    expect(calls.released).toEqual([]);
  });
});
