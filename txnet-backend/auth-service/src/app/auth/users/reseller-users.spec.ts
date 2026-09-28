import { UserStatus } from '@prisma/client';
import { ResellerAccessRefused } from '@txnet-backend/shared-core';
import { ResellerUsersService } from './reseller-users.service';

/**
 * The invariant this item turns on (F-311-a): a reseller reads and blocks
 * **only its own tenant's users**, through the one door of tenant invariant 21
 * and inside the scope that door opens — and a block is a statement the
 * platform's `banned` outranks.
 *
 * The door itself is specified in
 * `shared-core/src/lib/tenant/reseller-access.spec.ts`; what is checked here is
 * that this surface asks it with the capability each verb deserves, that no
 * query runs when it refuses, and that blocking ends the account's sessions in
 * the same transaction that writes its trail.
 */
describe('ResellerUsersService', () => {
  const actor = { userId: 'u-admin', tenantId: 'platform', permissions: ['tenant.manage'] };
  const reseller = 'aaaaaaaa-0000-4000-8000-000000000001';

  const aUser = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'u-1',
    fullName: 'Ali',
    username: 'ali',
    phoneNumber: '+989121234567',
    status: UserStatus.active,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  });

  const build = (options: { admit?: unknown; user?: unknown; rows?: unknown[]; count?: number } = {}) => {
    const order: string[] = [];
    // The args are captured rather than read back off `mock.calls`: the spec
    // tsconfig types a bare `vi.fn()`'s call tuple as `[]`.
    const asked: { findMany?: { where: Record<string, unknown>; skip: number; take: number } } = {};

    const user = {
      findMany: vi.fn(async (args: { where: Record<string, unknown>; skip: number; take: number }) => {
        order.push('findMany');
        asked.findMany = args;
        return options.rows ?? [aUser()];
      }),
      count: vi.fn(async () => options.count ?? 1),
      findFirst: vi.fn(async () => {
        order.push('findFirst');
        return 'user' in options ? options.user : aUser();
      }),
      update: vi.fn(async () => {
        order.push('update');
        return aUser({ status: UserStatus.suspended });
      }),
    };
    const adminAuditLog = {
      create: vi.fn(async () => {
        order.push('audit');
        return {};
      }),
    };
    const tx = { user, adminAuditLog };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    };

    const sessions = {
      revokeAllSessionsForUser: vi.fn(async () => {
        order.push('revoke');
      }),
    };

    const access = {
      runIncludingPlatform: vi.fn(async (_a: unknown, _t: unknown, capability: string, work: (r: unknown) => Promise<unknown>) => {
        order.push(`admit:${capability}`);
        if (options.admit) return (options.admit as () => Promise<unknown>)();
        return work({ id: reseller, slug: 'vpnshop', as: 'owner' });
      }),
    };

    const service = new ResellerUsersService(prisma as never, access as never, sessions as never);
    return { service, order, prisma, user, adminAuditLog, sessions, access, asked };
  };

  describe('list', () => {
    it('reads through the door with `read`, one page, and never the raw number', async () => {
      const { service, order, user } = build();

      const page = await service.list(actor, reseller, { page: 1, pageSize: 20 });

      expect(order[0]).toBe('admit:read');
      expect(user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20, where: { deletedAt: null } }),
      );
      expect(page).toEqual({
        items: [
          {
            id: 'u-1',
            fullName: 'Ali',
            username: 'ali',
            phoneMasked: expect.any(String),
            status: UserStatus.active,
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      expect(JSON.stringify(page)).not.toContain('+989121234567');
    });

    it('never names the tenant itself — the scope the door opened is the whole filter', async () => {
      const { service, asked } = build();

      await service.list(actor, reseller, { q: 'ali', page: 2, pageSize: 10 });

      expect(JSON.stringify(asked.findMany?.where)).not.toContain('tenantId');
      expect(asked.findMany?.where.OR).toBeDefined();
      expect(asked.findMany?.skip).toBe(10);
    });

    it('runs no query when the door refuses', async () => {
      const { service, user } = build({
        admit: () => Promise.reject(new ResellerAccessRefused('not_allowed')),
      });

      await expect(service.list(actor, reseller, { page: 1, pageSize: 20 })).rejects.toMatchObject({
        reason: 'not_allowed',
      });
      expect(user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('block', () => {
    it('suspends, revokes every session and writes the trail in one transaction', async () => {
      const { service, order, user, adminAuditLog, sessions } = build();

      const result = await service.block(actor, reseller, 'u-1', '10.0.0.1');

      expect(order).toEqual(['admit:staffWrite', 'findFirst', 'update', 'audit', 'revoke']);
      expect(user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: UserStatus.suspended } }),
      );
      expect(adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: reseller,
            adminId: 'u-admin',
            action: 'user_ban',
            targetEntityType: 'user',
            targetEntityId: 'u-1',
            adminIpAddress: '10.0.0.1',
          }),
        }),
      );
      expect(sessions.revokeAllSessionsForUser).toHaveBeenCalledWith('u-1', 'admin_ban');
      expect(result.status).toBe(UserStatus.suspended);
    });

    it('refuses a user the scope cannot see, with no write', async () => {
      const { service, user, adminAuditLog } = build({ user: null });

      await expect(service.block(actor, reseller, 'u-9', '10.0.0.1')).rejects.toMatchObject({
        reason: 'user_not_found',
      });
      expect(user.update).not.toHaveBeenCalled();
      expect(adminAuditLog.create).not.toHaveBeenCalled();
    });

    it('refuses to block the caller itself', async () => {
      const { service, user } = build({ user: aUser({ id: actor.userId }) });

      await expect(service.block(actor, reseller, actor.userId, '10.0.0.1')).rejects.toMatchObject({
        reason: 'cannot_block_self',
      });
      expect(user.update).not.toHaveBeenCalled();
    });

    it('is idempotent: a user already suspended is answered, not written again', async () => {
      const { service, user, adminAuditLog } = build({ user: aUser({ status: UserStatus.suspended }) });

      const result = await service.block(actor, reseller, 'u-1', '10.0.0.1');

      expect(result.status).toBe(UserStatus.suspended);
      expect(user.update).not.toHaveBeenCalled();
      expect(adminAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('unblock', () => {
    it('lifts a suspension back to active and audits the lift', async () => {
      const { service, user, adminAuditLog } = build({ user: aUser({ status: UserStatus.suspended }) });

      await service.unblock(actor, reseller, 'u-1', '10.0.0.1');

      expect(user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: UserStatus.active } }),
      );
      expect(adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'user_unban' }) }),
      );
    });

    it('never lifts the platform’s own ban', async () => {
      const { service, user } = build({ user: aUser({ status: UserStatus.banned }) });

      await expect(service.unblock(actor, reseller, 'u-1', '10.0.0.1')).rejects.toMatchObject({
        reason: 'user_banned',
      });
      expect(user.update).not.toHaveBeenCalled();
    });

    it('refuses to block a banned user too — the platform’s word stands', async () => {
      const { service, user } = build({ user: aUser({ status: UserStatus.banned }) });

      await expect(service.block(actor, reseller, 'u-1', '10.0.0.1')).rejects.toMatchObject({
        reason: 'user_banned',
      });
      expect(user.update).not.toHaveBeenCalled();
    });
  });
});
