import { UserStatus } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';
import { UserStatusService } from './user-status.service';

/**
 * BAN-1-d (ADR-0133 decisions 5–7): staff restrict, ban and lift, with a
 * reason the person is shown.
 *
 * What fails silently here: a support agent who can ban (the way back closes
 * on a new agent's mistake), an agent acting on the owner or an admin, a
 * person blocked with no reason to read, and a change whose old sessions keep
 * working — so every status change revokes, after the transaction committed.
 */
describe('UserStatusService.set', () => {
  const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
  const agent = { userId: 'u-agent', tenantId: TENANT, permissions: ['support.agent', 'restriction.assign'] };
  const admin = { userId: 'u-admin', tenantId: TENANT, permissions: ['restriction.assign', 'user.ban', 'support.agent', 'platform.tenant.manage'] };

  const person = (over: Record<string, unknown> = {}) => ({
    id: 'u-1',
    status: UserStatus.active,
    statusReason: null,
    role: { rolePermissions: [{ permission: { key: 'self.read' } }] },
    ...over,
  });

  const build = (target: unknown = person()) => {
    const order: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async () => order.push('bind')),
      user: {
        findFirst: vi.fn(async () => target),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          order.push('update');
          return { ...(target as object), ...args.data };
        }),
      },
      adminAuditLog: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => order.push('audit')) },
    };
    const prisma = {
      tenant: { findUnique: vi.fn(async () => ({ ownerUserId: 'u-owner', tenantType: 'reseller' })) },
      $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    };
    const sessions = { revokeAllSessionsForUser: vi.fn(async () => order.push('revoke')) };
    const service = new UserStatusService(prisma as never, sessions as never);
    const set = (actor: typeof agent, status: UserStatus, reason?: string, userId = 'u-1') =>
      runWithTenant({ id: TENANT } as never, () => service.set(actor, userId, { status, reason }, '1.2.3.4'));
    return { set, tx, sessions, order };
  };

  it('lets an agent restrict, with the reason, and revokes after the write', async () => {
    const { set, tx, order } = build();

    const view = await set(agent, UserStatus.suspended, 'chargeback on order 1042');

    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-1' },
        data: expect.objectContaining({ status: UserStatus.suspended, statusReason: 'chargeback on order 1042' }),
      }),
    );
    expect(tx.adminAuditLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: TENANT,
      adminId: 'u-agent',
      action: 'user_ban',
      reason: 'chargeback on order 1042',
      oldValue: { status: 'active' },
      newValue: { status: 'suspended' },
    });
    expect(order.slice(-1)).toEqual(['revoke']);
    expect(view).toMatchObject({ id: 'u-1', status: 'suspended', statusReason: 'chargeback on order 1042' });
  });

  it('refuses an agent a ban, and the lifting of one', async () => {
    await expect(build().set(agent, UserStatus.banned, 'resold')).rejects.toMatchObject({ reason: 'no_permission' });
    await expect(
      build(person({ status: UserStatus.banned })).set(agent, UserStatus.active),
    ).rejects.toMatchObject({ reason: 'no_permission' });
  });

  it('lets a holder of user.ban ban', async () => {
    const { set, sessions } = build();
    await expect(set(admin, UserStatus.banned, 'resold accounts')).resolves.toMatchObject({ status: 'banned' });
    expect(sessions.revokeAllSessionsForUser).toHaveBeenCalledWith('u-1', 'admin_ban');
  });

  it('asks for a reason before blocking, never before lifting', async () => {
    await expect(build().set(agent, UserStatus.suspended, '  ')).rejects.toMatchObject({ reason: 'reason_required' });
    const lifted = await build(person({ status: UserStatus.suspended, statusReason: 'x' })).set(agent, UserStatus.active);
    expect(lifted).toMatchObject({ status: 'active', statusReason: null });
  });

  it('never acts on oneself, the owner, or someone not below the actor', async () => {
    await expect(build().set(agent, UserStatus.suspended, 'r', 'u-agent')).rejects.toMatchObject({ reason: 'self' });
    await expect(build(person({ id: 'u-owner' })).set(admin, UserStatus.suspended, 'r', 'u-owner')).rejects.toMatchObject({
      reason: 'owner',
    });
    const peer = person({ role: { rolePermissions: agent.permissions.map((key) => ({ permission: { key } })) } });
    await expect(build(peer).set(agent, UserStatus.suspended, 'r')).rejects.toMatchObject({ reason: 'not_above' });
  });

  it('refuses a caller acting from another tenant, and a person it cannot see', async () => {
    await expect(build().set({ ...agent, tenantId: 'other' }, UserStatus.suspended, 'r')).rejects.toMatchObject({
      reason: 'wrong_tenant',
    });
    await expect(build(null).set(agent, UserStatus.suspended, 'r')).rejects.toMatchObject({ reason: 'user_not_found' });
  });

  it('writes nothing and revokes nothing for the same status and reason', async () => {
    const { set, tx, sessions } = build(person({ status: UserStatus.suspended, statusReason: 'r' }));
    await set(agent, UserStatus.suspended, 'r');
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(sessions.revokeAllSessionsForUser).not.toHaveBeenCalled();
  });
});

/** The agent's sidebar reads where the person stands before offering a change. */
describe('UserStatusService.read', () => {
  const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
  const build = (row: unknown) => {
    const prisma = {
      $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) =>
        work({ $executeRaw: vi.fn(), user: { findFirst: vi.fn(async () => row) } }),
      ),
    };
    const service = new UserStatusService(prisma as never, {} as never);
    return (actor: { userId: string; tenantId: string; permissions: string[] }) =>
      runWithTenant({ id: TENANT } as never, () => service.read(actor, 'u-1'));
  };

  it('answers a holder of either key', async () => {
    const read = build({ id: 'u-1', status: UserStatus.suspended, statusReason: 'r' });
    await expect(read({ userId: 'a', tenantId: TENANT, permissions: ['restriction.assign'] })).resolves.toEqual({
      id: 'u-1',
      status: 'suspended',
      statusReason: 'r',
    });
  });

  it('refuses a caller with neither key, or from another tenant', async () => {
    const read = build({ id: 'u-1', status: UserStatus.active, statusReason: null });
    await expect(read({ userId: 'a', tenantId: TENANT, permissions: ['support.agent'] })).rejects.toMatchObject({
      reason: 'no_permission',
    });
    await expect(read({ userId: 'a', tenantId: 'x', permissions: ['user.ban'] })).rejects.toMatchObject({
      reason: 'wrong_tenant',
    });
  });
});
