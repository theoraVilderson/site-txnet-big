import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotClientRegistry } from '@txnet-backend/messenger';
import { runWithTenant } from '../../../tenant-context/tenant-context';
import { LocaleService } from '../../../locale/locale.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BotLinkStore } from '../../bot-link/bot-link.store';
import { OtpChannel, OtpPurpose } from '../otp.interface';
import { BaleOtpSender } from './bale.sender';
import { SmsOtpSender } from './sms.sender';
import { TelegramOtpSender } from './telegram.sender';

/**
 * The senders are where a one-time code leaves the platform, so the question
 * each of them answers is "who is allowed to receive this?" — and for the two
 * messenger channels that is `identity/invariants.md` #12: only a link whose
 * contact was verified. An unverified `linked_bot_account` row is a chat id
 * somebody claimed, not one that was shown to belong to this number, and
 * sending a login code to it hands over the account.
 *
 * The registration case is the one that makes this non-obvious: there is no
 * `user` row yet, so the proven chat is held in Redis and read from there —
 * a fallback that must not become a way around the verified-link rule when a
 * user *does* exist.
 */

const CODE = '123456';

function localeService(namespace?: unknown) {
  return {
    getNamespace: jest.fn(() => namespace),
  } as unknown as LocaleService;
}

function prisma({
  user = null as { id: string } | null,
  link = null as { platformUserId: string } | null,
} = {}) {
  return {
    user: { findFirst: jest.fn(async () => user) },
    linkedBotAccount: { findFirst: jest.fn(async () => link) },
  };
}

/**
 * The registry as a sender uses it since F-066-i: both questions are per
 * tenant, and the bot is that tenant's `primary` one (C-05).
 */
function registry(client: { sendMessage: jest.Mock } | null) {
  return {
    primaryClient: jest.fn(async () => client),
    canSend: jest.fn(async () => client !== null),
  } as unknown as BotClientRegistry;
}

/**
 * A tenant in scope, which every messenger send now requires: the token is
 * that tenant's, so a send with no tenant resolved has no bot to send as.
 */
const inTenant = <T>(fn: () => Promise<T> | T): Promise<T> | T =>
  runWithTenant({ id: 'tenant-1', slug: 'reseller-a', via: 'domain' }, fn);

function links(provenChat: string | null) {
  return {
    provenChat: jest.fn(async () => provenChat),
  } as unknown as BotLinkStore;
}

function botClient() {
  return {
    sendMessage: jest.fn(async (_chatId: string, _text: string) => undefined),
  };
}

/** The payload shape SmsProviderService.sendSMS is called with. */
interface SmsPayload {
  msg: string;
  to: string;
  vars?: Record<string, string | number>;
}

function smsProvider(result: { ok: boolean; msg: string }) {
  return jest.fn(async (_payload: SmsPayload, _sender: string) => result);
}

// The two messenger senders are the same class twice over, so they are tested
// as one table — a rule that held for Telegram and not for Bale would be the
// worst possible outcome here.
const messengerSenders = [
  {
    platform: 'telegram' as const,
    channel: OtpChannel.telegram,
    notConfigured: 'otp.telegramNotConfigured',
    notLinked: 'otp.telegramNotLinked',
    build: (
      p: ReturnType<typeof prisma>,
      bots: BotClientRegistry,
      l: BotLinkStore,
      loc: LocaleService,
    ) => new TelegramOtpSender(p as unknown as PrismaService, bots, l, loc),
  },
  {
    platform: 'bale' as const,
    channel: OtpChannel.bale,
    notConfigured: 'otp.baleNotConfigured',
    notLinked: 'otp.baleNotLinked',
    build: (
      p: ReturnType<typeof prisma>,
      bots: BotClientRegistry,
      l: BotLinkStore,
      loc: LocaleService,
    ) => new BaleOtpSender(p as unknown as PrismaService, bots, l, loc),
  },
];

describe.each(messengerSenders)('$platform OTP sender', (sender) => {
  it('declares its channel and that it needs a linked account', () => {
    const s = sender.build(prisma(), registry(botClient()), links(null), localeService());

    expect(s.channel).toBe(sender.channel);
    expect(s.requiresLinkedAccount).toBe(true);
  });

  it('is unconfigured when the tenant has no bot', async () => {
    // An allowed-but-unconfigured channel must not be offered to a client;
    // OtpChannelRegistry asks exactly this, and since F-066-i the answer is
    // the asking tenant's, not the deployment's.
    await expect(
      inTenant(() =>
        sender
          .build(prisma(), registry(null), links(null), localeService())
          .isConfigured(),
      ),
    ).resolves.toBe(false);
    await expect(
      inTenant(() =>
        sender
          .build(prisma(), registry(botClient()), links(null), localeService())
          .isConfigured(),
      ),
    ).resolves.toBe(true);
  });

  it('is unconfigured when no tenant is in scope at all', async () => {
    // Not a throw: `describe()` asks this while rendering a channel list, and
    // a channel nobody can be identified for is simply not offered.
    await expect(
      sender
        .build(prisma(), registry(botClient()), links(null), localeService())
        .isConfigured(),
    ).resolves.toBe(false);
  });

  it('sends to a contact-verified link of an existing user', async () => {
    const client = botClient();
    const p = prisma({ user: { id: 'u-1' }, link: { platformUserId: '5501' } });
    const s = sender.build(p, registry(client), links(null), localeService());

    await inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'));

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = client.sendMessage.mock.calls[0]!;
    expect(chatId).toBe('5501');
    expect(text).toContain(CODE);
  });

  it('only ever asks for a link whose contact was verified', async () => {
    // The `contactVerifiedAt: { not: null }` clause is the invariant. A query
    // without it would deliver codes to unproven chat ids.
    const p = prisma({ user: { id: 'u-1' }, link: { platformUserId: '5501' } });
    const s = sender.build(p, registry(botClient()), links(null), localeService());

    await inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'));

    expect(p.linkedBotAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u-1',
          platform: sender.platform,
          contactVerifiedAt: { not: null },
        }),
      }),
    );
  });

  it('falls back to the proven chat held in Redis during registration', async () => {
    // No user row exists yet at register time; the chat that already passed
    // the contact check is the only address there is.
    const client = botClient();
    const store = links('9902');
    const s = sender.build(prisma({ user: null }), registry(client), store, localeService());

    await inTenant(() => s.send('09121112233', CODE, OtpPurpose.register_phone_verify, 'en'));

    expect(store.provenChat).toHaveBeenCalledWith(sender.platform, '09121112233');
    expect(client.sendMessage.mock.calls[0]![0]).toBe('9902');
  });

  it('falls back to the proven chat when the user exists but has no verified link', async () => {
    const client = botClient();
    const s = sender.build(
      prisma({ user: { id: 'u-1' }, link: null }),
      registry(client),
      links('9902'),
      localeService(),
    );

    await inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'));

    expect(client.sendMessage.mock.calls[0]![0]).toBe('9902');
  });

  it('refuses rather than sending anywhere when no chat is known', async () => {
    const client = botClient();
    const s = sender.build(prisma(), registry(client), links(null), localeService());

    await expect(
      inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en')),
    ).rejects.toMatchObject({ message: sender.notLinked });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses when the platform is not configured, without touching the database', async () => {
    const p = prisma({ user: { id: 'u-1' }, link: { platformUserId: '5501' } });
    const s = sender.build(p, registry(null), links(null), localeService());

    await expect(inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'))).rejects.toMatchObject(
      { message: sender.notConfigured },
    );
    expect(p.user.findFirst).not.toHaveBeenCalled();
  });

  it('renders the code in the requested language', async () => {
    const client = botClient();
    const loc = localeService({
      otp: { title: { [OtpPurpose.login]: 'کد ورود شما' }, chatBody: '{{title}}: {{code}}' },
    });
    const s = sender.build(
      prisma({ user: { id: 'u-1' }, link: { platformUserId: '5501' } }),
      registry(client),
      links(null),
      loc,
    );

    await inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'fa'));

    expect(loc.getNamespace).toHaveBeenCalledWith('fa', 'notifications');
    expect(client.sendMessage.mock.calls[0]![1]).toBe('کد ورود شما: 123456');
  });

  it('lets a send failure surface rather than reporting a code that never arrived', async () => {
    // otp.store records the code as sent; swallowing this would leave the
    // user waiting for a message the platform rejected.
    const client = botClient();
    client.sendMessage.mockRejectedValue(new Error('chat not found'));
    const s = sender.build(
      prisma({ user: { id: 'u-1' }, link: { platformUserId: '5501' } }),
      registry(client),
      links(null),
      localeService(),
    );

    await expect(inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'))).rejects.toThrow(
      'chat not found',
    );
  });
});

describe('SMS OTP sender', () => {
  const env = (over: Record<string, string> = {}) => {
    const values: Record<string, string> = {
      SMS_API_URL: 'https://sms.example/api',
      SMS_API_KEY: 'user@pass',
      SMS_SENDER: '3000',
      ...over,
    };
    return {
      get: <T>(key: string, fallback?: T) => (values[key] as unknown as T) ?? fallback,
    } as unknown as ConfigService;
  };

  /** Replaces the private provider with a stub; the provider has its own spec. */
  function withProvider(
    sender: SmsOtpSender,
    sendSMS: ReturnType<typeof smsProvider>,
  ) {
    (sender as unknown as { provider: unknown }).provider = { sendSMS };
    return sender;
  }

  it('needs no linked account — a phone number is the whole address', () => {
    const s = new SmsOtpSender(env(), localeService());
    expect(s.requiresLinkedAccount).toBe(false);
    expect(s.channel).toBe(OtpChannel.sms);
  });

  it('is unconfigured without both a URL and a key', () => {
    expect(new SmsOtpSender(env(), localeService()).isConfigured()).toBe(true);
    expect(
      new SmsOtpSender(env({ SMS_API_KEY: '' }), localeService()).isConfigured(),
    ).toBe(false);
    expect(
      new SmsOtpSender(env({ SMS_API_URL: '' }), localeService()).isConfigured(),
    ).toBe(false);
  });

  it('refuses clearly instead of failing silently when unconfigured', async () => {
    const s = new SmsOtpSender(env({ SMS_API_KEY: '' }), localeService());

    await expect(inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('hands the provider a template with {{code}} still in it', async () => {
    // The provider does its own substitution via `vars`; interpolating here
    // as well would either double-substitute or put the code in the URL
    // twice over.
    const sendSMS = smsProvider({ ok: true, msg: 'sent' });
    const s = withProvider(new SmsOtpSender(env(), localeService()), sendSMS);

    await inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'));

    const [payload, sender] = sendSMS.mock.calls[0]!;
    expect(payload.msg).toContain('{{code}}');
    expect(payload.msg).not.toContain(CODE);
    expect(payload).toMatchObject({ to: '09121112233', vars: { code: CODE } });
    expect(sender).toBe('3000');
  });

  it('turns a provider rejection into a business error', async () => {
    const sendSMS = smsProvider({ ok: false, msg: 'InvalidNumber' });
    const s = withProvider(new SmsOtpSender(env(), localeService()), sendSMS);

    await expect(inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'))).rejects.toMatchObject({
      message: 'otp.smsSendFailed',
    });
  });

  it('resolves the title in the requested language', async () => {
    const sendSMS = smsProvider({ ok: true, msg: 'sent' });
    const loc = localeService({ otp: { title: { [OtpPurpose.login]: 'کد ورود' } } });
    const s = withProvider(new SmsOtpSender(env(), loc), sendSMS);

    await inTenant(() => s.send('09121112233', CODE, OtpPurpose.login, 'fa'));

    expect(loc.getNamespace).toHaveBeenCalledWith('fa', 'notifications');
    expect(sendSMS.mock.calls[0]![0].msg).toContain('کد ورود');
  });
});
