import { ConflictException } from '@nestjs/common';
import { TenantAdminRefused, TenantAdminService } from './tenant-admin.service';
import { createResellerSchema } from './tenant-admin.schema';

// argon2id costs ~64 MB and real CPU per hash; under the whole suite that alone times a test out.
vi.mock('argon2', () => ({ argon2id: 2, hash: vi.fn(async () => '$argon2id$stub') }));

/**
 * The invariants F-018-c turns on, at the one surface that creates a reseller.
 *
 * - Only the platform owner reaches it, and a non-owner is refused before the
 *   cross-tenant pool is touched (ADR-0053's order).
 * - The tenant, its owner user, its empty billing wallet, its subdomain and the
 *   audit row are one transaction, and the subdomain's cached resolution is
 *   retracted inside it (tenant contract: "any write that changes which tenant
 *   a host belongs to must call invalidateDomain").
 * - A slug is a DNS label and never one of the platform's own hosts.
 */
describe('TenantAdminService', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  const input = {
    slug: 'myvpn',
    billingModel: 'subscription_monthly' as const,
    owner: {
      fullName: 'Reseller Owner',
      username: 'reseller_owner',
      phoneNumber: '+989123456789',
      password: 'Xk9!mQ2#vLp4',
    },
  };

  const build = (opts: { callerType?: string; slugTaken?: boolean; invalidateFails?: boolean } = {}) => {
    const appPrisma = {
      tenant: { findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })) },
    };
    const writes: string[] = [];
    const tx = {
      tenant: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('tenant'), { id: 'new-tenant', ...data, createdAt: new Date() })) },
      user: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('user'), data)) },
      tenantBillingWallet: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('wallet'), data)) },
      tenantDomain: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('domain'), data)) },
      adminAuditLog: { create: vi.fn(async () => (writes.push('audit'), {})) },
    };
    const all = {
      tenant: { findUnique: vi.fn(async () => (opts.slugTaken ? { id: 'x' } : null)) },
      tenantDomain: { findUnique: vi.fn(async () => null) },
      role: { findUnique: vi.fn(async () => ({ id: 'admin-role' })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const cache = {
      invalidateDomain: vi.fn(async () => {
        if (opts.invalidateFails) throw new Error('redis down');
        writes.push('invalidate');
      }),
    };
    const config = { get: vi.fn(() => 'txnet.app') };
    const service = new TenantAdminService(appPrisma as never, all as never, cache as never, config as never);
    return { service, appPrisma, all, tx, cache, writes };
  };

  it('refuses a caller who is not the platform owner before the cross-tenant pool is touched', async () => {
    const { service, all } = build({ callerType: 'reseller' });
    await expect(service.create(actor, input)).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(all.tenant.findUnique).not.toHaveBeenCalled();
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('writes tenant, owner, empty wallet, subdomain and audit in one transaction and retracts the host inside it', async () => {
    const { service, all, tx, writes } = build();
    const view = await service.create(actor, input);

    expect(all.$transaction).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(['tenant', 'user', 'wallet', 'domain', 'audit', 'invalidate']);

    const tenant = tx.tenant.create.mock.calls[0][0].data;
    expect(tenant).toMatchObject({ tenantType: 'reseller', slug: 'myvpn', status: 'trial', billingModel: 'subscription_monthly' });
    const user = tx.user.create.mock.calls[0][0].data;
    expect(user.id).toBe(tenant.ownerUserId);
    expect(user).toMatchObject({ tenantId: 'new-tenant', roleId: 'admin-role', phoneNumber: '+989123456789' });
    // The platform owner does not vouch for the phone: the owner proves it (identity invariant 6).
    expect(user.phoneVerifiedAt).toBeUndefined();
    expect(user.passwordHash).toBe('$argon2id$stub');
    // An empty wallet: no balance is written (tenant invariant 3).
    expect(tx.tenantBillingWallet.create.mock.calls[0][0].data).toEqual({ tenantId: 'new-tenant' });
    expect(tx.tenantDomain.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 'new-tenant',
      domainType: 'subdomain',
      domainValue: 'myvpn.txnet.app',
      purpose: 'panel',
    });
    expect(JSON.stringify(view)).not.toContain(input.owner.password);
    expect(view).toMatchObject({ id: 'new-tenant', slug: 'myvpn', status: 'trial' });
  });

  it('refuses the whole creation when the host cannot be retracted', async () => {
    const { service } = build({ invalidateFails: true });
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
    expect(e).toBeInstanceOf(TenantAdminRefused);
    expect(e.reason).toBe('slug_taken');
    expect(e).not.toBeInstanceOf(ConflictException);
  });

  it.each(['-bad', 'bad-', 'Bad', 'has_underscore', 'a'.repeat(64), 'api', 'panel', 'www'])(
    'refuses %s as a slug',
    (slug) => {
      expect(createResellerSchema.safeParse({ ...input, slug }).success).toBe(false);
    },
  );

  it('accepts a DNS label as a slug and refuses an unknown key', () => {
    expect(createResellerSchema.safeParse({ ...input, slug: 'my-vpn-2' }).success).toBe(true);
    expect(createResellerSchema.safeParse({ ...input, status: 'active' }).success).toBe(false);
  });

  it('refuses the metered billing model D-41 ruled out', () => {
    expect(createResellerSchema.safeParse({ ...input, billingModel: 'pay_as_you_go_metered' }).success).toBe(false);
  });
});
