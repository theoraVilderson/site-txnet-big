/**
 * Coupon management (F-502-c, D-33, ADR-0048): who may create, change and
 * delete which coupon, and what a coupon that was used may no longer become.
 *
 * The class reads and writes on the cross-tenant pool, so the boundary is its
 * own checks, and every way it breaks is silent:
 *
 *  - **ownership.** The platform owner manages platform coupons and every
 *    tenant's; any other tenant only its own. Another tenant's coupon is *not
 *    found*, so the surface never confirms it exists;
 *  - **whose users.** A targeted user lives in a tenant the coupon serves — the
 *    coupon's own tenant, or for a platform coupon the tenants it names (none =
 *    the platform owner's). A coupon for a reseller's own account is therefore a
 *    coupon of the tenant that account lives in;
 *  - **a used coupon.** Its type and value are frozen — a receipt already says
 *    what it took — and its capacity cannot drop below used + reserved, or a
 *    hold already taken would outnumber the slots;
 *  - **delete.** Hard when nothing ever redeemed it, soft otherwise, so a
 *    receipt can still be explained;
 *  - **audit.** Every write leaves a row naming the actor and what changed.
 */
import { DiscountType, TenantType } from '@prisma/client';

import { CouponAdminRefused, CouponAdminService } from './coupon-admin.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const RESELLER_USER = '55555555-5555-4555-8555-555555555555';
const OWNER_USER = '66666666-6666-4666-8666-666666666666';
const RESELLER_COUPON = '77777777-7777-4777-8777-777777777777';
const OTHER_COUPON = '88888888-8888-4888-8888-888888888888';
const PLATFORM_COUPON = '99999999-9999-4999-8999-999999999999';
const PLATFORM_GW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESELLER_GW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_GW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const actor = (tenantId: string) => ({ adminId: ADMIN, tenantId, ip: '10.0.0.9' });

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v !== null && typeof v === 'object' && 'in' in (v as Row)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

function table(rows: Row[], name: string, writes: string[]) {
  let next = 0;
  return {
    rows,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      writes.push(`${name}.create`);
      const row = { id: `00000000-0000-4000-8000-0000000000${String(next++).padStart(2, '0')}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      writes.push(`${name}.createMany`);
      rows.push(...data);
      return { count: data.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.update`);
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}: no row`);
      return Object.assign(row, data);
    },
    delete: async ({ where }: { where: Row }) => {
      writes.push(`${name}.delete`);
      const i = rows.findIndex((r) => matches(r, where));
      if (i < 0) throw new Error(`${name}: no row`);
      return rows.splice(i, 1)[0];
    },
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      writes.push(`${name}.deleteMany`);
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
  };
}

const coupon = (over: Row): Row => ({
  code: 'NOWRUZ',
  discountType: DiscountType.percentage,
  discountValue: '10',
  maxDiscountCap: null,
  minPurchaseAmount: null,
  maxPurchaseAmount: null,
  totalUsageLimit: null,
  perUserUsageLimit: 1,
  usedCount: 0,
  reservedCount: 0,
  expiresAt: null,
  validFrom: null,
  isActive: true,
  visibility: 'public',
  activeWeekdays: [],
  activeHourFrom: null,
  activeHourTo: null,
  firstPurchaseOnly: false,
  newUserWithinDays: null,
  periodUsageLimit: null,
  periodDays: null,
  allowedChannels: [],
  label: null,
  note: null,
  batchId: null,
  deletedAt: null,
  deletedByAdminId: null,
  createdByAdminId: ADMIN,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function build(seed: { redemptions?: Row[]; coupons?: Row[] } = {}) {
  const writes: string[] = [];
  const audit: Row[] = [];
  const types: Record<string, TenantType> = { [OWNER]: TenantType.platform_owner, [RESELLER]: TenantType.reseller, [OTHER]: TenantType.reseller };
  const db = {
    tenant: table(Object.entries(types).map(([id, tenantType]) => ({ id, tenantType })), 'tenant', writes),
    user: table([{ id: RESELLER_USER, tenantId: RESELLER }, { id: OWNER_USER, tenantId: OWNER }], 'user', writes),
    coupon: table(
      seed.coupons ?? [
        coupon({ id: RESELLER_COUPON, tenantId: RESELLER }),
        coupon({ id: OTHER_COUPON, tenantId: OTHER }),
        coupon({ id: PLATFORM_COUPON, tenantId: null, code: 'WELCOME' }),
      ],
      'coupon',
      writes,
    ),
    couponTenant: table([], 'couponTenant', writes),
    couponAllowedUser: table([], 'couponAllowedUser', writes),
    couponGateway: table([], 'couponGateway', writes),
    couponServiceScope: table([], 'couponServiceScope', writes),
    couponRedemption: table(seed.redemptions ?? [], 'couponRedemption', writes),
    paymentGateway: table([{ id: PLATFORM_GW }], 'paymentGateway', writes),
    tenantGatewayConfig: table([{ id: RESELLER_GW, tenantId: RESELLER }, { id: OTHER_GW, tenantId: OTHER }], 'tenantGatewayConfig', writes),
    paymentGatewayGrant: table([], 'paymentGatewayGrant', writes),
    product: table([], 'product', writes),
    productVariant: table([], 'productVariant', writes),
    adminAuditLog: {
      create: async ({ data }: { data: Row }) => {
        writes.push('audit');
        audit.push(data);
        return data;
      },
    },
  };
  const all = { ...db, $transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db) };
  const app = { tenant: { findUnique: async ({ where }: { where: Row }) => (types[where['id'] as string] ? { tenantType: types[where['id'] as string] } : null) } };
  return { service: new CouponAdminService(app as never, all as never), db, writes, audit };
}

async function refusal(run: () => Promise<unknown>): Promise<CouponAdminRefused> {
  try {
    await run();
  } catch (e) {
    if (e instanceof CouponAdminRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const DISCOUNT = { code: 'yalda', discountType: 'percentage', discountValue: '15' } as const;

describe('CouponAdminService — who may manage which coupon', () => {
  it('refuses a platform coupon, or another tenant’s, to a reseller', async () => {
    const { service, audit } = build();
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, tenantId: null }))).reason).toBe('not_platform_owner');
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, tenantId: OTHER }))).reason).toBe('not_platform_owner');
    expect(audit).toHaveLength(0);
  });

  it('lets the platform owner create a coupon for another tenant, audited against that tenant', async () => {
    const { service, db, audit } = build();
    const view = await service.create(actor(OWNER), { ...DISCOUNT, tenantId: OTHER });
    expect(view.tenantId).toBe(OTHER);
    expect(view.code).toBe('YALDA');
    expect(db.coupon.rows.find((r) => r['id'] === view.id)?.['createdByAdminId']).toBe(ADMIN);
    expect(audit).toEqual([expect.objectContaining({ action: 'coupon_create', targetEntityType: 'coupon', targetEntityId: view.id, tenantId: OTHER, adminId: ADMIN })]);
  });

  it('answers another tenant’s coupon and a platform coupon as not found to a reseller', async () => {
    const { service } = build();
    for (const id of [OTHER_COUPON, PLATFORM_COUPON]) {
      expect((await refusal(() => service.update(actor(RESELLER), id, { isActive: false }))).reason).toBe('coupon_not_found');
      expect((await refusal(() => service.remove(actor(RESELLER), id))).reason).toBe('coupon_not_found');
      expect((await refusal(() => service.get(actor(RESELLER), id))).reason).toBe('coupon_not_found');
    }
  });

  it('keeps a reseller’s list to its own coupons whatever it asks for', async () => {
    const { service } = build();
    const page = await service.list(actor(RESELLER), { tenantId: OTHER });
    expect(page.items.map((c) => c.id)).toEqual([RESELLER_COUPON]);
    const all = await service.list(actor(OWNER), {});
    expect(all.items).toHaveLength(3);
  });
});

describe('CouponAdminService — codes, users, gateways', () => {
  it('refuses a live code already taken inside the same tenant, but not in another', async () => {
    const { service } = build();
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, code: 'nowruz' }))).reason).toBe('code_taken');
    await expect(service.create(actor(OWNER), { ...DISCOUNT, code: 'NOWRUZ', tenantId: null })).resolves.toMatchObject({ code: 'NOWRUZ', tenantId: null });
  });

  it('names served tenants on a platform coupon only', async () => {
    const { service } = build();
    expect((await refusal(() => service.create(actor(OWNER), { ...DISCOUNT, tenantId: RESELLER, tenantIds: [OTHER] }))).reason).toBe('tenants_are_platform_coupons');
    const view = await service.create(actor(OWNER), { ...DISCOUNT, tenantId: null, tenantIds: [RESELLER] });
    expect(view.tenantIds).toEqual([RESELLER]);
  });

  it('refuses a targeted user who lives outside the tenants the coupon serves', async () => {
    const { service } = build();
    // A reseller's coupon, and a user of the platform owner.
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, visibility: 'targeted', allowedUserIds: [OWNER_USER] }))).reason).toBe('user_out_of_scope');
    // A platform coupon naming no tenant serves the platform owner's users only — a reseller's account is not one.
    expect((await refusal(() => service.create(actor(OWNER), { ...DISCOUNT, tenantId: null, visibility: 'targeted', allowedUserIds: [RESELLER_USER] }))).reason).toBe('user_out_of_scope');
    // Named, it is.
    await expect(service.create(actor(OWNER), { ...DISCOUNT, tenantId: null, tenantIds: [RESELLER], visibility: 'targeted', allowedUserIds: [RESELLER_USER] })).resolves.toMatchObject({ allowedUserIds: [RESELLER_USER] });
    // And targeted with nobody named would serve nobody.
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, visibility: 'targeted' }))).reason).toBe('targeted_needs_users');
  });

  it('limits a platform coupon to platform gateways, and a tenant coupon to gateways it can take payments on', async () => {
    const { service } = build();
    expect((await refusal(() => service.create(actor(OWNER), { ...DISCOUNT, tenantId: null, gateways: [{ source: 'tenant', id: RESELLER_GW }] }))).reason).toBe('platform_coupon_needs_platform_gateway');
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, gateways: [{ source: 'tenant', id: OTHER_GW }] }))).reason).toBe('gateway_not_found');
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, gateways: [{ source: 'platform', id: PLATFORM_GW }] }))).reason).toBe('gateway_not_found');
    await expect(service.create(actor(RESELLER), { ...DISCOUNT, gateways: [{ source: 'tenant', id: RESELLER_GW }] })).resolves.toMatchObject({ gateways: [{ source: 'tenant', id: RESELLER_GW }] });
  });
});

describe('CouponAdminService — what a value may be', () => {
  it('refuses a percentage above 100, a cap on a fixed discount, and a half-set window', async () => {
    const { service } = build();
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, discountValue: '101' }))).reason).toBe('invalid_value');
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, discountType: 'fixed_amount', maxDiscountCap: '5' }))).reason).toBe('invalid_value');
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, activeHourFrom: 22 }))).reason).toBe('invalid_limit');
    expect((await refusal(() => service.create(actor(RESELLER), { ...DISCOUNT, validFrom: '2026-10-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z' }))).reason).toBe('invalid_limit');
  });

  it('keeps purchase limits off a gift code', async () => {
    const { service } = build();
    expect((await refusal(() => service.create(actor(RESELLER), { code: 'GIFT1', discountType: 'wallet_credit', discountValue: '5', firstPurchaseOnly: true }))).reason).toBe('limits_not_for_gift_codes');
  });
});

describe('CouponAdminService — a coupon that was used', () => {
  const used = () =>
    build({
      coupons: [coupon({ id: RESELLER_COUPON, tenantId: RESELLER, usedCount: 3, reservedCount: 2, totalUsageLimit: 10 })],
      redemptions: [{ id: 'r1', couponId: RESELLER_COUPON, status: 'confirmed' }],
    });

  it('freezes its type and value', async () => {
    const { service } = used();
    expect((await refusal(() => service.update(actor(RESELLER), RESELLER_COUPON, { discountValue: '50' }))).reason).toBe('used_coupon_frozen');
    expect((await refusal(() => service.update(actor(RESELLER), RESELLER_COUPON, { discountType: 'fixed_amount' }))).reason).toBe('used_coupon_frozen');
    // Restating the same value is not a change.
    await expect(service.update(actor(RESELLER), RESELLER_COUPON, { discountValue: '10.00', label: 'autumn' })).resolves.toMatchObject({ label: 'autumn' });
  });

  it('never lets its capacity drop below used + reserved', async () => {
    const { service } = used();
    expect((await refusal(() => service.update(actor(RESELLER), RESELLER_COUPON, { totalUsageLimit: 4 }))).reason).toBe('capacity_below_used');
    await expect(service.update(actor(RESELLER), RESELLER_COUPON, { totalUsageLimit: 5 })).resolves.toMatchObject({ totalUsageLimit: 5 });
  });

  it('audits an edit with only the columns that changed', async () => {
    const { service, audit } = used();
    await service.update(actor(RESELLER), RESELLER_COUPON, { isActive: false, label: 'paused' });
    expect(audit).toEqual([
      expect.objectContaining({ action: 'coupon_update', tenantId: RESELLER, oldValue: { isActive: true, label: null }, newValue: { isActive: false, label: 'paused' } }),
    ]);
  });
});

describe('CouponAdminService — delete', () => {
  it('deletes a coupon nothing redeemed, with its child rows', async () => {
    const { service, db, audit } = build();
    await service.update(actor(RESELLER), RESELLER_COUPON, { visibility: 'targeted', allowedUserIds: [RESELLER_USER] });
    const out = await service.remove(actor(RESELLER), RESELLER_COUPON);
    expect(out.mode).toBe('deleted');
    expect(db.coupon.rows.find((r) => r['id'] === RESELLER_COUPON)).toBeUndefined();
    expect(db.couponAllowedUser.rows).toHaveLength(0);
    expect(audit.at(-1)).toMatchObject({ action: 'coupon_delete', newValue: { mode: 'deleted', redemptions: 0 } });
  });

  it('soft-deletes a coupon something redeemed, and it is not found afterwards', async () => {
    const { service, db } = build({
      coupons: [coupon({ id: RESELLER_COUPON, tenantId: RESELLER, usedCount: 1 })],
      redemptions: [{ id: 'r1', couponId: RESELLER_COUPON, status: 'expired' }],
    });
    const out = await service.remove(actor(RESELLER), RESELLER_COUPON);
    expect(out.mode).toBe('soft_deleted');
    expect(db.coupon.rows[0]).toMatchObject({ isActive: false, deletedByAdminId: ADMIN });
    expect(db.coupon.rows[0]['deletedAt']).toBeInstanceOf(Date);
    expect((await refusal(() => service.update(actor(RESELLER), RESELLER_COUPON, { isActive: true }))).reason).toBe('coupon_not_found');
  });
});
