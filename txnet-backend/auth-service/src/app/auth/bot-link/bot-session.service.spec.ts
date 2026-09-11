import { aBotIntegration } from '@txnet-backend/messenger';
import { runWithTenant } from '../../tenant-context/tenant-context';
import { BotSessionService } from './bot-session.service';

/**
 * These are the rules ADR-0012 turns on, so they are asserted here rather than
 * inferred from the bot's behaviour: who this factor signs in, who it refuses,
 * and that a contact card is checked exactly as invariant #12 checks one.
 */
/**
 * A tenant in scope: a Mini App's `initData` is verified against that tenant's
 * own bot token now, so there is nothing to verify against without one.
 */
const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenant({ id: 'tenant-1', slug: 'reseller-a', via: 'domain' }, fn);

const linkedUser = {
  id: 'u-1',
  deletedAt: null,
  status: 'active',
  phoneVerifiedAt: new Date(),
  role: { name: 'user' },
};

function harness(over: {
  link?: unknown;
  user?: unknown;
  byPhone?: unknown;
  taken?: unknown;
} = {}) {
  const prisma = {
    linkedBotAccount: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(over.link ?? null)
        .mockResolvedValue(over.taken ?? null),
      upsert: jest.fn(),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(over.user ?? linkedUser),
      findFirst: jest.fn().mockResolvedValue(over.byPhone ?? null),
    },
    // ADR-0034: the place's own group, and whether it is acting as someone
    // other than the linked account. Default is "never switched".
    linkedAccountMember: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue({ id: 'still-a-member' }),
    },
  };
  const auth = {
    createSessionForUser: jest.fn().mockResolvedValue({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
    }),
  };
  // The Mini App's proof is verified inside `messenger` (it owns the bot
  // token); what this service does with the answer is what is asserted here,
  // so the fake is the answer and nothing else.
  const bots = {
    primaryFor: jest.fn().mockResolvedValue(aBotIntegration()),
    verifyWebAppInitData: jest.fn().mockResolvedValue({
      ok: true,
      data: { platform: 'telegram', user: { id: '5501' }, authDate: 1 },
    }),
  };
  return {
    prisma,
    auth,
    bots,
    service: new BotSessionService(prisma as any, auth as any, bots as any),
  };
}

const ctx = { platform: 'telegram' as const, chatId: '5501', senderId: 42 };

describe('BotSessionService', () => {
  it('signs in a chat that already holds a contact-verified link', async () => {
    const { service, auth } = harness({ link: { userId: 'u-1' } });

    const outcome = await service.authenticate(ctx, null);

    expect(outcome).toEqual({
      state: 'authenticated',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 900 },
    });
    expect(auth.createSessionForUser).toHaveBeenCalled();
  });

  /**
   * F-048. A webhook carries a chat id and nothing else, so the row it mints
   * must not claim an IP or a user agent. The container's address was the
   * same for every chat on the platform, which is a worse answer than none.
   */
  it.each([
    ['telegram', 'Telegram'],
    ['bale', 'Bale'],
  ] as const)(
    'records no IP and no user agent for a %s chat, naming the messenger instead',
    async (platform, label) => {
      const { service, auth } = harness({ link: { userId: 'u-1' } });

      await service.authenticate({ ...ctx, platform }, null);

      expect(auth.createSessionForUser).toHaveBeenCalledWith(
        expect.anything(),
        null,
        null,
        expect.any(String),
        label,
      );
    },
  );

  it('asks for the contact card when the chat has no link yet', async () => {
    const { service } = harness();

    expect(await service.authenticate(ctx, null)).toEqual({
      state: 'needsContact',
    });
  });

  it('links and signs in from the card itself — no phone typed, no code', async () => {
    const { service, prisma } = harness({ byPhone: linkedUser });

    // In a tenant, because the link row it writes names one (F-066-l): a chat
    // id is unique within a tenant, so writing one without a tenant in scope
    // is the collision this row closed.
    const outcome = await inTenant(() =>
      service.authenticate(
        { ...ctx, contact: { phone_number: '+989121112233', user_id: 42 } },
        null,
      ),
    );

    expect(prisma.linkedBotAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ tenantId: 'tenant-1' }),
      }),
    );
    expect(outcome.state).toBe('authenticated');
  });

  it('rejects a card that describes someone other than its sender', async () => {
    // Invariant #12, unchanged: a contact card can carry any phone number, but
    // not a `user_id` other than its owner's.
    const { service, prisma } = harness({ byPhone: linkedUser });

    const outcome = await service.authenticate(
      { ...ctx, contact: { phone_number: '+989121112233', user_id: 99 } },
      null,
    );

    expect(outcome).toEqual({
      state: 'refused',
      key: 'otp.botLink.senderMismatch',
    });
    expect(prisma.linkedBotAccount.upsert).not.toHaveBeenCalled();
  });

  it('refuses a privileged role, which must use the ordinary paths', async () => {
    const { service, auth } = harness({
      link: { userId: 'u-1' },
      user: { ...linkedUser, role: { name: 'Admin' } },
    });

    expect(await service.authenticate(ctx, null)).toEqual({
      state: 'refused',
      key: 'auth.botFactorNotAllowed',
    });
    expect(auth.createSessionForUser).not.toHaveBeenCalled();
  });

  it('refuses an inactive account without saying more than a password login would', async () => {
    const { service } = harness({
      link: { userId: 'u-1' },
      user: { ...linkedUser, status: 'suspended' },
    });

    expect(await service.authenticate(ctx, null)).toEqual({
      state: 'refused',
      key: 'auth.invalidCredentials',
    });
  });
});

/**
 * The Mini App path (`F-310`, ADR-0018). Two things are its own and neither is
 * visible from the chat route's tests: an unverifiable signature is refused
 * before anything is looked up, and the session it mints belongs to the
 * **chat's** scope, taken from the same verified `initData` (ADR-0032). The
 * browser it happens to be running in has a `device_id` cookie and that cookie
 * does not decide anything here — the Mini App and the chat it was opened from
 * are one place.
 */
describe('BotSessionService.authenticateWebApp', () => {
  const webApp = { platform: 'telegram' as const, initData: 'signed' };

  it("signs in the account the signature names, under the chat's scope", async () => {
    const { service, auth } = harness({ link: { userId: 'u-1' } });

    const outcome = await inTenant(() =>
      service.authenticateWebApp(webApp, {
        ip: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
      }),
    );

    expect(outcome).toMatchObject({ state: 'authenticated' });
    expect(auth.createSessionForUser).toHaveBeenCalledWith(
      expect.anything(),
      '1.2.3.4',
      'Mozilla/5.0',
      // The chat named by the signature — the same key `/auth/bots/session`
      // uses from the chat itself, so the two share one switch group.
      'bot:telegram:5501',
      'Telegram',
    );
  });

  it('keys the scope by platform, so two messengers never share a chat id', async () => {
    const { service, auth, bots } = harness({ link: { userId: 'u-1' } });
    bots.verifyWebAppInitData.mockResolvedValue({
      ok: true,
      data: { platform: 'bale', user: { id: '5501' }, authDate: 1 },
    });

    await inTenant(() =>
      service.authenticateWebApp(
        { platform: 'bale', initData: 'signed' },
        { ip: '1.2.3.4', userAgent: 'Mozilla/5.0' },
      ),
    );

    expect(auth.createSessionForUser).toHaveBeenCalledWith(
      expect.anything(),
      '1.2.3.4',
      'Mozilla/5.0',
      'bot:bale:5501',
      expect.anything(),
    );
  });

  it('refuses an unverifiable signature without touching the database', async () => {
    const { service, prisma, bots } = harness({ link: { userId: 'u-1' } });
    bots.verifyWebAppInitData.mockResolvedValue({
      ok: false,
      reason: 'badSignature',
    });

    expect(
      await inTenant(() =>
        service.authenticateWebApp(webApp, {
          ip: '',
          userAgent: 'Mozilla/5.0',
        }),
      ),
    ).toEqual({ state: 'refused', key: 'auth.invalidCredentials' });
    expect(prisma.linkedBotAccount.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * ADR-0034, the reading half.
 *
 * A chat's `LinkedBotAccount` never moves (ADR-0014), so before this an
 * implicit sign-in always landed on the linked account — including right after
 * the user switched away from it, which is what made a switch look like it had
 * not happened on the other surface.
 */
describe('BotSessionService — an implicit sign-in follows the place', () => {
  const webApp = { platform: 'telegram' as const, initData: 'signed' };
  const SWITCHED_TO = 'u-switched-to';

  /** A harness whose user lookup answers by id, as the real one does. */
  function placeHarness(actingAsUserId: string | null) {
    const h = harness({ link: { userId: 'u-1' } });
    h.prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === SWITCHED_TO
        ? { ...linkedUser, id: SWITCHED_TO }
        : { ...linkedUser, id: 'u-1' },
    );
    h.prisma.linkedAccountMember.findUnique.mockResolvedValue({
      groupId: 'g1',
      group: { actingAsUserId },
    });
    return h;
  }

  const signedInAs = (auth: any) =>
    auth.createSessionForUser.mock.calls[0][0].id;

  it('signs in as the account this place last switched to', async () => {
    const { service, auth } = placeHarness(SWITCHED_TO);

    await inTenant(() =>
      service.authenticateWebApp(webApp, { ip: '', userAgent: 'Mozilla/5.0' }),
    );

    expect(signedInAs(auth)).toBe(SWITCHED_TO);
  });

  it('falls back to the linked account when the place never switched', async () => {
    const { service, auth } = placeHarness(null);

    await inTenant(() =>
      service.authenticateWebApp(webApp, { ip: '', userAgent: 'Mozilla/5.0' }),
    );

    expect(signedInAs(auth)).toBe('u-1');
  });

  it('falls back when the pointer names someone no longer in this group', async () => {
    // Removed by `F-0208` from this scope, or deleted outright. A stale
    // pointer must never be an authentication — the membership row is what
    // says the account is still one of this place's.
    const h = placeHarness(SWITCHED_TO);
    h.prisma.linkedAccountMember.findFirst.mockResolvedValue(null);

    await inTenant(() =>
      h.service.authenticateWebApp(webApp, { ip: '', userAgent: 'Mozilla/5.0' }),
    );

    expect(signedInAs(h.auth)).toBe('u-1');
  });

  it('refuses to follow a pointer at an account that is no longer active', async () => {
    const h = placeHarness(SWITCHED_TO);
    h.prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === SWITCHED_TO
        ? { ...linkedUser, id: SWITCHED_TO, status: 'suspended' }
        : { ...linkedUser, id: 'u-1' },
    );

    await inTenant(() =>
      h.service.authenticateWebApp(webApp, { ip: '', userAgent: 'Mozilla/5.0' }),
    );

    // Not a refusal: the place simply is not that account any more, and the
    // linked account is still perfectly entitled to sign in.
    expect(signedInAs(h.auth)).toBe('u-1');
  });
});
