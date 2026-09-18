import { ForbiddenException } from '@nestjs/common';
import { UserSearchService } from './user-search.service';
import type { AuthClaims } from '../token.service';

/**
 * `GET /auth/users?q=` (F-018-ad): the platform owner finds the user it is about
 * to name as a reseller's owner. What this spec pins:
 *
 * - **The permission is not the boundary.** A reseller administers its own
 *   roles and could grant itself `user.search`; the caller's tenant must be the
 *   `platform_owner`, checked before any user row is read.
 * - **The full number never leaves.** The answer carries a masked phone and no
 *   email — the list is for telling people apart, not for harvesting contacts.
 * - A national spelling of a phone (`0912…`) finds the stored E.164 number.
 */

const CLAIMS: AuthClaims = {
  sub: 'admin-1',
  tenantId: 'tenant-platform',
  roleId: 'role-super',
  roleName: 'SuperAdmin',
  permissions: ['*'],
  sessionId: 'session-1',
  iat: 0,
  exp: 0,
};

const ROW = {
  id: 'user-7',
  fullName: 'Sara Ahmadi',
  username: 'sara',
  phoneNumber: '+989123456789',
  status: 'active',
};

function harness(tenantType = 'platform_owner') {
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ tenantType }) },
    user: { findMany: vi.fn().mockResolvedValue([ROW]) },
  };
  return { prisma, service: new UserSearchService(prisma as never) };
}

function whereOf(prisma: ReturnType<typeof harness>['prisma']) {
  return prisma.user.findMany.mock.calls[0][0].where;
}

describe('UserSearchService', () => {
  beforeEach(() => {
    process.env.DEFAULT_PHONE_COUNTRY = 'IR';
  });

  it('refuses a caller outside the platform owner before reading a user', async () => {
    const { prisma, service } = harness('reseller');
    await expect(service.search(CLAIMS, { q: 'sara', limit: 10 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('answers id, name, username, status and a masked phone — never the number or an email', async () => {
    const { service } = harness();
    const res = await service.search(CLAIMS, { q: 'sara', limit: 10 });
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.users).toEqual([
      { id: 'user-7', fullName: 'Sara Ahmadi', username: 'sara', phoneMasked: '+989***6789', status: 'active' },
    ]);
  });

  it('never selects the email or passes the raw phone through', async () => {
    const { prisma, service } = harness();
    await service.search(CLAIMS, { q: 'sara', limit: 10 });
    const select = prisma.user.findMany.mock.calls[0][0].select;
    expect(select.email).toBeUndefined();
  });

  it('matches username and email case-insensitively, deleted users excluded, one short page', async () => {
    const { prisma, service } = harness();
    await service.search(CLAIMS, { q: 'Sara', limit: 5 });
    const where = whereOf(prisma);
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { username: { contains: 'Sara', mode: 'insensitive' } },
        { email: { contains: 'Sara', mode: 'insensitive' } },
      ]),
    );
    expect(prisma.user.findMany.mock.calls[0][0].take).toBe(5);
  });

  it('finds the stored E.164 number from its national spelling', async () => {
    const { prisma, service } = harness();
    await service.search(CLAIMS, { q: '09123456789', limit: 10 });
    expect(whereOf(prisma).OR).toContainEqual({ phoneNumber: '+989123456789' });
  });

  it('matches a partial number on its digits, the trunk zero dropped', async () => {
    const { prisma, service } = harness();
    await service.search(CLAIMS, { q: '0912345', limit: 10 });
    expect(whereOf(prisma).OR).toContainEqual({ phoneNumber: { contains: '912345' } });
  });
});
