import { AdminAction, AuditTargetType, Prisma, RateSource, TenantType } from '@prisma/client';

import { runWithTenant } from '@txnet-backend/shared-core';

import { CurrencyPinRefused, CurrencyPinService } from './pins.service';

/**
 * F-0608-a (ADR-0101) — the platform's admin pins a manual rate with a reason
 * and an expiry, and may end it before then. What this holds:
 *
 * 1. **Only the platform owner pins** (a tenant's pin is F-116-j), never the
 *    base currency, and never a currency the platform does not list.
 * 2. **A pin is a `manual_admin` rate row, written with its audit row in one
 *    transaction** — the reason and the expiry are the row's, the admin is
 *    `setByAdminId`.
 * 3. **Ending a pin writes an end row and edits nothing** (invariant #3); an
 *    ended or expired pin cannot be ended again.
 * 4. **The form's data**: the live pin, the last *discovered* rate (never a
 *    pin), and the worker's last download from `fx:reading:{code}` — shown,
 *    not used.
 */
describe('CurrencyPinService (F-0608-a)', () => {
  const NOW = new Date('2026-09-28T18:00:00.000Z');
  const actor = { userId: 'admin-1', tenantId: 'platform', ip: '10.0.0.1' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const EUR = { id: 'c-eur', code: 'EUR', isActive: true, isBaseCurrency: false };
  const USD = { id: 'c-usd', code: 'USD', isActive: true, isBaseCurrency: true };

  function world(options: { tenantType?: TenantType; pin?: Record<string, unknown> | null; reading?: string | null } = {}) {
    const created: Record<string, unknown[]> = { rate: [], end: [], audit: [] };
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      currencyExchangeRate: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.rate.push(data);
          return { id: 'pin-1', effectiveAt: NOW, ...data };
        }),
      },
      currencyRatePinEnd: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.end.push(data);
          return { id: 'end-1', endedAt: NOW, ...data };
        }),
      },
      adminAuditLog: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.audit.push(data);
          return data;
        }),
      },
    };
    const prisma = {
      tenant: {
        findUnique: vi.fn(async () => ({ tenantType: options.tenantType ?? TenantType.platform_owner })),
      },
      currency: {
        findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
          ({ EUR, USD } as Record<string, unknown>)[where.code] ?? null,
        ),
      },
      currencyExchangeRate: {
        findFirst: vi.fn(async ({ where }: { where: { source: RateSource } }) =>
          where.source === RateSource.external_api
            ? { id: 'r-eur', rate: new Prisma.Decimal('0.87885046'), effectiveAt: new Date('2026-09-28T17:00:00Z') }
            : (options.pin ?? null),
        ),
        findUnique: vi.fn(async () => options.pin ?? null),
      },
      $transaction: vi.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
    };
    // Reads of rate rows run in `tenantTransaction` (RLS): the transaction client reads what the service would.
    Object.assign(tx.currencyExchangeRate, {
      findFirst: prisma.currencyExchangeRate.findFirst,
      findUnique: prisma.currencyExchangeRate.findUnique,
    });
    const redis = { get: vi.fn(async () => options.reading ?? null) };
    const service = new CurrencyPinService(prisma as never, redis as never, { chargeCurrencies: async () => [] } as never);
    // Every call inside the request's tenant scope, as IdentityMiddleware opens it:
    // `tenantTransaction` binds that tenant into the transaction for the audit row's RLS.
    const scoped = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      (...a: A) => runWithTenant({ id: actor.tenantId } as never, () => fn.apply(service, a) as Promise<R>);
    const pins = { view: scoped(service.view), pin: scoped(service.pin), end: scoped(service.end) };
    return { pins, created, prisma, tx };
  }

  const livePin = (over: Record<string, unknown> = {}) => ({
    id: 'pin-1',
    source: RateSource.manual_admin,
    rate: new Prisma.Decimal('0.95'),
    reason: 'sources down',
    setByAdminId: 'admin-1',
    effectiveAt: new Date('2026-09-28T12:00:00Z'),
    expiresAt: new Date('2026-09-29T12:00:00Z'),
    currency: EUR,
    pinEnd: null,
    ...over,
  });

  it('pins a rate: a manual_admin row with reason, expiry and admin, and its audit row, in one transaction', async () => {
    const { pins, created, prisma, tx } = world();

    const view = await pins.pin(actor, { code: 'EUR', rate: '0.9512345678', reason: 'sources down', hours: 48 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // the tenant bound for the audit row's RLS
    expect(created.rate).toEqual([
      expect.objectContaining({
        currencyId: 'c-eur',
        source: RateSource.manual_admin,
        setByAdminId: 'admin-1',
        reason: 'sources down',
        expiresAt: new Date('2026-09-30T18:00:00.000Z'),
      }),
    ]);
    // rounded once, to the column's eight places
    expect((created.rate[0] as { rate: Prisma.Decimal }).rate.toString()).toBe('0.95123457');
    expect(created.audit).toEqual([
      expect.objectContaining({
        adminId: 'admin-1',
        action: AdminAction.currency_rate_pin,
        targetEntityType: AuditTargetType.currency_exchange_rate,
        targetEntityId: 'pin-1',
        reason: 'sources down',
        adminIpAddress: '10.0.0.1',
      }),
    ]);
    expect(view).toMatchObject({ id: 'pin-1', code: 'EUR', rate: '0.95123457', endedAt: null });
  });

  it('refuses the base currency and an unknown code (a reseller\'s scope is pins.tenant.spec.ts)', async () => {
    const input = { rate: '1', reason: 'x', hours: 1 };
    await expect(world().pins.pin(actor, { ...input, code: 'USD' })).rejects.toMatchObject({ reason: 'base_currency' });
    await expect(world().pins.pin(actor, { ...input, code: 'XXX' })).rejects.toMatchObject({ reason: 'currency_not_found' });
    await expect(world().pins.pin(actor, { ...input, code: 'EUR', rate: '0.000000001' }))
      .rejects.toBeInstanceOf(CurrencyPinRefused);
  });

  it('ends a live pin with an end row and an audit row, touching the pin itself not at all', async () => {
    const { pins, created } = world({ pin: livePin() });

    const view = await pins.end(actor, 'pin-1');

    expect(created.rate).toEqual([]);
    expect(created.end).toEqual([{ rateId: 'pin-1', endedById: 'admin-1' }]);
    expect(created.audit).toEqual([expect.objectContaining({ action: AdminAction.currency_rate_pin_end, targetEntityId: 'pin-1' })]);
    expect(view.endedAt).toBe(NOW.toISOString());
  });

  it('refuses to end a pin that is already over, or a discovered rate', async () => {
    await expect(world({ pin: livePin({ pinEnd: { endedAt: NOW } }) }).pins.end(actor, 'pin-1'))
      .rejects.toMatchObject({ reason: 'pin_over' });
    await expect(world({ pin: livePin({ expiresAt: new Date('2026-09-28T17:59:00Z') }) }).pins.end(actor, 'pin-1'))
      .rejects.toMatchObject({ reason: 'pin_over' });
    await expect(world({ pin: livePin({ source: RateSource.external_api }) }).pins.end(actor, 'pin-1'))
      .rejects.toMatchObject({ reason: 'pin_not_found' });
  });

  it('shows the live pin, the last discovered rate and the last download — never the download as a rate', async () => {
    const reading = JSON.stringify({ rate: '0.91', at: '2026-09-28T17:55:00.000Z', outcome: 'refused', used: 3, sources: 6, reason: 'moved 6%' });
    const { pins } = world({ pin: livePin(), reading });

    const form = await pins.view(actor, 'EUR');

    expect(form.current).toMatchObject({ id: 'pin-1', rate: '0.95', reason: 'sources down' });
    expect(form.lastAccepted).toEqual({ snapshotId: 'r-eur', rate: '0.87885046', effectiveAt: '2026-09-28T17:00:00.000Z' });
    expect(form.lastDownload).toMatchObject({ rate: '0.91', outcome: 'refused' });
  });
});
