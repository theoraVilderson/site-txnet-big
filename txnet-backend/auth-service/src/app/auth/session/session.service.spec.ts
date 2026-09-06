import { SessionService } from './session.service';

/**
 * `revokeSessionsForUserInScope` is the narrow half of the pair, and the
 * narrowness is the feature (F-0208 under ADR-0015): removing an account from
 * a group in one browser must not sign it out of a Telegram chat it is still a
 * member of. The global `revokeAllSessionsForUser` right next to it is one
 * autocomplete away, so what is pinned here is the difference between them.
 */
describe('SessionService.revokeSessionsForUserInScope', () => {
  const USER = 'user-1';
  const SCOPE = 'device:browser-a';

  let prisma: any;
  let sessions: any;
  let service: SessionService;

  beforeEach(() => {
    prisma = {
      session: {
        findMany: jest.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    sessions = {
      drop: jest.fn().mockResolvedValue(undefined),
      dropAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    service = new SessionService(prisma, {} as any, sessions);
  });

  it('selects only this user, this scope, and only live sessions', async () => {
    await service.revokeSessionsForUserInScope(USER, SCOPE, 'account_unlinked');

    expect(prisma.session.findMany).toHaveBeenCalledWith({
      where: { userId: USER, scopeKey: SCOPE, revokedAt: null },
      select: { id: true },
    });
  });

  it('revokes exactly the rows it found, with the reason given', async () => {
    const count = await service.revokeSessionsForUserInScope(
      USER,
      SCOPE,
      'account_unlinked',
    );

    expect(count).toBe(2);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2'] } },
      data: { revokedAt: expect.any(Date), revokedReason: 'account_unlinked' },
    });
  });

  it('drops the markers one by one, never the whole user', async () => {
    await service.revokeSessionsForUserInScope(USER, SCOPE, 'account_unlinked');

    expect(sessions.drop).toHaveBeenCalledWith('s1', USER);
    expect(sessions.drop).toHaveBeenCalledWith('s2', USER);
    // `dropAllForUser` is keyed on the user alone, so calling it here would
    // sign the account out of every other surface — the exact blast radius
    // ADR-0015 exists to avoid.
    expect(sessions.dropAllForUser).not.toHaveBeenCalled();
  });

  it('does nothing at all when this scope holds no live session', async () => {
    prisma.session.findMany.mockResolvedValue([]);

    const count = await service.revokeSessionsForUserInScope(
      USER,
      SCOPE,
      'account_unlinked',
    );

    expect(count).toBe(0);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(sessions.drop).not.toHaveBeenCalled();
  });
});

/** The scope has to survive onto the row, or nothing above it can work. */
describe('SessionService.createSession — scopeKey', () => {
  const build = () => {
    const create = jest.fn(async (args: any) => ({ id: 'sess-1', ...args.data }));
    const prisma: any = { session: { create } };
    const tokens: any = {
      newRefreshToken: () => 'refresh',
      refreshHash: () => 'hash',
    };
    const sessions: any = { register: jest.fn() };
    return { create, service: new SessionService(prisma, tokens, sessions) };
  };

  it('writes the scope it was given', async () => {
    const { create, service } = build();

    await service.createSession('u1', '1.1.1.1', 'jest', {
      scopeKey: 'bot:telegram:900',
    });

    expect(create.mock.calls[0][0].data.scopeKey).toBe('bot:telegram:900');
  });

  it('writes null when there is none, rather than leaving it undefined', async () => {
    const { create, service } = build();

    // Impersonation takes this path deliberately: an admin's session belongs
    // to no switch group, so it must match no scope on the way back out.
    await service.createSession('u1', '1.1.1.1', 'jest');

    expect(create.mock.calls[0][0].data.scopeKey).toBeNull();
  });
});
