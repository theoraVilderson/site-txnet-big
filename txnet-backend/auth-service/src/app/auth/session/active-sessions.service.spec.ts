import { ActiveSessionsService } from './active-sessions.service';

/**
 * The caller's own places, Telegram-style: one entry per place, never per
 * token, and ending a place ends it for good (SES-1-a).
 *
 * "For good" is the part that is easy to get wrong, because a revoked session
 * is not the only way back in:
 *
 * - a browser's switch group lets any member there become this account with
 *   no credential (F-0207), so the account leaves that group too;
 * - a bot chat signs itself back in against its link (ADR-0034), so the
 *   caller's own link to that chat goes too.
 */
describe('ActiveSessionsService', () => {
  const USER = 'user-1';
  const CURRENT = 'sess-current';
  const HERE = 'device:here';
  const THERE = 'device:there';
  const CHAT = 'bot:tenant-1:telegram:777';
  const claims = { sub: USER, sessionId: CURRENT } as any;

  const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 10, minute));
  const row = (id: string, scopeKey: string | null, minute: number, extra = {}) => ({
    id,
    scopeKey,
    ipAddress: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    deviceLabel: null,
    issuedAt: at(minute),
    ...extra,
  });

  let prisma: any;
  let sessionService: any;
  let service: ActiveSessionsService;

  beforeEach(() => {
    const tx: any = {
      linkedAccountMember: {
        delete: vi.fn(),
        findMany: vi.fn().mockResolvedValue([{ id: 'm2' }, { id: 'm3' }]),
        deleteMany: vi.fn(),
      },
      linkedAccountGroup: { delete: vi.fn() },
    };
    prisma = {
      tx,
      session: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue({ id: CURRENT, scopeKey: HERE }),
      },
      linkedAccountMember: { findUnique: vi.fn().mockResolvedValue(null) },
      linkedBotAccount: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    };
    sessionService = {
      revokeSession: vi.fn(),
      revokeSessionsForUserInScope: vi.fn().mockResolvedValue(1),
    };
    service = new ActiveSessionsService(prisma, sessionService);
  });

  describe('list', () => {
    it('reads only this account’s live sessions, never an admin’s impersonation', async () => {
      await service.list(claims);

      expect(prisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: USER,
            revokedAt: null,
            expiresAt: { gt: expect.any(Date) },
            isImpersonated: false,
          },
        }),
      );
    });

    it('shows a place once, by its newest session, with the current place first', async () => {
      prisma.session.findMany.mockResolvedValue([
        row('chat-new', CHAT, 50, { ipAddress: null, userAgent: null, deviceLabel: 'Telegram' }),
        row('there-new', THERE, 40),
        row(CURRENT, HERE, 30),
        row('chat-old', CHAT, 20, { ipAddress: null, userAgent: null, deviceLabel: 'Telegram' }),
      ]);

      const result: any = await service.list(claims);

      expect(result.ok).toBe(true);
      expect(result.data.sessions).toEqual([
        { id: CURRENT, current: true, surface: 'web', ipAddress: '1.2.3.4', userAgent: 'Mozilla/5.0', lastActiveAt: at(30).toISOString() },
        { id: 'chat-new', current: false, surface: 'telegram', ipAddress: null, userAgent: null, lastActiveAt: at(50).toISOString() },
        { id: 'there-new', current: false, surface: 'web', ipAddress: '1.2.3.4', userAgent: 'Mozilla/5.0', lastActiveAt: at(40).toISOString() },
      ]);
    });

    it('never puts a place key on the wire — it is the browser’s device cookie', async () => {
      prisma.session.findMany.mockResolvedValue([row(CURRENT, HERE, 30), row('x', THERE, 10)]);

      const result: any = await service.list(claims);

      expect(JSON.stringify(result)).not.toContain('device:');
    });

    it('lists an unscoped session on its own', async () => {
      prisma.session.findMany.mockResolvedValue([row(CURRENT, HERE, 30), row('old-1', null, 10), row('old-2', null, 5)]);

      const result: any = await service.list(claims);

      expect(result.data.sessions.map((s: any) => s.id)).toEqual([CURRENT, 'old-1', 'old-2']);
    });
  });

  describe('terminate', () => {
    it('refuses a session that is not the caller’s, without saying whose it is', async () => {
      const result: any = await service.terminate(claims, 'someone-elses');

      expect(prisma.session.findFirst).toHaveBeenCalledWith({
        where: { id: 'someone-elses', userId: USER },
        select: { id: true, scopeKey: true, revokedAt: true },
      });
      expect(result).toMatchObject({ ok: false, msg: 'auth.sessionNotFound' });
      expect(sessionService.revokeSessionsForUserInScope).not.toHaveBeenCalled();
    });

    it('refuses the place the caller is sitting in — that is logout', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 'sibling', scopeKey: HERE, revokedAt: null });

      const result: any = await service.terminate(claims, 'sibling');

      expect(result).toMatchObject({ ok: false, msg: 'auth.sessionIsCurrent' });
      expect(sessionService.revokeSessionsForUserInScope).not.toHaveBeenCalled();
    });

    it('ends a browser place: every session there, and the account leaves its group', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 'there-1', scopeKey: THERE, revokedAt: null });
      prisma.linkedAccountMember.findUnique.mockResolvedValue({ id: 'm1', groupId: 'g1' });

      const result: any = await service.terminate(claims, 'there-1');

      expect(result).toMatchObject({ ok: true, msg: 'auth.sessionTerminated' });
      expect(prisma.linkedAccountMember.findUnique).toHaveBeenCalledWith({
        where: { scopeKey_userId: { scopeKey: THERE, userId: USER } },
        select: { id: true, groupId: true },
      });
      expect(prisma.tx.linkedAccountMember.delete).toHaveBeenCalledWith({ where: { id: 'm1' } });
      expect(sessionService.revokeSessionsForUserInScope).toHaveBeenCalledWith(USER, THERE, 'user_logout');
      expect(prisma.linkedBotAccount.deleteMany).not.toHaveBeenCalled();
    });

    it('still finds the place when the id it was shown has since rotated', async () => {
      // A refresh revokes the row and mints the next one in the same place,
      // so the list a person is reading can be one rotation behind.
      prisma.session.findFirst.mockResolvedValue({ id: 'there-old', scopeKey: THERE, revokedAt: at(1) });

      const result: any = await service.terminate(claims, 'there-old');

      expect(result.ok).toBe(true);
      expect(sessionService.revokeSessionsForUserInScope).toHaveBeenCalledWith(USER, THERE, 'user_logout');
    });

    it('ends a bot chat and unlinks the caller’s own link to it, so it cannot sign back in', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 'chat-1', scopeKey: CHAT, revokedAt: null });

      await service.terminate(claims, 'chat-1');

      expect(sessionService.revokeSessionsForUserInScope).toHaveBeenCalledWith(USER, CHAT, 'user_logout');
      expect(prisma.linkedBotAccount.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER, platform: 'telegram', platformUserId: '777' },
      });
    });

    it('revokes an unscoped session by its own id', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 'old-1', scopeKey: null, revokedAt: null });

      const result: any = await service.terminate(claims, 'old-1');

      expect(result.ok).toBe(true);
      expect(sessionService.revokeSession).toHaveBeenCalledWith('old-1', 'user_logout');
      expect(sessionService.revokeSessionsForUserInScope).not.toHaveBeenCalled();
    });
  });

  describe('terminateOthers', () => {
    it('ends every place except the caller’s own', async () => {
      prisma.session.findMany.mockResolvedValue([
        row(CURRENT, HERE, 30),
        row('sibling', HERE, 29),
        row('there-1', THERE, 20),
        row('chat-1', CHAT, 10, { ipAddress: null, userAgent: null, deviceLabel: 'Telegram' }),
      ]);

      const result: any = await service.terminateOthers(claims);

      expect(result).toMatchObject({ ok: true, msg: 'auth.otherSessionsTerminated', data: { terminated: 2 } });
      const scopes = sessionService.revokeSessionsForUserInScope.mock.calls.map((c: any[]) => c[1]);
      expect(scopes.sort()).toEqual([CHAT, THERE].sort());
      expect(prisma.linkedBotAccount.deleteMany).toHaveBeenCalledTimes(1);
    });
  });
});
