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
 * *browser's* scope — a webview that was signed into the chat's scope would
 * show a switch group none of its later calls could see (ADR-0015).
 */
describe('BotSessionService.authenticateWebApp', () => {
  const webApp = { platform: 'telegram' as const, initData: 'signed' };

  it('signs in the account the signature names, under the browser scope', async () => {
    const { service, auth } = harness({ link: { userId: 'u-1' } });

    const outcome = await inTenant(() =>
      service.authenticateWebApp(
        webApp,
        { ip: '1.2.3.4', userAgent: 'Mozilla/5.0' },
        'device:abc',
      ),
    );

    expect(outcome).toMatchObject({ state: 'authenticated' });
    expect(auth.createSessionForUser).toHaveBeenCalledWith(
      expect.anything(),
      '1.2.3.4',
      'Mozilla/5.0',
      'device:abc',
      'Telegram',
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
        service.authenticateWebApp(
          webApp,
          { ip: '', userAgent: 'Mozilla/5.0' },
          'device:abc',
        ),
      ),
    ).toEqual({ state: 'refused', key: 'auth.invalidCredentials' });
    expect(prisma.linkedBotAccount.findFirst).not.toHaveBeenCalled();
  });
});
