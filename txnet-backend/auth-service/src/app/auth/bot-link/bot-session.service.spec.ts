import { BotSessionService } from './bot-session.service';

/**
 * These are the rules ADR-0012 turns on, so they are asserted here rather than
 * inferred from the bot's behaviour: who this factor signs in, who it refuses,
 * and that a contact card is checked exactly as invariant #12 checks one.
 */
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
  return {
    prisma,
    auth,
    service: new BotSessionService(prisma as any, auth as any),
  };
}

const ctx = { platform: 'telegram' as const, chatId: '5501', senderId: 42 };

describe('BotSessionService', () => {
  it('signs in a chat that already holds a contact-verified link', async () => {
    const { service, auth } = harness({ link: { userId: 'u-1' } });

    const outcome = await service.authenticate(ctx, '1.2.3.4', 'bot');

    expect(outcome).toEqual({
      state: 'authenticated',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 900 },
    });
    expect(auth.createSessionForUser).toHaveBeenCalled();
  });

  it('asks for the contact card when the chat has no link yet', async () => {
    const { service } = harness();

    expect(await service.authenticate(ctx, '', 'bot')).toEqual({
      state: 'needsContact',
    });
  });

  it('links and signs in from the card itself — no phone typed, no code', async () => {
    const { service, prisma } = harness({ byPhone: linkedUser });

    const outcome = await service.authenticate(
      { ...ctx, contact: { phone_number: '+989121112233', user_id: 42 } },
      '',
      'bot',
    );

    expect(prisma.linkedBotAccount.upsert).toHaveBeenCalled();
    expect(outcome.state).toBe('authenticated');
  });

  it('rejects a card that describes someone other than its sender', async () => {
    // Invariant #12, unchanged: a contact card can carry any phone number, but
    // not a `user_id` other than its owner's.
    const { service, prisma } = harness({ byPhone: linkedUser });

    const outcome = await service.authenticate(
      { ...ctx, contact: { phone_number: '+989121112233', user_id: 99 } },
      '',
      'bot',
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

    expect(await service.authenticate(ctx, '', 'bot')).toEqual({
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

    expect(await service.authenticate(ctx, '', 'bot')).toEqual({
      state: 'refused',
      key: 'auth.invalidCredentials',
    });
  });
});
