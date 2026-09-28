import { UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { createResellerSchema } from './reseller.schema';
import { ResellerRefused, ResellerService } from './reseller.service';

/**
 * The invariants F-018-y turns on, at the one surface that creates a reseller.
 *
 * - A reseller names an **existing** platform user as its owner; this service
 *   never writes `identity.user` (ADR-0058 (4)).
 * - Only the platform owner reaches it, and a non-owner is refused before the
 *   cross-tenant pool is touched (ADR-0053's order).
 * - The tenant, its empty billing wallet, its subdomain and the audit row are
 *   one transaction, and the subdomain's `tenant:host:*` entry is deleted
 *   inside it — the entry carries `ownerUserId` since ADR-0059.
 * - A slug is a DNS label and never one of the platform's own hosts.
 */
describe('ResellerService', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const USER = '33333333-3333-3333-3333-333333333333';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };
  const input = { slug: 'myvpn', billingModel: 'subscription_monthly' as const, ownerUserId: USER };
  const person = { id: USER, fullName: 'Reseller Owner', username: 'owner', phoneNumber: '+989123456789', status: 'active' };

  const build = (
    opts: { callerType?: string; slugTaken?: boolean; owner?: typeof person | null; redisFails?: boolean } = {},
  ) => {
    const appPrisma = {
      tenant: { findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })) },
    };
    const writes: string[] = [];
    const created: string[] = [];
    const tx = {
      tenant: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('tenant'), { id: 'new-tenant', ...data, createdAt: new Date() })),
        // The platform's currency, which a billing wallet opens in (F-116-f).
        findFirst: vi.fn(async () => ({ operatingCurrencyCode: 'USD' })),
      },
      tenantBillingWallet: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('wallet'), data)) },
      tenantDomain: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('domain'), created.push(data.domainValue as string), { verificationStatus: 'pending', ...data })),
        findMany: vi.fn(async () => created.map((domainValue) => ({ domainValue }))),
      },
      adminAuditLog: { create: vi.fn(async () => (writes.push('audit'), {})) },
    };
    const all = {
      tenant: { findUnique: vi.fn(async () => (opts.slugTaken ? { id: 'x' } : null)) },
      tenantDomain: { findUnique: vi.fn(async () => null) },
      user: { findFirst: vi.fn(async (_args: unknown) => (opts.owner === undefined ? person : opts.owner)) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const redis = {
      del: vi.fn(async (key: string) => {
        if (opts.redisFails) throw new Error('redis down');
        writes.push(`del ${key}`);
      }),
    };
    const config = { get: vi.fn(() => 'txnet.app') };
    const service = new ResellerService(appPrisma as never, all as never, redis as never, config as never);
    return { service, all, tx, redis, writes };
  };

  it('refuses a caller who is not the platform owner before the cross-tenant pool is touched', async () => {
    const { service, all } = build({ callerType: 'reseller' });
    await expect(service.create(actor, input)).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(all.tenant.findUnique).not.toHaveBeenCalled();
    expect(all.user.findFirst).not.toHaveBeenCalled();
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('names the existing user as owner, writes no user, and drops every entry naming the owner inside the transaction', async () => {
    const { service, all, tx, writes } = build();
    const view = await service.create(actor, input);

    expect(all.$transaction).toHaveBeenCalledTimes(1);
    expect('user' in tx).toBe(false);
    expect(writes).toEqual([
      'tenant',
      'wallet',
      'domain',
      'audit',
      `del ${UnscopedRedisKeys.tenantById('new-tenant')}`,
      `del ${UnscopedRedisKeys.tenantByHost('myvpn.edge.txnet.app')}`,
    ]);
    expect(tx.tenant.create.mock.calls[0][0].data).toEqual({
      tenantType: 'reseller',
      ownerUserId: USER,
      slug: 'myvpn',
      status: 'trial',
      billingModel: 'subscription_monthly',
    });
    // An empty wallet: no balance is written (tenant invariant 3).
    expect(tx.tenantBillingWallet.create.mock.calls[0][0].data).toEqual({ tenantId: 'new-tenant', currencyCode: 'USD' });
    expect(view.owner).toEqual({ id: USER, fullName: 'Reseller Owner', username: 'owner', phoneNumber: '+989123456789' });
  });

  it('issues the reseller one platform host, its own CNAME target, and no panel subdomain', async () => {
    // ADR-0063: `ali-vpn.ir` is CNAMEd to `<slug>.edge.<domain>`, which only
    // connects the reseller's domain and serves nothing itself. There is no
    // `<slug>.<domain>` — a platform name a reseller could hand its customers.
    const { service, tx } = build();
    const view = await service.create(actor, input);

    expect(tx.tenantDomain.create).toHaveBeenCalledTimes(1);
    expect(tx.tenantDomain.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 'new-tenant',
      domainType: 'subdomain',
      domainValue: 'myvpn.edge.txnet.app',
      purpose: 'panel',
    });
    expect(view.domains.map((d) => d.domainValue)).toEqual(['myvpn.edge.txnet.app']);
  });

  it('looks the owner up among the platform owner tenant’s live users only', async () => {
    const { service, all } = build();
    await service.create(actor, input);
    expect(all.user.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: USER, tenantId: OWNER_TENANT, deletedAt: null } });
  });

  it('refuses an owner who is not a platform user, before the transaction', async () => {
    const { service, all } = build({ owner: null });
    await expect(service.create(actor, input)).rejects.toMatchObject({ reason: 'owner_not_found' });
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a banned or suspended owner', async () => {
    const { service, all } = build({ owner: { ...person, status: 'banned' } });
    await expect(service.create(actor, input)).rejects.toMatchObject({ reason: 'owner_inactive' });
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('refuses the whole creation when the host entry cannot be deleted', async () => {
    const { service } = build({ redisFails: true });
    await expect(service.create(actor, input)).rejects.toThrow('redis down');
  });

  it('names a taken slug instead of failing on the unique index', async () => {
    const { service, all } = build({ slugTaken: true });
    await expect(service.create(actor, input)).rejects.toMatchObject({ reason: 'slug_taken' });
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('maps a lost race on the unique index to slug_taken', async () => {
    const { service, all } = build();
    all.$transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const e = await service.create(actor, input).catch((x) => x);
    expect(e).toBeInstanceOf(ResellerRefused);
    expect(e.reason).toBe('slug_taken');
  });

  it.each(['-bad', 'bad-', 'Bad', 'has_underscore', 'a'.repeat(64), 'api', 'panel', 'www', 'edge'])('refuses %s as a slug', (slug) => {
    expect(createResellerSchema.safeParse({ ...input, slug }).success).toBe(false);
  });

  it('accepts a DNS label, and refuses an unknown key, a new-owner object and a non-uuid owner', () => {
    expect(createResellerSchema.safeParse({ ...input, slug: 'my-vpn-2' }).success).toBe(true);
    expect(createResellerSchema.safeParse({ ...input, status: 'active' }).success).toBe(false);
    expect(createResellerSchema.safeParse({ ...input, owner: { fullName: 'x' } }).success).toBe(false);
    expect(createResellerSchema.safeParse({ ...input, ownerUserId: 'nope' }).success).toBe(false);
  });

  it('refuses the metered billing model D-41 ruled out', () => {
    expect(createResellerSchema.safeParse({ ...input, billingModel: 'pay_as_you_go_metered' }).success).toBe(false);
  });
});
