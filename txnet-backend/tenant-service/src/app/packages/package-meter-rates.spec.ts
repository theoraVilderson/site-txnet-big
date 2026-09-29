import { Prisma } from '@prisma/client';

import { createPackageSchema, updatePackageSchema } from './tenant-package.schema';
import { TenantPackageService } from './tenant-package.service';

/**
 * The invariants F-118-n1 turns on: the wholesale price list on a reseller
 * package (ADR-0105 (10), user 2026-09-29).
 *
 * - A rate is history: a new price is a new row, the old one untouched; the
 *   same price again writes nothing; `null` switches the meter's rates off.
 * - Every row is in the package's currency — the platform's.
 * - A meter the catalog does not have is `meter_not_found`, before anything
 *   is written.
 * - The audit row carries the rates before and after.
 */
describe('a package prices platform meters (F-118-n1)', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const PKG = '33333333-3333-3333-3333-333333333333';
  const GIB = '1073741824';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  type RateRow = { id: string; packageId: string; meterKey: string; unitSize: bigint; unitPrice: Prisma.Decimal; currencyCode: string; effectiveFrom: Date; createdAt: Date };
  const rate = (unitPrice: string, over: Partial<RateRow> = {}): RateRow => ({
    id: 'rate-1',
    packageId: PKG,
    meterKey: 'vpn.traffic',
    unitSize: BigInt(GIB),
    unitPrice: new Prisma.Decimal(unitPrice),
    currencyCode: 'USD',
    effectiveFrom: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  });

  const pkg = {
    id: PKG,
    name: 'Growth',
    monthlyPrice: { toString: () => '150' },
    yearlyPrice: null,
    currencyCode: 'USD',
    includedFeatureKeys: [],
    isActive: true,
  };

  const build = (opts: { rates?: RateRow[]; meters?: string[] } = {}) => {
    const writes: string[] = [];
    const rates = [...(opts.rates ?? [])];
    const rateTable = {
      findMany: vi.fn(async () => rates),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(`rate:${data.meterKey}`);
        const row = rate(String(data.unitPrice), { id: `rate-${rates.length + 1}`, meterKey: String(data.meterKey), unitSize: BigInt(String(data.unitSize)), effectiveFrom: new Date(), createdAt: new Date() });
        rates.unshift(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where }: { where: { meterKey: string } }) => {
        writes.push(`off:${where.meterKey}`);
        rates.splice(0, rates.length, ...rates.filter((r) => r.meterKey !== where.meterKey));
        return { count: 1 };
      }),
    };
    const meter = { findMany: vi.fn(async () => (opts.meters ?? ['vpn.traffic']).map((key) => ({ key }))) };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      tenant: { findFirst: vi.fn(async () => ({ operatingCurrencyCode: 'USD' })) },
      tenantFeaturePackage: {
        findUnique: vi.fn(async () => pkg),
        create: vi.fn(async () => (writes.push('create'), pkg)),
        update: vi.fn(async () => (writes.push('update'), pkg)),
      },
      tenantPackageMeterRate: rateTable,
      meter,
      adminAuditLog: { create: vi.fn(async () => (writes.push('audit'), {})) },
      tenantSubscription: { count: vi.fn(async () => 0) },
    };
    const prisma = {
      tenant: { findUnique: vi.fn(async () => ({ tenantType: 'platform_owner' })) },
      tenantFeaturePackage: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string; name?: string } }) => (where.name !== undefined ? null : pkg)),
        findMany: vi.fn(async () => [pkg]),
      },
      tenantPackageMeterRate: rateTable,
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { service: new TenantPackageService(prisma as never, prisma as never), tx, writes };
  };

  const auditOf = (tx: ReturnType<typeof build>['tx']) => (tx.adminAuditLog.create.mock.calls[0] as unknown as [{ data: { oldValue: unknown; newValue: unknown } }])[0].data;

  it('creates the package with one rate row per meter, in its currency, and shows and audits them', async () => {
    const { service, tx, writes } = build();
    const view = await service.create(actor, { name: 'Growth', monthlyPrice: '150', includedFeatureKeys: [], meterRates: [{ meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: '0.9' }] });
    expect(writes).toEqual(['create', 'rate:vpn.traffic', 'audit']);
    const data = (tx.tenantPackageMeterRate.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ packageId: PKG, meterKey: 'vpn.traffic', unitSize: BigInt(GIB), unitPrice: '0.9', currencyCode: 'USD', createdByAdminId: ADMIN });
    expect(view.meterRates).toEqual([expect.objectContaining({ meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: '0.9' })]);
    expect(auditOf(tx).newValue).toMatchObject({ meterRates: [expect.objectContaining({ meterKey: 'vpn.traffic', unitPrice: '0.9' })] });
  });

  it('appends a new price and leaves the old row as it was', async () => {
    const { service, tx, writes } = build({ rates: [rate('0.9')] });
    const view = await service.update(actor, PKG, { meterRates: [{ meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: '1.1' }] });
    expect(writes).toEqual(['update', 'rate:vpn.traffic', 'audit']);
    expect(tx.tenantPackageMeterRate.updateMany).not.toHaveBeenCalled();
    expect(view.meterRates).toEqual([expect.objectContaining({ unitPrice: '1.1' })]);
    expect(auditOf(tx)).toMatchObject({
      oldValue: { meterRates: [expect.objectContaining({ unitPrice: '0.9' })] },
      newValue: { meterRates: [expect.objectContaining({ unitPrice: '1.1' })] },
    });
  });

  it('writes nothing for the price already in force', async () => {
    const { service, writes } = build({ rates: [rate('0.90')] });
    await service.update(actor, PKG, { meterRates: [{ meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: '0.9' }] });
    expect(writes).not.toContain('rate:vpn.traffic');
  });

  it('switches a meter off with null: every active row of it, so an older one does not come back', async () => {
    const { service, tx, writes } = build({ rates: [rate('0.9')] });
    const view = await service.update(actor, PKG, { meterRates: [{ meterKey: 'vpn.traffic', unitPrice: null }] });
    expect(writes).toEqual(['update', 'off:vpn.traffic', 'audit']);
    expect(tx.tenantPackageMeterRate.updateMany).toHaveBeenCalledWith({ where: { packageId: PKG, meterKey: 'vpn.traffic', isActive: true }, data: { isActive: false } });
    expect(view.meterRates).toEqual([]);
  });

  it('refuses a meter the catalog does not have, with nothing written', async () => {
    const { service, writes } = build({ meters: [] });
    await expect(service.update(actor, PKG, { meterRates: [{ meterKey: 'sms.sent', unitSize: '1', unitPrice: '0.02' }] })).rejects.toMatchObject({ reason: 'meter_not_found' });
    expect(writes).toEqual([]);
  });

  it('takes a rate as strings: a positive price to 8 places, a whole unit of at least 1, each meter once', () => {
    const base = { name: 'Growth', monthlyPrice: '150', includedFeatureKeys: [] };
    const ok = { meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: '0.12345678' };
    expect(createPackageSchema.safeParse({ ...base, meterRates: [ok] }).success).toBe(true);
    expect(createPackageSchema.safeParse({ ...base, meterRates: [{ ...ok, unitPrice: '0' }] }).success).toBe(false);
    expect(createPackageSchema.safeParse({ ...base, meterRates: [{ ...ok, unitPrice: '0.123456789' }] }).success).toBe(false);
    expect(createPackageSchema.safeParse({ ...base, meterRates: [{ ...ok, unitPrice: 0.9 }] }).success).toBe(false);
    expect(createPackageSchema.safeParse({ ...base, meterRates: [{ ...ok, unitSize: '0' }] }).success).toBe(false);
    expect(createPackageSchema.safeParse({ ...base, meterRates: [{ ...ok, currencyCode: 'USD' }] }).success).toBe(false);
    expect(createPackageSchema.safeParse({ ...base, meterRates: [ok, ok] }).success).toBe(false);
    // Nothing to switch off on a package that has no rates yet.
    expect(createPackageSchema.safeParse({ ...base, meterRates: [{ meterKey: 'vpn.traffic', unitPrice: null }] }).success).toBe(false);
    expect(updatePackageSchema.safeParse({ meterRates: [{ meterKey: 'vpn.traffic', unitPrice: null }] }).success).toBe(true);
    expect(updatePackageSchema.safeParse({ meterRates: [{ meterKey: 'vpn.traffic', unitPrice: '1' }] }).success).toBe(false);
  });
});
