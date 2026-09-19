import {
  TENANT_CAPABILITIES,
  TenantOnboardingPolicy,
  parseTenantStatusState,
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
      expect(open.sort()).toEqual(['account', 'read', 'signIn', 'signOut', 'staffWrite', 'system', 'tenantBilling']);
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
  const actor = { userId: 'u1', tenantId: 'platform', permissions: ['tenant.manage'] };

  const build = (rows: { domain?: boolean; gateway?: boolean; bot?: boolean; price?: boolean }) => {
    const first = (present: boolean | undefined) =>
      vi.fn(async (_args: { where: Record<string, unknown> }) => (present ? { id: 'x' } : null));
    const all = {
      tenantDomain: { findFirst: first(rows.domain) },
      tenantGatewayConfig: { findFirst: first(rows.gateway) },
      botIntegration: { findFirst: first(rows.bot) },
      price: { findFirst: first(rows.price) },
    };
    const access = { admit: vi.fn(async () => ({ id: RESELLER, slug: 'r', as: 'owner' as const })) };
    return { service: new TenantOnboardingService(access as never, all as never), all, access };
  };

  it('reports the gate the guard enforces, and every step from live rows', async () => {
    const { service, access } = build({ domain: true, gateway: true, bot: false, price: true });
    const view = await service.checklist(actor, RESELLER);

    expect(access.admit).toHaveBeenCalledWith(actor, RESELLER, 'read');
    expect(view).toMatchObject({ tenantId: RESELLER, onboarding: false, complete: false });
    expect(view.steps).toEqual([
      { key: 'domain', done: true, gate: true },
      { key: 'gateway', done: true, gate: false },
      { key: 'bot', done: false, gate: false },
      { key: 'pricing', done: true, gate: false },
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
    expect(all.tenantGatewayConfig.findFirst.mock.calls[0]![0].where).toMatchObject({ isActive: true, verificationStatus: 'verified' });
    expect(all.botIntegration.findFirst.mock.calls[0]![0].where).toMatchObject({ status: 'active' });
    expect(all.price.findFirst.mock.calls[0]![0].where).toMatchObject({ isActive: true, variant: { isActive: true } });
  });
});
