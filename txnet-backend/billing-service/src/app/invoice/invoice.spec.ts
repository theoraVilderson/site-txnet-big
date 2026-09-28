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
 *  - a network variant is sold only while its group has enough panels that
 *    could ever place it (F-111-i): a paid Grant nothing can place is only
 *    refunded an hour later;
 *  - the sweep's flip is guarded by the row's status, like the top-up sweep:
 *    an invoice paid between the scan and the write keeps its holds.
 */
import { FulfilmentKind, InvoiceStatus, Prisma, RedemptionStatus, VariantVisibility } from '@prisma/client';
import { TenantContext, runWithTenant } from '@txnet-backend/shared-core';

import { CouponReservationRefused } from '../payment/coupon/coupon-reservation';
import { INVOICE_TTL_MS, InvoiceNotCancellable, InvoiceService, InvoiceVariantNotFound } from './invoice.service';
import { InvoiceExpiryService } from './invoice-expiry.service';
import { invoiceCreateSchema } from './invoice.schema';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const PRICE = '66666666-6666-4666-8666-666666666666';
const COUPON = '77777777-7777-4777-8777-777777777777';
const GROUP = '88888888-8888-4888-8888-888888888888';
const INVOICE_1 = '88888888-8888-4888-8888-888888888881';
const INVOICE_2 = '88888888-8888-4888-8888-888888888882';

const D = (v: string) => new Prisma.Decimal(v);

/** A panel group as `deliverableGroupIds` reads it: the members its filter kept (F-111-i). */
type GroupRow = { id: string; minHealthyPanels: number; members: Array<{ panelId: string }> };
const groupRow = (o: Partial<GroupRow> = {}): GroupRow => ({ id: GROUP, minHealthyPanels: 1, members: [{ panelId: 'panel-1' }], ...o });
const asTenant = <T>(fn: () => Promise<T>, id = TENANT) => runWithTenant({ id }, fn);

type VariantOverrides = {
  visibility?: VariantVisibility;
  isActive?: boolean;
  productActive?: boolean;
  prices?: Array<{ id: string; amount: Prisma.Decimal; currencyCode: string; effectiveFrom: Date; isActive: boolean }>;
  fulfilmentKind?: FulfilmentKind;
  panelGroupId?: string | null;
  quotas?: Record<string, unknown>;
  billingMode?: 'prepaid' | 'metered';
};

/** A sold traffic limit (F-111-p): a prepaid network variant with none is not for sale. */
const traffic = (limit: number) => ({ traffic_bytes: { limit, resetPolicy: 'none' } });

function variantRow(o: VariantOverrides = {}) {
  return {
    id: VARIANT,
    sku: 'VPN-30',
    tenantId: null,
    nameKey: null,
    visibility: o.visibility ?? VariantVisibility.public,
    isActive: o.isActive ?? true,
    quotas: o.quotas ?? traffic(50 * 1024 ** 3),
    durationDays: 30,
    billingMode: o.billingMode ?? 'prepaid',
    qualityTier: 'standard',
    panelGroupId: o.panelGroupId === undefined ? GROUP : o.panelGroupId,
    product: {
      id: PRODUCT,
      key: 'vpn',
      nameKey: 'catalog.product.vpn.name',
      descriptionKey: null,
      fulfilmentKind: o.fulfilmentKind ?? FulfilmentKind.network_access,
      featureKeys: ['vpn'],
      isActive: o.productActive ?? true,
      categories: [
        { position: 0, category: { key: 'vpn', nameKey: 'catalog.category.vpn.name', isActive: true, parentId: null } },
        { position: 1, category: { key: 'old', nameKey: 'catalog.category.old.name', isActive: false, parentId: null } },
        { position: 2, category: { key: 'gold', nameKey: 'catalog.category.gold.name', isActive: true, parentId: null } },
      ],
    },
    prices: o.prices ?? [{ id: PRICE, amount: D('12.50'), currencyCode: 'USD', effectiveFrom: new Date('2026-01-01T00:00:00Z'), isActive: true }],
  };
}

type CreateSetup = {
  variant?: ReturnType<typeof variantRow> | null;
  /** What coupon validation answers; default: nothing applied. */
  validation?: { applied: Array<{ couponId: string; code: string; discount: Prisma.Decimal }>; rejected: Array<{ code: string; reason: string }> };
  refuseReservation?: boolean;
  /** Discount rules in the tenant (F-114-h), as `discountRule.findMany` returns them. */
  rules?: Array<Record<string, unknown>>;
  /** The panel groups the filter answers (F-111-i); default: one group with one deliverable panel. */
  groups?: GroupRow[];
};

function buildCreate(setup: CreateSetup = {}) {
  const variant = setup.variant === undefined ? variantRow() : setup.variant;
  const calls = {
    created: [] as Array<Record<string, unknown>>,
    validated: [] as Array<Record<string, unknown>>,
    reserved: [] as Array<Record<string, unknown>>,
    groupQueries: [] as unknown[],
  };
  const tx = {
    // Every tenant here keeps its books in USD (F-116-b).
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }), findFirst: async () => ({ operatingCurrencyCode: 'USD' }) },
    $executeRaw: async () => 0,
    productVariant: { findUnique: async () => variant },
    panelGroup: {
      findMany: async (q: unknown) => {
        calls.groupQueries.push(q);
        return setup.groups ?? [groupRow()];
      },
    },
    discountRule: { findMany: async () => setup.rules ?? [] },
    productCategoryLink: { findMany: async () => [] },
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
  it('takes the best discount rule first, validates the coupons against what it left, and records both (F-114-h)', async () => {
    const rule = {
      id: 'rule-1',
      name: 'Autumn',
      kind: 'percentage',
      value: D('20'),
      productId: PRODUCT,
      categoryId: null,
      forNamedUsers: false,
      groupId: null,
      users: [],
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: null,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const { service, calls } = buildCreate({
      rules: [rule],
      validation: { applied: [{ couponId: COUPON, code: 'SPRING', discount: D('1.00') }], rejected: [] },
    });

    const invoice = await asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: ['SPRING'] }));

    // 12.50 - 20% = 10.00 left for the coupons; the coupon takes 1.00 of that.
    expect((calls.validated[0]['amount'] as Prisma.Decimal).toFixed(2)).toBe('10.00');
    const row = calls.created[0];
    expect(row['discountRuleId']).toBe('rule-1');
    expect((row['ruleDiscount'] as Prisma.Decimal).toFixed(2)).toBe('2.50');
    expect((row['discount'] as Prisma.Decimal).toFixed(2)).toBe('3.50');
    expect((row['total'] as Prisma.Decimal).toFixed(2)).toBe('9.00');
    expect(invoice).toMatchObject({ amount: '12.50', discount: '3.50', total: '9.00', automaticDiscount: { ruleId: 'rule-1', name: 'Autumn', discount: '2.50' } });
  });

  it('asks no coupon engine when a rule took the whole price: every code is nothing_to_discount', async () => {
    const rule = { id: 'free', name: 'Gift', kind: 'percentage', value: D('100'), productId: null, categoryId: null, forNamedUsers: false, groupId: null, users: [], startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: null, isActive: true, createdAt: new Date('2026-01-01T00:00:00Z') };
    const { service, calls } = buildCreate({ rules: [rule] });

    const invoice = await asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: ['SPRING'] }));

    expect(calls.validated).toEqual([]);
    expect(invoice).toMatchObject({ discount: '12.50', total: '0.00', rejected: [{ code: 'SPRING', reason: 'nothing_to_discount' }] });
  });

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
    // F-111-d: nothing is sold that nothing can deliver.
    ['of a kind with no delivery (external order)', variantRow({ fulfilmentKind: FulfilmentKind.external_order })],
    ['a network service with no panel group', variantRow({ panelGroupId: null })],
    // F-111-p: a prepaid network Grant with no traffic is a 0-byte bag, refunded an hour later.
    ['a network service that states no traffic (VI_PI_AN_PRV-30D)', variantRow({ quotas: {} })],
  ])('refuses a variant that is %s, and writes nothing', async (_what, variant) => {
    const { service, calls } = buildCreate({ variant });

    await expect(asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: ['SPRING'] }))).rejects.toBeInstanceOf(
      InvoiceVariantNotFound,
    );
    expect(calls.created).toEqual([]);
    expect(calls.reserved).toEqual([]);
  });

  it.each([
    ['whose group has no panel left (its only one deleted)', [groupRow({ members: [] })]],
    ['whose group has fewer deliverable panels than minHealthyPanels', [groupRow({ minHealthyPanels: 2 })]],
    ['whose group is gone', []],
  ])('refuses a network variant %s, and writes nothing (F-111-i)', async (_what, groups) => {
    const { service, calls } = buildCreate({ groups });

    await expect(asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: ['SPRING'] }))).rejects.toBeInstanceOf(
      InvoiceVariantNotFound,
    );
    expect(calls.created).toEqual([]);
    expect(calls.reserved).toEqual([]);
  });

  it('counts a member only if it could ever place: not drain, not retired, accepted, selling one inbound — never its health (F-111-i)', async () => {
    const { service, calls } = buildCreate();
    await asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: [] }));

    expect(calls.groupQueries).toHaveLength(1);
    const q = calls.groupQueries[0] as { where: unknown; select: { members: { where: Record<string, unknown> } } };
    expect(q.where).toEqual({ id: { in: [GROUP] } });
    const members = q.select.members.where;
    // Selling one: an assigned inbound, or with none assigned one of the pool (F-027-ch).
    const placeable = { enabled: true, goneAt: null, protocol: { not: null } };
    expect(members).toEqual({
      role: { not: 'drain' },
      panel: { retiredAt: null, reviewState: { in: ['accepted', 'accepted_low_trust'] } },
      OR: [
        { inbounds: { some: { inbound: placeable } } },
        { inbounds: { none: {} }, panel: { inbounds: { some: { sold: true, ...placeable, assignment: { is: null } } } } },
      ],
    });
    expect(JSON.stringify(members)).not.toContain('panelState');
  });

  it('does not ask about panels for a feature variant', async () => {
    const { service, calls } = buildCreate({ variant: variantRow({ fulfilmentKind: FulfilmentKind.feature_access, panelGroupId: null }) });
    await asTenant(() => service.create({ userId: USER, variantId: VARIANT, couponCodes: [] }));
    expect(calls.created).toHaveLength(1);
    expect(calls.groupQueries).toEqual([]);
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
      variant: variantRow({ prices: [{ id: PRICE, amount: D('0'), currencyCode: 'USD', effectiveFrom: new Date('2026-01-01T00:00:00Z'), isActive: true }] }),
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

describe('InvoiceService.get — the invoice the shop comes back to (F-111-e)', () => {
  const ROW = {
    id: INVOICE_1,
    userId: USER,
    variantId: VARIANT,
    amount: D('12.50'),
    discount: D('2.50'),
    total: D('10.00'),
    status: InvoiceStatus.pending,
    expiresAt: new Date('2026-09-25T12:30:00Z'),
    variant: { sku: 'VPN-30', nameKey: null, product: { nameKey: 'catalog.product.vpn.name' } },
  };

  function buildGet(row: typeof ROW | null, redemptions: Array<{ discountAppliedAmount: Prisma.Decimal; coupon: { code: string } }> = []) {
    const asked = { invoice: [] as unknown[], redemptions: [] as unknown[] };
    const tx = {
      $executeRaw: async () => 0,
      invoice: {
        findFirst: async (q: unknown) => {
          asked.invoice.push(q);
          return row;
        },
      },
      couponRedemption: {
        findMany: async (q: unknown) => {
          asked.redemptions.push(q);
          return redemptions;
        },
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    return { service: new InvoiceService(prisma as never, {} as never, {} as never), asked };
  }

  it("reads only the caller's own invoice — another user's is the same null as a missing one", async () => {
    const { service, asked } = buildGet(null);
    await expect(asTenant(() => service.get(USER, INVOICE_1, new Date('2026-09-25T12:00:00Z')))).resolves.toBeNull();
    expect(asked.invoice[0]).toMatchObject({ where: { id: INVOICE_1, userId: USER } });
  });

  it('answers the figures it was priced at, and the codes it holds under its own id', async () => {
    const { service, asked } = buildGet(ROW, [{ discountAppliedAmount: D('2.50'), coupon: { code: 'SPRING' } }]);
    const got = await asTenant(() => service.get(USER, INVOICE_1, new Date('2026-09-25T12:00:00Z')));
    expect(got).toEqual({
      id: INVOICE_1,
      variantId: VARIANT,
      sku: 'VPN-30',
      nameKey: 'catalog.product.vpn.name',
      status: 'pending',
      amount: '12.50',
      discount: '2.50',
      total: '10.00',
      automaticDiscount: null,
      applied: [{ code: 'SPRING', discount: '2.50' }],
      expiresAt: ROW.expiresAt,
    });
    expect(asked.redemptions[0]).toMatchObject({
      where: { orderReferenceId: INVOICE_1, userId: USER, status: { in: [RedemptionStatus.pending, RedemptionStatus.confirmed] } },
    });
  });

  it('reads a pending invoice past its clock as expired, as the pay step does, before the sweep flips it', async () => {
    const { service } = buildGet(ROW);
    const got = await asTenant(() => service.get(USER, INVOICE_1, new Date('2026-09-25T12:30:00Z')));
    expect(got?.status).toBe('expired');
  });
});

describe('InvoiceService.forSale — what the shop lists (F-111-e)', () => {
  function buildList(rows: Array<ReturnType<typeof variantRow>>, groups: GroupRow[] = [groupRow()]) {
    const asked: unknown[] = [];
    const tx = {
      tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }) },
      $executeRaw: async () => 0,
      panelGroup: { findMany: async () => groups },
      productVariant: {
        findMany: async (q: unknown) => {
          asked.push(q);
          return rows;
        },
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    return { service: new InvoiceService(prisma as never, {} as never, {} as never), asked };
  }

  it('lists a listed, priced variant with the price in effect', async () => {
    const { service } = buildList([variantRow()]);
    const offers = await asTenant(() => service.forSale(new Date('2026-09-25T12:00:00Z')));
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ variantId: VARIANT, sku: 'VPN-30', productId: PRODUCT, price: { amount: '12.50' } });
  });

  it("names the product apart from the variant, and every live category it is filed in, in the product's order (F-114-d)", async () => {
    const { service } = buildList([{ ...variantRow(), nameKey: 'catalog.variant.vpn30.name' } as never]);
    const [offer] = await asTenant(() => service.forSale(new Date('2026-09-25T12:00:00Z')));
    expect(offer.nameKey).toBe('catalog.variant.vpn30.name');
    expect(offer.productNameKey).toBe('catalog.product.vpn.name');
    expect(offer.categories).toEqual([
      { key: 'vpn', nameKey: 'catalog.category.vpn.name' },
      { key: 'gold', nameKey: 'catalog.category.gold.name' },
    ]);
  });

  it('leaves out what nothing can deliver, so the shop never offers a buy that answers variantNotFound', async () => {
    const { service } = buildList([
      variantRow({ panelGroupId: null }),
      { ...variantRow({ fulfilmentKind: FulfilmentKind.external_order }), id: INVOICE_2 },
    ]);
    await expect(asTenant(() => service.forSale(new Date('2026-09-25T12:00:00Z')))).resolves.toEqual([]);
  });

  it('leaves out a network variant whose group has no deliverable panel, keeping the one that has (F-111-i)', async () => {
    const OTHER_GROUP = '99999999-9999-4999-8999-999999999999';
    const { service } = buildList(
      [variantRow(), { ...variantRow({ panelGroupId: OTHER_GROUP }), id: INVOICE_2 }],
      [groupRow(), groupRow({ id: OTHER_GROUP, members: [] })],
    );
    const offers = await asTenant(() => service.forSale(new Date('2026-09-25T12:00:00Z')));
    expect(offers.map((o) => o.variantId)).toEqual([VARIANT]);
  });

  it('leaves out a prepaid network variant with no traffic, keeping an unlimited (F-111-r) and a metered one (F-111-p)', async () => {
    const METERED = '88888888-8888-4888-8888-888888888888';
    const { service } = buildList([
      variantRow({ quotas: {} }),
      { ...variantRow({ quotas: traffic(0) }), id: INVOICE_2 },
      { ...variantRow({ quotas: {}, billingMode: 'metered' }), id: METERED },
    ]);
    const offers = await asTenant(() => service.forSale(new Date('2026-09-25T12:00:00Z')));
    expect(offers.map((o) => o.variantId)).toEqual([INVOICE_2, METERED]);
  });

  it('leaves out an unlisted variant: a direct link sells it, the list does not show it', async () => {
    const { service } = buildList([variantRow({ visibility: VariantVisibility.unlisted })]);
    await expect(asTenant(() => service.forSale(new Date('2026-09-25T12:00:00Z')))).resolves.toEqual([]);
  });
});

describe('InvoiceService.cancel — the shop replaces an invoice it will not pay (F-114-d)', () => {
  function buildCancel(opts: { matched: boolean; status?: InvoiceStatus | null }) {
    const calls = {
      updated: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
      released: [] as Array<{ id: string; outcome: RedemptionStatus }>,
      read: [] as unknown[],
    };
    const tx = {
      $executeRaw: async () => 0,
      invoice: {
        updateMany: async (q: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          calls.updated.push(q);
          return { count: opts.matched ? 1 : 0 };
        },
        findFirst: async (q: unknown) => {
          calls.read.push(q);
          return opts.status ? { status: opts.status } : null;
        },
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    const reservations = {
      release: async (_tx: unknown, id: string, outcome: RedemptionStatus) => {
        calls.released.push({ id, outcome });
        return 1;
      },
    };
    return { service: new InvoiceService(prisma as never, {} as never, reservations as never), calls };
  }

  it("cancels the caller's own pending invoice and gives its holds back at once, as cancelled", async () => {
    const { service, calls } = buildCancel({ matched: true });
    await expect(asTenant(() => service.cancel(USER, INVOICE_1))).resolves.toEqual({ id: INVOICE_1, status: 'cancelled' });
    expect(calls.updated).toEqual([
      { where: { id: INVOICE_1, userId: USER, status: InvoiceStatus.pending }, data: { status: InvoiceStatus.cancelled } },
    ]);
    expect(calls.released).toEqual([{ id: INVOICE_1, outcome: RedemptionStatus.cancelled }]);
  });

  it('answers an invoice already cancelled or expired as it is: it holds nothing, so there is nothing to refuse', async () => {
    for (const status of [InvoiceStatus.cancelled, InvoiceStatus.expired]) {
      const { service, calls } = buildCancel({ matched: false, status });
      await expect(asTenant(() => service.cancel(USER, INVOICE_1))).resolves.toEqual({ id: INVOICE_1, status });
      expect(calls.released).toEqual([]);
    }
  });

  it('refuses a paid (or refunded) invoice — its holds are uses now — and releases nothing', async () => {
    for (const status of [InvoiceStatus.paid, InvoiceStatus.refunded]) {
      const { service, calls } = buildCancel({ matched: false, status });
      await expect(asTenant(() => service.cancel(USER, INVOICE_1))).rejects.toMatchObject({ reason: 'already_paid' });
      expect(calls.released).toEqual([]);
    }
  });

  it("answers another user's invoice as a missing one", async () => {
    const { service, calls } = buildCancel({ matched: false, status: null });
    const refused = await asTenant(() => service.cancel(USER, INVOICE_1)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvoiceNotCancellable);
    expect(refused).toMatchObject({ reason: 'not_found' });
    expect(calls.read[0]).toMatchObject({ where: { id: INVOICE_1, userId: USER } });
  });
});
