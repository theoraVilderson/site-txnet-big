import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ImpersonationService } from './impersonation.service';

/**
 * Impersonation hands one account another account's session, so the only thing
 * standing between "support helps a customer" and "an admin becomes their own
 * boss" is the authority rule (`authorityOver`, ADR-0103) plus §3.6's "never a
 * SuperAdmin" (AC-1-h). Both are exercised through `startImpersonation`
 * together with the audit trail and the transaction boundary that trail
 * depends on.
 */

type TestRole = { id: string; name: string; perms: string[] };
const ROLES = {
  superAdmin: { id: 'role-super', name: 'SuperAdmin', perms: ['*'] },
  admin: { id: 'role-admin', name: 'Admin', perms: ['user.read', 'user.write', 'user.impersonate'] },
  otherAdmin: { id: 'role-admin-2', name: 'Admin', perms: ['user.read', 'user.write', 'user.impersonate'] },
  support: { id: 'role-support', name: 'Support', perms: ['user.read', 'user.impersonate'] },
  user: { id: 'role-user', name: 'User', perms: [] },
  // Tenant-made roles (F-018-n): the name is the reseller's choice and ranks nothing.
  desk: { id: 'role-desk', name: 'Billing desk', perms: ['user.read'] },
  wallet: { id: 'role-wallet', name: 'Billing desk', perms: ['user.read', 'wallet.manual_adjust'] },
  calledSuper: { id: 'role-called-super', name: 'SuperAdmin', perms: ['user.read'] },
} satisfies Record<string, TestRole>;

const REASON = 'customer reported a failed top-up, ticket 4417';

type Harness = ReturnType<typeof harness>;

function harness() {
  const txClient = {
    impersonationSession: {
      create: vi.fn().mockResolvedValue({ id: 'imp-1' }),
    },
    session: { create: vi.fn().mockResolvedValue({ id: 'session-imp' }) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const prisma = {
    user: { findUnique: vi.fn() },
    // The admin's tenant: who owns it (ADR-0103 rules 2-3). Nobody here, unless a test says so.
    tenant: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: 'owner-0', tenantType: 'reseller' }) },
    session: {
      findUnique: vi.fn(),
      update: vi.fn((args: unknown) => ({ __op: 'session.update', args })),
    },
    impersonationSession: {
      update: vi.fn((args: unknown) => ({
        __op: 'impersonationSession.update',
        args,
      })),
    },
    adminAuditLog: {
      create: vi.fn((args: unknown) => ({ __op: 'adminAuditLog.create', args })),
    },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(txClient)
        : arg,
    ),
  };
  const tokens = {
    signImpersonatedToken: vi.fn().mockReturnValue('impersonated-token'),
  };
  const activateCache = vi.fn().mockResolvedValue(undefined);
  const sessionService = {
    createSession: vi.fn().mockResolvedValue({
      session: { id: 'session-imp' },
      refreshToken: 'r',
      activateCache,
    }),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  };
  const sessions = { drop: vi.fn().mockResolvedValue(undefined) };

  const service = new ImpersonationService(
    prisma as never,
    tokens as never,
    sessionService as never,
    sessions as never,
    {} as never,
  );

  return {
    service,
    prisma,
    txClient,
    tokens,
    sessionService,
    sessions,
    activateCache,
  };
}

const userWith = (role: TestRole, over: Record<string, unknown> = {}) => ({
  id: 'u',
  tenantId: 'tenant-1',
  roleId: role.id,
  status: 'active',
  role: { id: role.id, name: role.name, rolePermissions: role.perms.map((key) => ({ permission: { key } })) },
  ...over,
});

/** `findUnique` is called for the admin first, then the target. */
function actors(
  h: Harness,
  adminRole: TestRole,
  targetRole: TestRole,
  targetOver: Record<string, unknown> = {},
) {
  h.prisma.user.findUnique
    .mockResolvedValueOnce(userWith(adminRole, { id: 'admin-1' }))
    .mockResolvedValueOnce(userWith(targetRole, { id: 'target-1', ...targetOver }));
}

const start = (h: Harness, reason = REASON) =>
  h.service.startImpersonation(
    'admin-1',
    'target-1',
    reason,
    '1.2.3.4',
    'jest-ua',
  );

describe('ImpersonationService.startImpersonation — authority (AC-1-h)', () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    h = harness();
  });

  it.each([
    ['Admin', 'Support', ROLES.admin, ROLES.support],
    ['Admin', 'User', ROLES.admin, ROLES.user],
    ['SuperAdmin', 'Admin', ROLES.superAdmin, ROLES.admin],
    ['Support', 'User', ROLES.support, ROLES.user],
    ['Admin', 'a tenant-made role inside what they hold', ROLES.admin, ROLES.desk],
    ['Admin', 'a tenant-made role named SuperAdmin', ROLES.admin, ROLES.calledSuper],
  ])('lets a %s impersonate %s', async (_a, _t, adminRole, targetRole) => {
    actors(h, adminRole, targetRole);

    await expect(start(h)).resolves.toEqual({
      accessToken: 'impersonated-token',
      expiresIn: 1800,
    });
  });

  it.each([
    ['the same set under a different role row', ROLES.admin, ROLES.otherAdmin],
    ['a SuperAdmin', ROLES.admin, ROLES.superAdmin],
    ['a SuperAdmin, by a SuperAdmin', ROLES.superAdmin, ROLES.superAdmin],
    ['someone holding more, from Support', ROLES.support, ROLES.admin],
    // Ranked 0 by the old name table and so open to every admin: now refused,
    // because the admin does not hold `wallet.manual_adjust`.
    ['a tenant-made role holding a key the admin lacks', ROLES.admin, ROLES.wallet],
  ])('refuses %s', async (_label, adminRole, targetRole) => {
    actors(h, adminRole, targetRole);

    await expect(start(h)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses the same role row outright', async () => {
    actors(h, ROLES.admin, ROLES.admin);
    await expect(start(h)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an admin impersonating themselves', async () => {
    h.prisma.user.findUnique
      .mockResolvedValueOnce(userWith(ROLES.admin, { id: 'admin-1' }))
      .mockResolvedValueOnce(userWith(ROLES.admin, { id: 'admin-1' }));

    await expect(
      h.service.startImpersonation(
        'admin-1',
        'admin-1',
        REASON,
        '1.2.3.4',
        'jest-ua',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses the tenant's owner, to everyone", async () => {
    h.prisma.tenant.findUnique.mockResolvedValue({ ownerUserId: 'target-1', tenantType: 'reseller' });
    actors(h, ROLES.superAdmin, ROLES.user);
    await expect(start(h)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets the tenant's owner impersonate anyone but a SuperAdmin", async () => {
    h.prisma.tenant.findUnique.mockResolvedValue({ ownerUserId: 'admin-1', tenantType: 'reseller' });
    actors(h, ROLES.user, ROLES.wallet);
    await expect(start(h)).resolves.toMatchObject({ expiresIn: 1800 });

    vi.clearAllMocks();
    h.prisma.tenant.findUnique.mockResolvedValue({ ownerUserId: 'admin-1', tenantType: 'reseller' });
    actors(h, ROLES.superAdmin, ROLES.superAdmin);
    await expect(start(h)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ImpersonationService.startImpersonation — preconditions', () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    h = harness();
  });

  it.each([
    ['the admin', null, userWith(ROLES.user, { id: 'target-1' })],
    ['the target', userWith(ROLES.admin, { id: 'admin-1' }), null],
  ])('rejects when %s does not exist', async (_who, admin, target) => {
    h.prisma.user.findUnique
      .mockResolvedValueOnce(admin)
      .mockResolvedValueOnce(target);

    await expect(start(h)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([['suspended'], ['pending'], ['banned']])(
    'rejects a %s target',
    async (status) => {
      actors(h, ROLES.admin, ROLES.user, { status });
      await expect(start(h)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each([
    ['empty', ''],
    ['too short', 'typo fix'],
    ['whitespace padded to look long enough', '   short   '],
  ])('rejects a reason note that is %s', async (_label, reason) => {
    actors(h, ROLES.admin, ROLES.user);

    await expect(start(h, reason)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  /**
   * Ordering matters for what an attacker learns: a forbidden target is
   * refused on authority even when the reason note is also missing, so a missing
   * note never reveals that the authority check would have passed.
   */
  it('checks authority before the reason note', async () => {
    actors(h, ROLES.admin, ROLES.superAdmin);
    await expect(start(h, '')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ImpersonationService.startImpersonation — transaction and audit', () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    h = harness();
    actors(h, ROLES.admin, ROLES.user);
  });

  it('writes the impersonation row and the audit row on the transaction client', async () => {
    await start(h);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.txClient.impersonationSession.create).toHaveBeenCalledTimes(1);
    expect(h.txClient.impersonationSession.create.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      targetUserId: 'target-1',
      reasonNote: REASON,
      adminIpAddress: '1.2.3.4',
    });
    expect(h.txClient.adminAuditLog.create.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'user_impersonate_start',
      targetEntityType: 'user',
      targetEntityId: 'target-1',
      newValue: { reasonNote: REASON, sessionId: 'session-imp' },
      adminIpAddress: '1.2.3.4',
    });
  });

  it('audits after the session exists, so the log names a real session id', async () => {
    await start(h);

    expect(
      h.sessionService.createSession.mock.invocationCallOrder[0],
    ).toBeLessThan(h.txClient.adminAuditLog.create.mock.invocationCallOrder[0]);
  });

  it('caps the impersonated session at 30 minutes and marks its provenance', async () => {
    await start(h);

    expect(h.sessionService.createSession).toHaveBeenCalledWith(
      'target-1',
      '1.2.3.4',
      'jest-ua',
      {
        isImpersonated: true,
        impersonationSessionId: 'imp-1',
        switchedFromUserId: 'admin-1',
        expiresInSec: 1800,
        tx: h.txClient,
      },
    );
  });

  it('signs the token only after the transaction has committed', async () => {
    await start(h);

    expect(h.prisma.$transaction.mock.results[0].value).toBeInstanceOf(Promise);
    expect(h.tokens.signImpersonatedToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'target-1' }),
      'session-imp',
      'admin-1',
    );
    expect(
      h.txClient.adminAuditLog.create.mock.invocationCallOrder[0],
    ).toBeLessThan(h.tokens.signImpersonatedToken.mock.invocationCallOrder[0]);
  });

  /**
   * Invariant #7 — impersonated access always carries an audit entry — only
   * holds if the session cannot outlive a failed audit write. The session row
   * shares the transaction, so it rolls back with it, and neither a token nor
   * a live Redis marker is ever produced.
   */
  it('mints nothing and activates nothing when the audit write fails', async () => {
    h.txClient.adminAuditLog.create.mockRejectedValue(new Error('audit down'));

    await expect(start(h)).rejects.toThrow('audit down');
    expect(h.tokens.signImpersonatedToken).not.toHaveBeenCalled();
    expect(h.activateCache).not.toHaveBeenCalled();
  });

  it('writes the session row on the transaction client, not beside it', async () => {
    await start(h);

    expect(h.sessionService.createSession.mock.calls[0][3]).toMatchObject({
      tx: h.txClient,
    });
  });

  /**
   * Postgres is the record and Redis only the liveness cache
   * (identity/invariants.md #8), so the marker must not exist for a row that
   * has not committed.
   */
  it('makes the session live only after the transaction commits', async () => {
    await start(h);

    expect(h.activateCache).toHaveBeenCalledTimes(1);
    expect(
      h.txClient.adminAuditLog.create.mock.invocationCallOrder[0],
    ).toBeLessThan(h.activateCache.mock.invocationCallOrder[0]);
    expect(h.activateCache.mock.invocationCallOrder[0]).toBeLessThan(
      h.tokens.signImpersonatedToken.mock.invocationCallOrder[0],
    );
  });
});

describe('ImpersonationService.endImpersonation', () => {
  let h: Harness;

  const impersonated = (over: Record<string, unknown> = {}) => ({
    id: 'session-imp',
    userId: 'target-1',
    isImpersonated: true,
    switchedFromUserId: 'admin-1',
    impersonationSessionId: 'imp-1',
    impersonationSession: { id: 'imp-1' },
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h = harness();
  });

  it.each([
    ['an unknown session', null],
    ['an ordinary, non-impersonated session', { isImpersonated: false }],
  ])('rejects %s', async (_label, over) => {
    h.prisma.session.findUnique.mockResolvedValue(
      over === null ? null : impersonated(over),
    );

    await expect(
      h.service.endImpersonation('session-imp', 'admin-1', '1.2.3.4'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an admin who did not start this impersonation', async () => {
    h.prisma.session.findUnique.mockResolvedValue(impersonated());

    await expect(
      h.service.endImpersonation('session-imp', 'other-admin', '1.2.3.4'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.sessions.drop).not.toHaveBeenCalled();
  });

  it('revokes, closes and audits in one transaction, then drops the cache', async () => {
    h.prisma.session.findUnique.mockResolvedValue(impersonated());

    await h.service.endImpersonation('session-imp', 'admin-1', '1.2.3.4');

    const ops = h.prisma.$transaction.mock.calls[0][0] as {
      __op: string;
      args: { data: Record<string, unknown> };
    }[];
    expect(ops.map((o) => o.__op)).toEqual([
      'session.update',
      'impersonationSession.update',
      'adminAuditLog.create',
    ]);
    expect(ops[0].args.data).toMatchObject({
      revokedReason: 'impersonation_ended',
    });
    expect(ops[1].args.data.endedAt).toBeInstanceOf(Date);
    expect(ops[2].args.data).toMatchObject({
      adminId: 'admin-1',
      action: 'user_impersonate_end',
      targetEntityId: 'target-1',
      newValue: { sessionId: 'session-imp' },
    });

    // The Postgres revocation is already in that transaction; only the Redis
    // marker is left. Going back through `revokeSession` would rewrite
    // `revokedAt` a second time, outside the transaction.
    expect(h.sessionService.revokeSession).not.toHaveBeenCalled();
    expect(h.sessions.drop).toHaveBeenCalledWith('session-imp', 'target-1');
    expect(h.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      h.sessions.drop.mock.invocationCallOrder[0],
    );
  });

  it('updates the session row exactly once', async () => {
    h.prisma.session.findUnique.mockResolvedValue(impersonated());

    await h.service.endImpersonation('session-imp', 'admin-1', '1.2.3.4');

    expect(h.prisma.session.update).toHaveBeenCalledTimes(1);
  });
});
