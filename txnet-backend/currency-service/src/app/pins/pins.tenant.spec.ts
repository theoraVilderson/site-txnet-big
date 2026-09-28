import { Prisma, RateSource, TenantType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { CurrencyPinService } from './pins.service';

/**
 * F-116-j (ADR-0098 part 9) — a tenant pins a manual rate for its own books.
 *
 * 1. **Only for a currency its books use**: its operating currency, or one its
 *    own selectable gateways charge in (billing's answer — user, 2026-09-28).
 *    Never the base currency.
 * 2. **The pin carries the tenant**; the platform's carries none. That is what
 *    keeps it off the tenant <-> platform boundary: a read without a tenant
 *    never sees it (shared-core `readFxRate`).
 * 3. **A tenant ends only its own pin**, and the platform only its own.
 * 4. **Billing unreachable costs the gateway currencies, not the pin**: the
 *    operating currency can still be pinned.
 */
describe('CurrencyPinService — a tenant\'s own pin (F-116-j)', () => {
  const NOW = new Date('2026-09-28T18:00:00.000Z');
  const reseller = { userId: 'admin-r', tenantId: 't-1', ip: '10.0.0.2' };
  const platform = { userId: 'admin-p', tenantId: 'platform', ip: '10.0.0.1' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const CURRENCIES: Record<string, { id: string; isActive: boolean; isBaseCurrency: boolean }> = {
    USD: { id: 'c-usd', isActive: true, isBaseCurrency: true },
    EUR: { id: 'c-eur', isActive: true, isBaseCurrency: false },
    IRR: { id: 'c-irr', isActive: true, isBaseCurrency: false },
    GBP: { id: 'c-gbp', isActive: true, isBaseCurrency: false },
  };

  function world(options: { operating?: string; charges?: string[] | 'down'; pin?: Record<string, unknown> } = {}) {
    const created: Record<string, unknown>[] = [];
    const where: unknown[] = [];
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      currencyExchangeRate: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'pin-1', effectiveAt: NOW, ...data };
        }),
      },
      currencyRatePinEnd: { create: vi.fn(async ({ data }: { data: object }) => ({ id: 'e', endedAt: NOW, ...data })) },
      adminAuditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      tenant: {
        findUnique: vi.fn(async ({ where: w }: { where: { id: string } }) =>
          w.id === 'platform'
            ? { tenantType: TenantType.platform_owner, operatingCurrencyCode: 'USD' }
            : { tenantType: TenantType.reseller, operatingCurrencyCode: options.operating ?? 'EUR' },
        ),
      },
      currency: {
        findUnique: vi.fn(async ({ where: w }: { where: { code: string } }) => CURRENCIES[w.code] ?? null),
      },
      currencyExchangeRate: {
        findFirst: vi.fn(async (args: { where: unknown }) => {
          where.push(args.where);
          return null;
        }),
        findUnique: vi.fn(async () => options.pin ?? null),
      },
      $transaction: vi.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
    };
    // Reads of rate rows run in `tenantTransaction` (RLS): the transaction client reads what the service would.
    Object.assign(tx.currencyExchangeRate, {
      findFirst: prisma.currencyExchangeRate.findFirst,
      findUnique: prisma.currencyExchangeRate.findUnique,
    });
    const billing = {
      chargeCurrencies: vi.fn(async () => (options.charges === 'down' ? [] : (options.charges ?? ['IRR']))),
    };
    const service = new CurrencyPinService(prisma as never, { get: async () => null } as never, billing as never);
    const as = (actor: typeof reseller) => ({
      pin: (input: { code: string; rate: string; reason: string; hours: number }) =>
        runWithTenant({ id: actor.tenantId } as never, () => service.pin(actor, input)),
      end: (id: string) => runWithTenant({ id: actor.tenantId } as never, () => service.end(actor, id)),
      view: (code: string) => runWithTenant({ id: actor.tenantId } as never, () => service.view(actor, code)),
    });
    return { as, created, billing, where };
  }

  const input = (code: string) => ({ code, rate: '2600000', reason: 'my gateway, my rate', hours: 24 });

  it('pins its operating currency and a gateway\'s charge currency, with its tenant on the row', async () => {
    const { as, created } = world({ operating: 'EUR', charges: ['IRR'] });

    await as(reseller).pin(input('EUR'));
    await as(reseller).pin(input('IRR'));

    expect(created.map((r) => [r.tenantId, r.source])).toEqual([
      ['t-1', RateSource.manual_admin],
      ['t-1', RateSource.manual_admin],
    ]);
  });

  it('refuses a currency its books never use, and the base currency', async () => {
    const { as } = world({ operating: 'EUR', charges: ['IRR'] });

    await expect(as(reseller).pin(input('GBP'))).rejects.toMatchObject({ reason: 'currency_not_yours' });
    await expect(as(reseller).pin(input('USD'))).rejects.toMatchObject({ reason: 'base_currency' });
  });

  it('still pins the operating currency when billing cannot answer', async () => {
    const { as, created } = world({ operating: 'EUR', charges: 'down' });

    await as(reseller).pin(input('EUR'));
    await expect(as(reseller).pin(input('IRR'))).rejects.toMatchObject({ reason: 'currency_not_yours' });
    expect(created).toHaveLength(1);
  });

  it('writes the platform\'s pin with no tenant, for any currency', async () => {
    const { as, created, billing } = world();

    await as(platform).pin(input('GBP'));

    expect(created[0]).toMatchObject({ tenantId: null });
    expect(billing.chargeCurrencies).not.toHaveBeenCalled();
  });

  it('lets a tenant end only its own pin, and the platform only its own', async () => {
    const pin = (tenantId: string | null) => ({
      id: 'pin-1',
      source: RateSource.manual_admin,
      tenantId,
      rate: new Prisma.Decimal('2600000'),
      reason: 'r',
      setByAdminId: 'x',
      effectiveAt: new Date('2026-09-28T12:00:00Z'),
      expiresAt: new Date('2026-09-29T12:00:00Z'),
      currency: { code: 'IRR' },
      pinEnd: null,
    });

    await expect(world({ pin: pin('t-2') }).as(reseller).end('pin-1')).rejects.toMatchObject({ reason: 'pin_not_found' });
    await expect(world({ pin: pin('t-1') }).as(platform).end('pin-1')).rejects.toMatchObject({ reason: 'pin_not_found' });
    await expect(world({ pin: pin(null) }).as(reseller).end('pin-1')).rejects.toMatchObject({ reason: 'pin_not_found' });
    await expect(world({ pin: pin('t-1') }).as(reseller).end('pin-1')).resolves.toMatchObject({ endedAt: NOW.toISOString() });
  });

  it('shows a tenant its own live pin, and the platform\'s beside it', async () => {
    const { as, where } = world({ operating: 'EUR' });

    const form = await as(reseller).view('EUR');

    expect(where).toContainEqual(expect.objectContaining({ source: RateSource.manual_admin, tenantId: 't-1' }));
    expect(where).toContainEqual(expect.objectContaining({ source: RateSource.manual_admin, tenantId: null }));
    expect(form).toHaveProperty('platformPin', null);
  });
});
