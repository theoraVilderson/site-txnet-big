import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ImpersonationService } from './impersonation.service';

/**
 * Impersonation hands one account another account's session, so the only thing
 * standing between "support helps a customer" and "an admin becomes their own
 * boss" is the rank comparison in `isRoleHigher`. It is private, so it is
 * exercised through `startImpersonation` — the only caller — together with the
 * audit trail and the transaction boundary that trail depends on.
 */

const ROLES = {
  superAdmin: { id: 'role-super', name: 'SuperAdmin' },
  admin: { id: 'role-admin', name: 'Admin' },
  otherAdmin: { id: 'role-admin-2', name: 'Admin' },
  support: { id: 'role-support', name: 'Support' },
  user: { id: 'role-user', name: 'User' },
  unknown: { id: 'role-x', name: 'TenantOwner' },
};

const REASON = 'customer reported a failed top-up, ticket 4417';

type Harness = ReturnType<typeof harness>;

function harness() {
  const txClient = {
    impersonationSession: {
      create: jest.fn().mockResolvedValue({ id: 'imp-1' }),
    },
    session: { create: jest.fn().mockResolvedValue({ id: 'session-imp' }) },
    adminAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const prisma = {
    user: { findUnique: jest.fn() },
    session: {
      findUnique: jest.fn(),
      update: jest.fn((args: unknown) => ({ __op: 'session.update', args })),
    },
    impersonationSession: {
      update: jest.fn((args: unknown) => ({
        __op: 'impersonationSession.update',
        args,
      })),
    },
    adminAuditLog: {
      create: jest.fn((args: unknown) => ({ __op: 'adminAuditLog.create', args })),
    },
    $transaction: jest.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(txClient)
        : arg,
    ),
  };
  const tokens = {
    signImpersonatedToken: jest.fn().mockReturnValue('impersonated-token'),
  };
  const activateCache = jest.fn().mockResolvedValue(undefined);
  const sessionService = {
    createSession: jest.fn().mockResolvedValue({
      session: { id: 'session-imp' },
      refreshToken: 'r',
      activateCache,
    }),
    revokeSession: jest.fn().mockResolvedValue(undefined),
  };
  const sessions = { drop: jest.fn().mockResolvedValue(undefined) };

  const service = new ImpersonationService(
    prisma as never,
    tokens as never,
    sessionService as never,
    sessions as never,
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

const userWith = (
  role: { id: string; name: string },
  over: Record<string, unknown> = {},
) => ({
  id: 'u',
  tenantId: 'tenant-1',
  roleId: role.id,
  status: 'active',
  role: { ...role, rolePermissions: [] },
  ...over,
});

/** `findUnique` is called for the admin first, then the target. */
function actors(
  h: Harness,
  adminRole: { id: string; name: string },
  targetRole: { id: string; name: string },
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

describe('ImpersonationService.startImpersonation — rank', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
  });

  it.each([
    ['Admin', 'Support', ROLES.admin, ROLES.support],
    ['Admin', 'User', ROLES.admin, ROLES.user],
    ['SuperAdmin', 'Admin', ROLES.superAdmin, ROLES.admin],
    ['Support', 'User', ROLES.support, ROLES.user],
  ])('lets a %s impersonate a %s', async (_a, _t, adminRole, targetRole) => {
    actors(h, adminRole, targetRole);

    await expect(start(h)).resolves.toEqual({
      accessToken: 'impersonated-token',
      expiresIn: 1800,
    });
  });

  it.each([
    ['equal rank under a different role row', ROLES.admin, ROLES.otherAdmin],
    ['a strictly higher rank', ROLES.admin, ROLES.superAdmin],
    ['a higher rank, from Support', ROLES.support, ROLES.admin],
  ])('refuses %s', async (_label, adminRole, targetRole) => {
    actors(h, adminRole, targetRole);

    await expect(start(h)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses the same role row outright, before rank is consulted', async () => {
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

  /**
   * An unranked role name scores 0. Because the comparison is `>=`, two
   * unranked roles refuse each other, and any ranked target outranks an
   * unranked admin — the failure direction is "deny", which is the one we
   * want when a new role is added and the table is not updated with it.
   */
  it('denies rather than allows when a role name is not in the rank table', async () => {
    actors(h, ROLES.unknown, ROLES.user);
    await expect(start(h)).rejects.toBeInstanceOf(ForbiddenException);

    jest.clearAllMocks();
    actors(h, ROLES.unknown, { id: 'role-y', name: 'Auditor' });
    await expect(start(h)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a ranked admin impersonate an unranked role', async () => {
    // rank(TenantOwner)=0 >= rank(SuperAdmin)=4 is false, so this is allowed.
    actors(h, ROLES.superAdmin, ROLES.unknown);
    await expect(start(h)).resolves.toMatchObject({ expiresIn: 1800 });
  });
});

describe('ImpersonationService.startImpersonation — preconditions', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
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
   * refused on rank even when the reason note is also missing, so a missing
   * note never reveals that the rank check would have passed.
   */
  it('checks rank before the reason note', async () => {
    actors(h, ROLES.admin, ROLES.superAdmin);
    await expect(start(h, '')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ImpersonationService.startImpersonation — transaction and audit', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
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
    jest.clearAllMocks();
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
