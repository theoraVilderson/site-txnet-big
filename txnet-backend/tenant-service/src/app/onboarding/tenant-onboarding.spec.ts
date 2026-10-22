import {
  TENANT_CAPABILITIES,
  TenantOnboardingPolicy,
  listedVariantWhere,
  offeredToTenant,
  pricesInEffect,
  parseTenantStatusState,
  runWithTenant,
  serializeTenantStatusState,
  tenantAllows,
  tenantRefusal,
} from '@txnet-backend/shared-core';

import { TenantStatusListener } from '../status/tenant-status.listener';
import { TenantOnboardingService } from './tenant-onboarding.service';

/**
 * The onboarding gate (F-018-l, catalog F-213).
 *
 * - A reseller with no `verified` custom `panel` domain reaches the
 *   configuration console and nothing else: it signs in, reads, configures and
 *   tops up its billing wallet; it registers nobody, sells nothing, takes no
 *   end-user money and serves no `/sub`.
 * - The gate is a **column**, not a status: it is applied on top of the
 *   tenant's own status, and the stricter of the two answers wins.
 * - It is **computed**: the listener reads the tenant's domains when it writes
 *   `tenant:status:<id>`, and the checklist counts live rows. Nothing stores
 *   "onboarding", and nothing stores a step as done.
 */
describe('TenantOnboardingPolicy', () => {
  const later = new Date('2026-09-24T12:00:00Z');
  const now = new Date('2026-09-19T12:00:00Z');

  it('closes the four capabilities that need a door of the reseller\'s own', () => {
    const closed = TENANT_CAPABILITIES.filter((c) => TenantOnboardingPolicy[c] === false);
    expect(closed.sort()).toEqual(['endUserDeposit', 'register', 'sell', 'subscriptionLink']);
  });

  it('an onboarding trial or active reseller still runs its console', () => {
    for (const status of ['trial', 'active'] as const) {
      const state = { status, graceEndsAt: null, onboarding: true };
      const open = TENANT_CAPABILITIES.filter((c) => tenantAllows(state, c, now));
      expect(open.sort()).toEqual(['account', 'dataExport', 'read', 'signIn', 'signOut', 'staffWrite', 'system', 'tenantBilling']);
    }
  });

  it('is a column on top of the status: the stricter answer wins', () => {
    // Suspended closes the console's writes; onboarding does not reopen them.
    const both = { status: 'suspended' as const, graceEndsAt: later.toISOString(), onboarding: true };
    expect(tenantAllows(both, 'staffWrite', now)).toBe(false);
    // …and `/sub`, which a suspension holds open until `graceEndsAt`, is closed
    // outright, because the reseller has no domain to serve it on.
    expect(tenantAllows(both, 'subscriptionLink', now)).toBe(false);
    expect(tenantAllows({ ...both, onboarding: false }, 'subscriptionLink', now)).toBe(true);
  });

  it('a state with no column is not onboarding, and the refusal names the gate', () => {
    for (const c of TENANT_CAPABILITIES) expect(tenantAllows({ status: 'active', graceEndsAt: null }, c, now)).toBe(true);
    expect(parseTenantStatusState(serializeTenantStatusState({ status: 'active', graceEndsAt: null }))).toEqual({
      status: 'active',
      graceEndsAt: null,
      onboarding: false,
    });
    expect(parseTenantStatusState('{"status":"active","graceEndsAt":null}')).toMatchObject({ onboarding: false });
    expect(parseTenantStatusState(serializeTenantStatusState({ status: 'trial', graceEndsAt: null, onboarding: true }))).toMatchObject({
      onboarding: true,
    });
    // A `trial` or `active` tenant reaches a refusal only through this column.
    expect(tenantRefusal({ status: 'active', graceEndsAt: null, onboarding: true })).toMatchObject({ reason: 'tenantOnboarding' });
    expect(tenantRefusal({ status: 'suspended', graceEndsAt: null, onboarding: true })).toMatchObject({ reason: 'tenantSuspended' });
  });
});

describe('TenantStatusListener — the computed column', () => {
  const RESELLER = '44444444-4444-4444-4444-444444444444';

  const write = async (row: Record<string, unknown>) => {
    const redis = { set: vi.fn(async (_key: string, _value: string) => undefined), publish: vi.fn(async () => undefined) };
    const all = {
      tenant: {
        findUnique: vi.fn(async (_args: { select: { domains: { where: unknown } } }) => row),
        findMany: vi.fn(async () => [row]),
      },
    };
    const listener = new TenantStatusListener(all as never, redis as never, (() => ({})) as never);
    await listener.handle(JSON.stringify({ tenantId: RESELLER }));
    return { written: JSON.parse(redis.set.mock.calls[0]![1]), all };
  };

  it('a reseller with no proven door is onboarding; one with a door is not', async () => {
    const base = { id: RESELLER, status: 'active', graceEndsAt: null, tenantType: 'reseller' };
    expect((await write({ ...base, domains: [] })).written).toMatchObject({ status: 'active', onboarding: true });
    expect((await write({ ...base, domains: [{ id: 'd1' }] })).written).toMatchObject({ onboarding: false });
  });

  it('only a verified, panel, custom domain lifts it — and the platform owner is never gated', async () => {
    const { all } = await write({ id: RESELLER, status: 'active', graceEndsAt: null, tenantType: 'reseller', domains: [] });
    expect(all.tenant.findUnique.mock.calls[0]![0].select.domains.where).toEqual({
      domainType: 'custom_domain',
      purpose: 'panel',
      verificationStatus: 'verified',
    });

    const owner = await write({ id: RESELLER, status: 'active', graceEndsAt: null, tenantType: 'platform_owner', domains: [] });
    expect(owner.written).toMatchObject({ onboarding: false });
  });
});

describe('TenantOnboardingService', () => {
  const RESELLER = '44444444-4444-4444-4444-444444444444';
  const PLATFORM = '10000000-0000-4000-8000-000000000001';
  const actor = { userId: 'u1', tenantId: 'platform', permissions: ['platform.tenant.manage'] };

  const build = (rows: { domain?: boolean; gateway?: boolean; bot?: boolean; price?: boolean; run?: boolean; skip?: boolean }) => {
    const first = (present: boolean | undefined) =>
      vi.fn(async (_args: { where: Record<string, unknown> }) => (present ? { id: 'x' } : null));
    const all = {
      tenantDomain: { findFirst: first(rows.domain) },
      tenantGatewayConfig: { findFirst: first(rows.gateway) },
      botIntegration: { findFirst: first(rows.bot) },
      productVariant: { findFirst: first(rows.price) },
      migrationRun: { findFirst: first(rows.run) },
      tenantOnboardingSkip: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => (rows.skip ? [{ step: 'import' }] : [])) },
      tenant: { findUnique: vi.fn(async () => ({ operatingCurrencyCode: 'IRR' })), findFirst: vi.fn(async () => ({ id: PLATFORM })) },
    };
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      tenantOnboardingSkip: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    const access = {
      keys: [] as string[],
      for(...keys: string[]) { this.keys = keys; return this; },
      admit: vi.fn(async () => ({ id: RESELLER, slug: 'r', as: 'owner' as const })),
      run: vi.fn(async (_actor: unknown, id: string, _capability: string, work: (r: { id: string }) => Promise<unknown>) =>
        runWithTenant({ id }, () => work({ id }))),
    };
    return { service: new TenantOnboardingService(access as never, all as never, prisma as never), all, access, tx };
  };

  it('reports the gate the guard enforces, and every step from live rows', async () => {
    const { service, access } = build({ domain: true, gateway: true, bot: false, price: true });
    const view = await service.checklist(actor, RESELLER);

    expect(access.admit).toHaveBeenCalledWith(actor, RESELLER, 'read');
    expect(view).toMatchObject({ tenantId: RESELLER, onboarding: false, complete: false });
    expect(view.steps).toEqual([
      { key: 'import', done: false, gate: false, optional: true, skipped: false },
      { key: 'domain', done: true, gate: true, optional: false, skipped: false },
      { key: 'gateway', done: true, gate: false, optional: false, skipped: false },
      { key: 'bot', done: false, gate: false, optional: false, skipped: false },
      { key: 'pricing', done: true, gate: false, optional: false, skipped: false },
    ]);
    expect(view.closed.sort()).toEqual(['endUserDeposit', 'register', 'sell', 'subscriptionLink']);
  });

  it('only the domain step gates: the other three are advice', async () => {
    const gated = await build({ domain: false, gateway: true, bot: true, price: true }).service.checklist(actor, RESELLER);
    expect(gated).toMatchObject({ onboarding: true, complete: false });

    const open = await build({ domain: true, gateway: false, bot: false, price: false }).service.checklist(actor, RESELLER);
    expect(open).toMatchObject({ onboarding: false, complete: false });

    const done = await build({ domain: true, gateway: true, bot: true, price: true }).service.checklist(actor, RESELLER);
    expect(done).toMatchObject({ onboarding: false, complete: true });
  });

  it('counts only what would actually serve a user: the same door, active rows', async () => {
    const { service, all } = build({});
    await service.checklist(actor, RESELLER);
    expect(all.tenantDomain.findFirst.mock.calls[0]![0].where).toEqual({
      tenantId: RESELLER,
      domainType: 'custom_domain',
      purpose: 'panel',
      verificationStatus: 'verified',
    });
    expect(all.tenantGatewayConfig.findFirst.mock.calls[0]![0].where).toMatchObject({ isActive: true, blockedAt: null });
    expect(all.botIntegration.findFirst.mock.calls[0]![0].where).toMatchObject({ status: 'active' });
  });

  describe('import — the optional first step, "bring my users" (F-213)', () => {
    it('is done by a committed run that brought users — a panel or an old link, not a balances file', async () => {
      const { service, all } = build({ run: true });
      const view = await service.checklist(actor, RESELLER);
      expect(view.steps[0]).toEqual({ key: 'import', done: true, gate: false, optional: true, skipped: false });
      expect(all.migrationRun.findFirst.mock.calls[0]?.[0].where).toEqual({ tenantId: RESELLER, status: 'committed', kind: { in: ['panel', 'link'] } });
    });

    it('is done by a skip, and says it was skipped', async () => {
      const { service, all } = build({ skip: true });
      const view = await service.checklist(actor, RESELLER);
      expect(view.steps[0]).toMatchObject({ key: 'import', done: true, skipped: true });
      expect(all.tenantOnboardingSkip.findMany.mock.calls[0]?.[0].where).toEqual({ tenantId: RESELLER });
    });

    it('counts toward nothing: complete is the four required steps (user, 2026-10-22)', async () => {
      const done = await build({ domain: true, gateway: true, bot: true, price: true }).service.checklist(actor, RESELLER);
      expect(done.steps[0]).toMatchObject({ key: 'import', done: false });
      expect(done).toMatchObject({ complete: true });
    });

    it('a skip is the migration key\'s write, stored once however often it is sent, and undone by deleting it', async () => {
      const { service, access, tx } = build({ skip: true });
      await service.skip(actor, RESELLER, 'import');
      await service.skip(actor, RESELLER, 'import');
      expect(access.keys).toEqual(['migration.manage']);
      expect(access.run).toHaveBeenCalledWith(actor, RESELLER, 'staffWrite', expect.any(Function));
      expect(tx.tenantOnboardingSkip.upsert).toHaveBeenCalledWith({
        where: { tenantId_step: { tenantId: RESELLER, step: 'import' } },
        create: { tenantId: RESELLER, step: 'import', skippedByUserId: actor.userId },
        update: {},
      });
      // The write runs in the reseller's own scope: the table is strict RLS.
      expect(tx.$executeRaw).toHaveBeenCalled();

      await service.unskip(actor, RESELLER, 'import');
      expect(tx.tenantOnboardingSkip.deleteMany).toHaveBeenCalledWith({ where: { tenantId: RESELLER, step: 'import' } });
    });
  });

  describe('pricing — "there is something to sell", the catalog\'s own rule (F-018-ah)', () => {
    const now = new Date('2026-09-19T12:00:00Z');
    beforeEach(() => vi.useFakeTimers({ now }));
    afterEach(() => vi.useRealTimers());

    const pricingWhere = async () => {
      const { service, all } = build({});
      await service.checklist(actor, RESELLER);
      return all.productVariant.findFirst.mock.calls[0]![0].where;
    };

    it('asks the catalog\'s predicate, not a copy of it', async () => {
      expect(await pricingWhere()).toEqual(offeredToTenant(RESELLER, PLATFORM, now, 'IRR'));
    });

    it('counts the platform\'s offers the reseller inherits as well as its own', async () => {
      const where = await pricingWhere();
      // The platform's rows carry its tenant id (ADR-0142).
      expect(where.OR).toEqual([{ tenantId: RESELLER }, { tenantId: PLATFORM }]);
      // A platform variant priced by the platform is on sale to this reseller too.
      expect((where.prices as { some: { OR: unknown } }).some.OR).toEqual([{ tenantId: RESELLER }, { tenantId: PLATFORM }]);
    });

    it('counts only what listOffers would list: public, live, priced now', async () => {
      const where = await pricingWhere();
      expect(where).toMatchObject(listedVariantWhere);
      expect(where).toMatchObject({ visibility: 'public', isActive: true, product: { isActive: true, categories: { some: { category: expect.objectContaining({ isActive: true }) } } } });
      // Priced in the reseller's own currency (F-116-d): a platform price in another is not something to sell.
      expect(where.prices).toMatchObject({ some: pricesInEffect(now, 'IRR') });
      expect(pricesInEffect(now, 'IRR')).toEqual({ isActive: true, effectiveFrom: { lte: now }, currencyCode: 'IRR' });
    });
  });
});
