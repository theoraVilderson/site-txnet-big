import { LinkedAccountService, RESELLER_OWNER_ROLE } from './linked-account.service';
import { runWithTenant } from '../../tenant-context/tenant-context';

/**
 * A reseller's owner signs in on the reseller's host with the password of their
 * platform account (ADR-0059). Everything that makes that safe is here: whose
 * credential a linked account answers with, that it is read across tenants and
 * never from the account's own row, and the rules for creating one.
 */

const RESELLER = { id: 'tenant-reseller', slug: 'arian-vpn', via: 'domain' } as const;
const PLATFORM_TENANT = 'tenant-platform';

const HOLDER = {
  id: 'user-platform-ali',
  tenantId: PLATFORM_TENANT,
  fullName: 'Ali Rezaei',
  phoneNumber: '+989121234567',
  phoneVerifiedAt: new Date('2026-09-01T00:00:00Z'),
  passwordHash: 'hash-of-ali',
  twoFactorEnabled: true,
  status: 'active',
  deletedAt: null,
  credentialUserId: null,
};

function harness(holder: Record<string, unknown> | null = HOLDER) {
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'user-reseller-ali' }),
    },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-admin' }) },
  };
  const all = { user: { findUnique: vi.fn().mockResolvedValue(holder) } };
  const service = new LinkedAccountService(prisma as never, all as never);
  return { prisma, all, service };
}

const inReseller = <T>(fn: () => T) => runWithTenant(RESELLER as never, fn);

describe('LinkedAccountService.credentialsOf', () => {
  it('answers with the account’s own credential when it is not linked', async () => {
    const { service, all } = harness();
    const creds = await service.credentialsOf({
      credentialUserId: null,
      passwordHash: 'own-hash',
      twoFactorEnabled: false,
    });
    expect(creds).toEqual({ passwordHash: 'own-hash', twoFactorEnabled: false });
    expect(all.user.findUnique).not.toHaveBeenCalled();
  });

  it('refuses an unlinked account that has no password', async () => {
    const { service } = harness();
    expect(
      await service.credentialsOf({
        credentialUserId: null,
        passwordHash: null,
        twoFactorEnabled: false,
      }),
    ).toBeNull();
  });

  it('answers a linked account with the linked account’s password and 2FA, read across tenants', async () => {
    const { service, all } = harness();
    const creds = await service.credentialsOf({
      credentialUserId: HOLDER.id,
      passwordHash: null,
      twoFactorEnabled: false,
    });
    expect(creds).toEqual({ passwordHash: 'hash-of-ali', twoFactorEnabled: true });
    expect(all.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: HOLDER.id } }),
    );
  });

  it.each([
    ['inactive', { status: 'suspended' }],
    ['deleted', { deletedAt: new Date() }],
    ['itself linked', { credentialUserId: 'someone-else' }],
    ['without a password', { passwordHash: null }],
  ])('refuses a linked account whose linked account is %s', async (_, patch) => {
    const { service } = harness({ ...HOLDER, ...patch });
    expect(
      await service.credentialsOf({
        credentialUserId: HOLDER.id,
        passwordHash: null,
        twoFactorEnabled: false,
      }),
    ).toBeNull();
  });

  it('refuses a link to an account that no longer exists', async () => {
    const { service } = harness(null);
    expect(
      await service.credentialsOf({
        credentialUserId: HOLDER.id,
        passwordHash: null,
        twoFactorEnabled: false,
      }),
    ).toBeNull();
  });
});

describe('LinkedAccountService.createOwnerAccount', () => {
  it('creates a password-less account in the ambient tenant, linked to the platform account', async () => {
    const { service, prisma } = harness();
    const res = await inReseller(() => service.createOwnerAccount(HOLDER.id));

    expect(res).toEqual({
      ok: true,
      msg: 'tenant.ownerAccountReady',
      data: { userId: 'user-reseller-ali' },
    });
    expect(prisma.role.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: RESELLER_OWNER_ROLE } }),
    );
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: RESELLER.id,
      credentialUserId: HOLDER.id,
      fullName: HOLDER.fullName,
      phoneNumber: HOLDER.phoneNumber,
      phoneVerifiedAt: HOLDER.phoneVerifiedAt,
      roleId: 'role-admin',
      status: 'active',
    });
    expect(data.passwordHash ?? null).toBeNull();
  });

  it('is idempotent: a second call answers with the account already linked', async () => {
    const { service, prisma } = harness();
    prisma.user.findFirst.mockResolvedValue({ id: 'user-reseller-ali' });
    const res = await inReseller(() => service.createOwnerAccount(HOLDER.id));
    expect(res).toMatchObject({ ok: true, data: { userId: 'user-reseller-ali' } });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['in the same tenant', { ...HOLDER, tenantId: RESELLER.id }],
    ['itself linked', { ...HOLDER, credentialUserId: 'someone-else' }],
    ['inactive', { ...HOLDER, status: 'suspended' }],
    ['with an unverified phone', { ...HOLDER, phoneVerifiedAt: null }],
  ])('refuses a platform account that is %s', async (_, holder) => {
    const { service, prisma } = harness(holder);
    const res = await inReseller(() => service.createOwnerAccount(HOLDER.id));
    expect(res).toMatchObject({ ok: false, msg: 'tenant.ownerAccountInvalid' });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses when the phone is already another account of this tenant', async () => {
    const { service, prisma } = harness();
    prisma.user.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['tenantId', 'phoneNumber'] },
    });
    const res = await inReseller(() => service.createOwnerAccount(HOLDER.id));
    expect(res).toMatchObject({ ok: false, msg: 'tenant.ownerPhoneTaken' });
  });

  it('answers with the winner when a concurrent call linked it first', async () => {
    const { service, prisma } = harness();
    prisma.user.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['tenantId', 'credentialUserId'] },
    });
    prisma.user.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'user-reseller-ali' });
    const res = await inReseller(() => service.createOwnerAccount(HOLDER.id));
    expect(res).toMatchObject({ ok: true, data: { userId: 'user-reseller-ali' } });
  });
});
