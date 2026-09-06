import { AccountSwitchService } from './account-switch.service';

/** The two surfaces every test below keeps apart (ADR-0015). */
const BROWSER = 'device:browser-a';
const CHAT = 'bot:telegram:900';

/** Member rows are addressed by the pair now, so the fake store is keyed by it. */
const rowKey = (scopeKey: string, userId: string) => `${scopeKey}|${userId}`;

/**
 * The membership rule is the whole feature: after this, switching costs no
 * credential (F-0207), so the only place a wrong answer here can still be
 * caught is here. The proofs themselves belong to identity and are tested with
 * `AuthService`; what is asserted below is what the group does with a proof.
 */
describe('AccountSwitchService.addByPassword', () => {
  const CALLER = 'caller-id';
  const TARGET = 'target-id';

  let members: Record<string, { userId: string; groupId: string; scopeKey: string }>;
  let created: any[];
  let createdMany: any[];
  let service: AccountSwitchService;
  let proveByPassword: jest.Mock;

  const input = { identifier: '09123456789', password: 'pw' };

  beforeEach(() => {
    members = {};
    created = [];
    createdMany = [];
    proveByPassword = jest.fn().mockResolvedValue({ id: TARGET });

    const memberDelegate = {
      findUnique: jest.fn(({ where }: any) => {
        const { scopeKey, userId } = where.scopeKey_userId;
        return members[rowKey(scopeKey, userId)] ?? null;
      }),
      create: jest.fn((args: any) => {
        created.push(args.data);
        return args.data;
      }),
      createMany: jest.fn((args: any) => {
        createdMany.push(...args.data);
        return { count: args.data.length };
      }),
    };

    const prisma: any = {
      user: {
        findUnique: jest.fn(({ where }: any) =>
          where.id === CALLER
            ? {
                id: CALLER,
                phoneNumber: '09990000000',
                status: 'active',
                deletedAt: null,
              }
            : null,
        ),
      },
      linkedAccountMember: memberDelegate,
      linkedAccountGroup: { create: jest.fn(async () => ({ id: 'group-1' })) },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          linkedAccountMember: memberDelegate,
          linkedAccountGroup: { create: async () => ({ id: 'group-1' }) },
        }),
      ),
    };

    service = new AccountSwitchService(
      prisma,
      { proveAccountByPassword: proveByPassword } as any,
      {} as any,
    );
  });

  it('creates the group with BOTH the founder and the joiner', async () => {
    const res: any = await service.addByPassword(BROWSER, CALLER, input);

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ groupId: 'group-1', added: true });
    // The founder row is the part that is easy to forget and impossible to
    // repair later: `(scopeKey, userId)` is unique, so a caller left out of
    // their own group cannot simply be inserted afterwards without a delete.
    expect(createdMany.map((m) => m.userId).sort()).toEqual(
      [CALLER, TARGET].sort(),
    );
    expect(createdMany.find((m) => m.userId === TARGET).verifiedViaOtp).toBe(
      false,
    );
    // Both rows carry the same scope. A group whose members disagreed about
    // where they live would be readable from one surface and half-readable
    // from another.
    expect(createdMany.every((m) => m.scopeKey === BROWSER)).toBe(true);
  });

  it('adds to the existing group when the caller already has one', async () => {
    members[rowKey(BROWSER, CALLER)] = {
      userId: CALLER,
      groupId: 'group-existing',
      scopeKey: BROWSER,
    };

    const res: any = await service.addByPassword(BROWSER, CALLER, input);

    expect(res.data).toEqual({ groupId: 'group-existing', added: true });
    expect(createdMany).toHaveLength(0);
    expect(created).toEqual([
      {
        groupId: 'group-existing',
        userId: TARGET,
        scopeKey: BROWSER,
        verifiedViaOtp: false,
      },
    ]);
  });

  it('refuses an account that already belongs to someone else HERE', async () => {
    members[rowKey(BROWSER, CALLER)] = {
      userId: CALLER,
      groupId: 'group-a',
      scopeKey: BROWSER,
    };
    members[rowKey(BROWSER, TARGET)] = {
      userId: TARGET,
      groupId: 'group-b',
      scopeKey: BROWSER,
    };

    const res: any = await service.addByPassword(BROWSER, CALLER, input);

    expect(res.ok).toBe(false);
    expect(res.msg).toBe('accountSwitch.alreadyInAnotherGroup');
    expect(created).toHaveLength(0);
  });

  /**
   * The reversal ADR-0015 actually makes. Before it, one row anywhere blocked
   * the account everywhere; now a group in the chat is simply not visible from
   * the browser, so the add proceeds and builds a second, independent set.
   */
  it('ignores a group the account holds in ANOTHER scope', async () => {
    members[rowKey(CHAT, TARGET)] = {
      userId: TARGET,
      groupId: 'group-in-chat',
      scopeKey: CHAT,
    };

    const res: any = await service.addByPassword(BROWSER, CALLER, input);

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ groupId: 'group-1', added: true });
    expect(createdMany.every((m) => m.scopeKey === BROWSER)).toBe(true);
  });

  it('is idempotent when the account is already in the caller group', async () => {
    members[rowKey(BROWSER, CALLER)] = {
      userId: CALLER,
      groupId: 'group-a',
      scopeKey: BROWSER,
    };
    members[rowKey(BROWSER, TARGET)] = {
      userId: TARGET,
      groupId: 'group-a',
      scopeKey: BROWSER,
    };

    const res: any = await service.addByPassword(BROWSER, CALLER, input);

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ groupId: 'group-a', added: false });
    expect(created).toHaveLength(0);
  });

  it('refuses to add the caller to their own group', async () => {
    proveByPassword.mockResolvedValue({ id: CALLER });

    const res: any = await service.addByPassword(BROWSER, CALLER, input);

    expect(res.ok).toBe(false);
    expect(res.msg).toBe('accountSwitch.sameAccount');
  });

  it('answers one key for every failed proof, and writes nothing', async () => {
    proveByPassword.mockResolvedValue(null);

    const res: any = await service.addByPassword(BROWSER, CALLER, input);

    expect(res.ok).toBe(false);
    expect(res.msg).toBe('accountSwitch.proofFailed');
    expect(created).toHaveLength(0);
    expect(createdMany).toHaveLength(0);
  });

  /**
   * A call the server cannot place — no cookie, or a bot call with no platform
   * header — writes nothing. Falling back to a global group here is exactly
   * the behaviour ADR-0015 removed, so it must not creep back as a default.
   */
  it('refuses to add anything when the scope cannot be resolved', async () => {
    const res: any = await service.addByPassword(null, CALLER, input);

    expect(res.ok).toBe(false);
    expect(res.msg).toBe('accountSwitch.noScope');
    expect(created).toHaveLength(0);
    expect(createdMany).toHaveLength(0);
    // The proof is never even spent: refusing after sending the code would
    // burn the user's one-time code for a call that could never succeed.
    expect(proveByPassword).not.toHaveBeenCalled();
  });
});

/**
 * F-0206 / F-0207 / F-0208. The invariants that only exist at this layer: a
 * member of another tenant is invisible and unreachable (audit #6, C-22), a
 * switch hands the session handover to identity exactly once (audit #7), one
 * scope cannot see another (ADR-0015), and a removal revokes only here.
 */
describe('AccountSwitchService.list / switchTo / remove', () => {
  const CALLER = 'caller-id';
  const SAME_TENANT = 'sibling-id';
  const OTHER_TENANT = 'other-tenant-id';
  const TENANT = 'tenant-a';
  const SESSION = 'session-1';

  const USERS: Record<string, any> = {
    [CALLER]: {
      id: CALLER,
      fullName: 'Caller',
      phoneNumber: '09120000001',
      tenantId: TENANT,
      status: 'active',
      deletedAt: null,
    },
    [SAME_TENANT]: {
      id: SAME_TENANT,
      fullName: 'Sibling',
      phoneNumber: '09120000002',
      tenantId: TENANT,
      status: 'active',
      deletedAt: null,
    },
    [OTHER_TENANT]: {
      id: OTHER_TENANT,
      fullName: 'Other brand',
      phoneNumber: '09120000003',
      tenantId: 'tenant-b',
      status: 'active',
      deletedAt: null,
    },
  };

  let members: Record<
    string,
    { id: string; userId: string; groupId: string; scopeKey: string }
  >;
  let service: AccountSwitchService;
  let switchSession: jest.Mock;
  let revokeInScope: jest.Mock;
  let deletedGroups: string[];

  const put = (scopeKey: string, userId: string, groupId: string) => {
    members[rowKey(scopeKey, userId)] = {
      id: `row-${scopeKey}-${userId}`,
      userId,
      groupId,
      scopeKey,
    };
  };

  beforeEach(() => {
    members = {};
    deletedGroups = [];
    put(BROWSER, CALLER, 'g1');
    put(BROWSER, SAME_TENANT, 'g1');
    put(BROWSER, OTHER_TENANT, 'g1');

    switchSession = jest.fn().mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 900,
    });
    revokeInScope = jest.fn().mockResolvedValue(1);

    const memberDelegate = {
      findUnique: jest.fn(({ where }: any) => {
        const { scopeKey, userId } = where.scopeKey_userId;
        return members[rowKey(scopeKey, userId)] ?? null;
      }),
      findMany: jest.fn(({ where }: any) =>
        Object.values(members).filter(
          (m) =>
            m.groupId === where.groupId &&
            (where.userId?.not === undefined || m.userId !== where.userId.not),
        ),
      ),
      delete: jest.fn(({ where }: any) => {
        const found = Object.entries(members).find(
          ([, m]) => m.id === where.id,
        );
        if (found) delete members[found[0]];
        return found?.[1];
      }),
      deleteMany: jest.fn(({ where }: any) => {
        for (const [k, m] of Object.entries(members)) {
          if (m.groupId === where.groupId) delete members[k];
        }
        return { count: 0 };
      }),
    };

    const prisma: any = {
      user: {
        findUnique: jest.fn(({ where }: any) => USERS[where.id] ?? null),
        findMany: jest.fn(({ where }: any) =>
          where.id.in
            .map((id: string) => USERS[id])
            .filter((u: any) => u && u.tenantId === where.tenantId),
        ),
      },
      linkedAccountMember: memberDelegate,
      linkedAccountGroup: {
        delete: jest.fn(({ where }: any) => {
          deletedGroups.push(where.id);
          return { id: where.id };
        }),
      },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          linkedAccountMember: memberDelegate,
          linkedAccountGroup: {
            delete: async ({ where }: any) => {
              deletedGroups.push(where.id);
              return { id: where.id };
            },
          },
        }),
      ),
    };

    service = new AccountSwitchService(
      prisma,
      {
        findUserForSession: jest.fn(async (id: string) => USERS[id] ?? null),
        switchSession,
      } as any,
      { revokeSessionsForUserInScope: revokeInScope } as any,
    );
  });

  it('lists the caller apart from the members, phone masked', async () => {
    const res: any = await service.list(BROWSER, CALLER);

    expect(res.ok).toBe(true);
    expect(res.data.current).toEqual({
      userId: CALLER,
      fullName: 'Caller',
      phoneMasked: '0912***0001',
    });
    // The full number never leaves the service — this list renders on a page
    // someone else may be looking at (F-0206).
    expect(JSON.stringify(res.data)).not.toContain('09120000002');
  });

  it('hides a member belonging to another tenant (C-22)', async () => {
    const res: any = await service.list(BROWSER, CALLER);

    expect(res.data.members.map((m: any) => m.userId)).toEqual([SAME_TENANT]);
  });

  it('answers an empty group before the first account is added', async () => {
    members = {};

    const res: any = await service.list(BROWSER, CALLER);

    expect(res.data).toEqual({
      groupId: null,
      current: expect.objectContaining({ userId: CALLER }),
      members: [],
    });
  });

  /** The headline of ADR-0015, asserted from the reading side. */
  it('shows a browser group as empty from the chat, and vice versa', async () => {
    const fromChat: any = await service.list(CHAT, CALLER);
    expect(fromChat.ok).toBe(true);
    expect(fromChat.data).toEqual({
      groupId: null,
      current: expect.objectContaining({ userId: CALLER }),
      members: [],
    });

    // The same account, a different set, at the same moment.
    put(CHAT, CALLER, 'g-chat');
    put(CHAT, SAME_TENANT, 'g-chat');

    const again: any = await service.list(CHAT, CALLER);
    expect(again.data.groupId).toBe('g-chat');
    expect((await service.list(BROWSER, CALLER) as any).data.groupId).toBe('g1');
  });

  it('lists nothing when the scope cannot be resolved', async () => {
    const res: any = await service.list(null, CALLER);

    expect(res.ok).toBe(true);
    expect(res.data.members).toEqual([]);
    expect(res.data.groupId).toBeNull();
  });

  it('switches to a member of the same group and tenant', async () => {
    const res: any = await service.switchTo(
      BROWSER,
      CALLER,
      SESSION,
      SAME_TENANT,
      '1.1.1.1',
      'jest',
    );

    expect(res.ok).toBe(true);
    expect(res.msg).toBe('accountSwitch.switched');
    expect(res.data).toEqual({
      userId: SAME_TENANT,
      fullName: 'Sibling',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 900,
    });
    // Identity revokes the outgoing session in the same transaction that
    // issues the incoming one — audit invariant #7 lives on the other side of
    // this call, so what is asserted here is that the call is made with the
    // session actually being left, and with the scope the switch happened in.
    expect(switchSession).toHaveBeenCalledWith(
      SESSION,
      CALLER,
      expect.objectContaining({ id: SAME_TENANT }),
      '1.1.1.1',
      'jest',
      BROWSER,
    );
  });

  it('refuses a switch to a member of the group in another scope', async () => {
    put(CHAT, CALLER, 'g-chat');
    put(CHAT, SAME_TENANT, 'g-chat');

    // Sitting in the browser, naming a pair that is only a group in the chat.
    delete members[rowKey(BROWSER, SAME_TENANT)];

    const res: any = await service.switchTo(
      BROWSER,
      CALLER,
      SESSION,
      SAME_TENANT,
      '1.1.1.1',
      'jest',
    );

    expect(res.ok).toBe(false);
    expect(res.msg).toBe('accountSwitch.notAMember');
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('refuses a cross-tenant switch and issues nothing (C-22)', async () => {
    const res: any = await service.switchTo(
      BROWSER,
      CALLER,
      SESSION,
      OTHER_TENANT,
      '1.1.1.1',
      'jest',
    );

    expect(res.ok).toBe(false);
    expect(res.msg).toBe('accountSwitch.notAMember');
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('refuses a target outside the caller group, with the same key', async () => {
    put(BROWSER, SAME_TENANT, 'g2');

    const res: any = await service.switchTo(
      BROWSER,
      CALLER,
      SESSION,
      SAME_TENANT,
      '1.1.1.1',
      'jest',
    );

    expect(res.ok).toBe(false);
    expect(res.msg).toBe('accountSwitch.notAMember');
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('refuses switching to the account already signed in', async () => {
    const res: any = await service.switchTo(
      BROWSER,
      CALLER,
      SESSION,
      CALLER,
      '1.1.1.1',
      'jest',
    );

    expect(res.msg).toBe('accountSwitch.sameAccount');
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('refuses a switch with no resolvable scope', async () => {
    const res: any = await service.switchTo(
      null,
      CALLER,
      SESSION,
      SAME_TENANT,
      '1.1.1.1',
      'jest',
    );

    expect(res.msg).toBe('accountSwitch.notAMember');
    expect(switchSession).not.toHaveBeenCalled();
  });

  // --- F-0208 --------------------------------------------------------------

  it('removes another member, and revokes its sessions in THIS scope only', async () => {
    const res: any = await service.remove(BROWSER, CALLER, SAME_TENANT);

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ userId: SAME_TENANT, removed: true });
    expect(members[rowKey(BROWSER, SAME_TENANT)]).toBeUndefined();
    // The narrow revoke, not the global one. This is the assertion that would
    // fail if someone "simplified" it back to `revokeAllSessionsForUser`.
    expect(revokeInScope).toHaveBeenCalledWith(
      SAME_TENANT,
      BROWSER,
      'account_unlinked',
    );
  });

  it('removes the caller itself — F-0208 works from either side', async () => {
    const res: any = await service.remove(BROWSER, CALLER, CALLER);

    expect(res.ok).toBe(true);
    expect(members[rowKey(BROWSER, CALLER)]).toBeUndefined();
    expect(revokeInScope).toHaveBeenCalledWith(CALLER, BROWSER, 'account_unlinked');
  });

  it('leaves the same account untouched in every other scope', async () => {
    put(CHAT, SAME_TENANT, 'g-chat');
    put(CHAT, CALLER, 'g-chat');

    await service.remove(BROWSER, CALLER, SAME_TENANT);

    // The chat's group is intact, and nothing revoked anything there.
    expect(members[rowKey(CHAT, SAME_TENANT)]).toBeDefined();
    expect(revokeInScope).toHaveBeenCalledTimes(1);
    expect(revokeInScope).not.toHaveBeenCalledWith(
      expect.anything(),
      CHAT,
      expect.anything(),
    );
  });

  it('tears the group down once one member would be left', async () => {
    delete members[rowKey(BROWSER, OTHER_TENANT)];

    await service.remove(BROWSER, CALLER, SAME_TENANT);

    // A group of one is not a switcher; leaving it standing means the next add
    // joins a stale group instead of creating a fresh one.
    expect(deletedGroups).toEqual(['g1']);
    expect(members[rowKey(BROWSER, CALLER)]).toBeUndefined();
  });

  it('refuses to remove someone who is not in this group, and revokes nothing', async () => {
    put(BROWSER, SAME_TENANT, 'g2');

    const res: any = await service.remove(BROWSER, CALLER, SAME_TENANT);

    expect(res.ok).toBe(false);
    expect(res.msg).toBe('accountSwitch.notAMember');
    expect(members[rowKey(BROWSER, SAME_TENANT)]).toBeDefined();
    expect(revokeInScope).not.toHaveBeenCalled();
  });

  it('refuses a removal with no resolvable scope', async () => {
    const res: any = await service.remove(null, CALLER, SAME_TENANT);

    expect(res.msg).toBe('accountSwitch.notAMember');
    expect(revokeInScope).not.toHaveBeenCalled();
  });
});
