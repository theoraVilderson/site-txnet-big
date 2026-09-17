import type { Mock } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotClientRegistry } from '@txnet-backend/messenger';
import { CredentialUnavailable } from '@txnet-backend/shared-core';
import { runWithTenant } from '../../../tenant-context/tenant-context';
import { LocaleService } from '../../../locale/locale.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BotLinkStore } from '../../bot-link/bot-link.store';
import { OtpChannel, OtpPurpose } from '../otp.interface';
import { BaleOtpSender } from './bale.sender';
import { SmsOtpSender } from './sms.sender';
import { TelegramOtpSender } from './telegram.sender';
import { UserNotifier } from '../../notify/user-notifier';

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
    getNamespace: vi.fn(() => namespace),
  } as unknown as LocaleService;
}

function prisma({
  user = null as { id: string } | null,
  link = null as { platformUserId: string } | null,
} = {}) {
  return {
    user: { findFirst: vi.fn(async () => user) },
    linkedBotAccount: { findFirst: vi.fn(async () => link) },
  };
}

/**
 * The registry as a sender uses it since F-066-i: both questions are per
 * tenant, and the bot is that tenant's `primary` one (C-05).
 */
function registry(client: { sendMessage: Mock } | null) {
  return {
    primaryClient: vi.fn(async () => client),
    canSend: vi.fn(async () => client !== null),
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
    provenChat: vi.fn(async () => provenChat),
  } as unknown as BotLinkStore;
}

function botClient() {
  return {
    sendMessage: vi.fn(async (_chatId: string, _text: string) => undefined),
  };
}

/** The payload shape SmsProviderService.sendSMS is called with. */
interface SmsPayload {
  msg: string;
  to: string;
  vars?: Record<string, string | number>;
}

function smsProvider(result: { ok: boolean; msg: string }) {
  return vi.fn(async (_payload: SmsPayload, _sender: string) => result);
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
    const values: Record<string, string> = { SMS_API_URL: 'https://sms.example/api', ...over };
    return {
      get: <T>(key: string, fallback?: T) => (values[key] as unknown as T) ?? fallback,
    } as unknown as ConfigService;
  };

  /**
   * Two vaults (F-018-a): the platform owner's line and reseller-1's own. The
   * line is two credentials per tenant, not two variables.
   */
  const LINES: Record<string, Record<string, string>> = {
    'owner-1': { sms_api_key: 'user@pass', sms_sender_line: '3000' },
    'reseller-1': { sms_api_key: 'reseller@pass', sms_sender_line: '5000' },
  };
  const vault = (lines: Record<string, Record<string, string>> = LINES) => ({
    available: true,
    use: vi.fn(async (ref: { tenantId: string; kind: string }) => {
      const value = lines[ref.tenantId]?.[ref.kind];
      if (value === undefined) throw new CredentialUnavailable(ref as never, 'missing');
      return value;
    }),
    summary: vi.fn(async (ref: { tenantId: string; kind: string }) =>
      lines[ref.tenantId]?.[ref.kind] !== undefined ? { status: 'active', expiresAt: null } : null,
    ),
  });

  const OWNER_PHONE = '+989120000001';
  const RESELLER_OWNER_PHONE = '+989120000002';
  const USER_PHONE = '+989121112233';

  /**
   * The platform owner `owner-1` and one reseller `reseller-1`, owned by user
   * `r-owner`. `ownLine` is the reseller's `tenant_sms_config` row: own
   * credentials and active, or absent.
   */
  const tenants = ({ platformOwner = true, ownLine = true } = {}) => {
    const rows = [
      { id: 'owner-1', tenantType: 'platform_owner', ownerUserId: 'p-owner' },
      { id: 'reseller-1', tenantType: 'reseller', ownerUserId: 'r-owner' },
    ].filter((t) => platformOwner || t.id !== 'owner-1');
    const users = [
      { id: 'p-owner', tenantId: 'owner-1', phoneNumber: OWNER_PHONE },
      { id: 'r-owner', tenantId: 'reseller-1', phoneNumber: RESELLER_OWNER_PHONE },
      { id: 'r-user', tenantId: 'reseller-1', phoneNumber: USER_PHONE },
    ];
    return {
      tenant: {
        findFirst: vi.fn(async ({ where }: { where: { id?: string; tenantType?: string } }) =>
          rows.find((t) => (where.id === undefined || t.id === where.id) && (where.tenantType === undefined || t.tenantType === where.tenantType)) ?? null,
        ),
      },
      user: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string; phoneNumber: string } }) =>
          users.find((u) => u.id === where.id && u.tenantId === where.tenantId && u.phoneNumber === where.phoneNumber) ?? null,
        ),
      },
      tenantSmsConfig: {
        findFirst: vi.fn(async ({ where }: { where: { tenantId: string; mode: string; isActive: boolean } }) =>
          ownLine && where.tenantId === 'reseller-1' && where.mode === 'own_credentials' && where.isActive
            ? { tenantId: 'reseller-1' }
            : null,
        ),
      },
    };
  };

  const inOwner = <T>(fn: () => Promise<T> | T) => runWithTenant({ id: 'owner-1', slug: 'platform', via: 'domain' }, fn);
  const inReseller = <T>(fn: () => Promise<T> | T) => runWithTenant({ id: 'reseller-1', slug: 'reseller-a', via: 'domain' }, fn);

  const build = (
    { config = env(), v = vault(), db = tenants(), loc = localeService() } = {} as {
      config?: ConfigService;
      v?: ReturnType<typeof vault>;
      db?: ReturnType<typeof tenants>;
      loc?: LocaleService;
    },
  ) => new SmsOtpSender(config, loc, v as never, db as never);

  /** Replaces the provider factory with a stub; the provider has its own spec. */
  function withProvider(
    sender: SmsOtpSender,
    sendSMS: ReturnType<typeof smsProvider>,
  ) {
    const factory = vi.fn(() => ({ sendSMS }));
    (sender as unknown as { providerFor: unknown }).providerFor = factory;
    return sender;
  }

  it('needs no linked account — a phone number is the whole address', () => {
    const s = build();
    expect(s.requiresLinkedAccount).toBe(false);
    expect(s.channel).toBe(OtpChannel.sms);
  });

  it("is unconfigured without a URL, the owner's key, or a vault", async () => {
    expect(await inOwner(() => build().isConfigured(USER_PHONE))).toBe(true);
    expect(await inOwner(() => build({ v: vault({ 'owner-1': { sms_sender_line: '3000' } }) }).isConfigured(USER_PHONE))).toBe(false);
    expect(await inOwner(() => build({ config: env({ SMS_API_URL: '' }) }).isConfigured(USER_PHONE))).toBe(false);
    expect(await inOwner(() => build({ v: { ...vault(), available: false } }).isConfigured(USER_PHONE))).toBe(false);
    // No tenant in scope is nobody's line: the platform's number is never the default.
    expect(await build().isConfigured(USER_PHONE)).toBe(false);
  });

  it('refuses clearly instead of failing silently when unconfigured', async () => {
    const s = build({ v: vault({}) });

    await expect(inOwner(() => s.send(USER_PHONE, CODE, OtpPurpose.login, 'en'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("sends the platform owner's users on the platform's vault key and sender line, audited as this sender (F-018-a)", async () => {
    const sendSMS = smsProvider({ ok: true, msg: 'sent' });
    const v = vault();
    const s = withProvider(build({ v }), sendSMS);

    await inOwner(() => s.send(USER_PHONE, CODE, OtpPurpose.login, 'en'));

    expect((s as unknown as { providerFor: Mock }).providerFor).toHaveBeenCalledWith('https://sms.example/api', 'user@pass');
    expect(v.use).toHaveBeenCalledWith({ tenantId: 'owner-1', kind: 'sms_api_key' }, { caller: 'auth:SmsOtpSender' });
    expect(sendSMS.mock.calls[0]![1]).toBe('3000');
  });

  describe("under a reseller, the line follows who the recipient is (F-018-b, D-41)", () => {
    it("sends the reseller's owner on the platform's line, whether or not the reseller has its own", async () => {
      for (const ownLine of [true, false]) {
        const sendSMS = smsProvider({ ok: true, msg: 'sent' });
        const s = withProvider(build({ db: tenants({ ownLine }) }), sendSMS);

        expect(await inReseller(() => s.isConfigured(RESELLER_OWNER_PHONE))).toBe(true);
        await inReseller(() => s.send(RESELLER_OWNER_PHONE, CODE, OtpPurpose.login, 'en'));

        expect((s as unknown as { providerFor: Mock }).providerFor).toHaveBeenCalledWith('https://sms.example/api', 'user@pass');
        expect(sendSMS.mock.calls[0]![1]).toBe('3000');
      }
    });

    it("sends its staff and users on the reseller's own line and number", async () => {
      const sendSMS = smsProvider({ ok: true, msg: 'sent' });
      const v = vault();
      const s = withProvider(build({ v }), sendSMS);

      await inReseller(() => s.send(USER_PHONE, CODE, OtpPurpose.login, 'en'));

      expect((s as unknown as { providerFor: Mock }).providerFor).toHaveBeenCalledWith('https://sms.example/api', 'reseller@pass');
      expect(sendSMS.mock.calls[0]![1]).toBe('5000');
      expect(v.use).not.toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'owner-1' }), expect.anything());
    });

    it("never falls back to the platform's line for anyone but the owner", async () => {
      // No `tenant_sms_config` row; or a row whose key is not in the vault.
      const cases = [
        { db: tenants({ ownLine: false }), lines: LINES },
        { db: tenants(), lines: { 'owner-1': LINES['owner-1']! } },
      ];
      for (const { db, lines } of cases) {
        const sendSMS = smsProvider({ ok: true, msg: 'sent' });
        const v = vault(lines);
        const s = withProvider(build({ db, v }), sendSMS);

        expect(await inReseller(() => s.isConfigured(USER_PHONE))).toBe(false);
        expect(await inReseller(() => s.isConfigured())).toBe(false);
        await expect(inReseller(() => s.send(USER_PHONE, CODE, OtpPurpose.login, 'en'))).rejects.toMatchObject({
          message: 'otp.smsNotConfigured',
        });
        expect(sendSMS).not.toHaveBeenCalled();
        expect(v.use).not.toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'owner-1' }), expect.anything());
      }
    });

    it('offers the anonymous list SMS only when the reseller has its own line', async () => {
      expect(await inReseller(() => build().isConfigured())).toBe(true);
      expect(await inReseller(() => build({ db: tenants({ ownLine: false }) }).isConfigured())).toBe(false);
    });
  });

  it('hands the provider a template with {{code}} still in it', async () => {
    // The provider does its own substitution via `vars`; interpolating here
    // as well would either double-substitute or put the code in the URL
    // twice over.
    const sendSMS = smsProvider({ ok: true, msg: 'sent' });
    const s = withProvider(build(), sendSMS);

    await inOwner(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'));

    const [payload, sender] = sendSMS.mock.calls[0]!;
    expect(payload.msg).toContain('{{code}}');
    expect(payload.msg).not.toContain(CODE);
    expect(payload).toMatchObject({ to: '09121112233', vars: { code: CODE } });
    expect(sender).toBe('3000');
  });

  it('turns a provider rejection into a business error', async () => {
    const sendSMS = smsProvider({ ok: false, msg: 'InvalidNumber' });
    const s = withProvider(build(), sendSMS);

    await expect(inOwner(() => s.send('09121112233', CODE, OtpPurpose.login, 'en'))).rejects.toMatchObject({
      message: 'otp.smsSendFailed',
    });
  });

  it('resolves the title in the requested language', async () => {
    const sendSMS = smsProvider({ ok: true, msg: 'sent' });
    const loc = localeService({ otp: { title: { [OtpPurpose.login]: 'کد ورود' } } });
    const s = withProvider(build({ loc }), sendSMS);

    await inOwner(() => s.send('09121112233', CODE, OtpPurpose.login, 'fa'));

    expect(loc.getNamespace).toHaveBeenCalledWith('fa', 'notifications');
    expect(sendSMS.mock.calls[0]![0].msg).toContain('کد ورود');
  });
});

/**
 * Messaging a user on their linked bot (F-067-l, ADR-0045 decision 2). The OTP
 * senders' neighbour: the same bot registry and the same verified links, for a
 * named template instead of a code.
 */
describe('UserNotifier', () => {
  function notifierPrisma({
    user = { languagePreference: 'en' } as { languagePreference: string } | null,
    links: linked = [] as Array<{ platform: string; platformUserId: string }>,
  } = {}) {
    return {
      user: { findFirst: vi.fn(async () => user) },
      linkedBotAccount: { findMany: vi.fn(async () => linked) },
    };
  }
  const ns = { payment: { credited: 'Credited {{amount}} (ref {{reference}})' } };

  it('sends the template in the user’s language to every verified linked chat with a usable bot', async () => {
    const client = botClient();
    const db = notifierPrisma({ links: [{ platform: 'telegram', platformUserId: '5501' }] });
    const locale = localeService(ns);
    const notifier = new UserNotifier(db as unknown as PrismaService, registry(client), locale);

    const out = await inTenant(() =>
      notifier.notify({ userId: 'user-1', template: 'paymentCredited', params: { amount: '19.80', reference: '900' } }),
    );

    expect(out).toEqual({ sent: ['telegram'] });
    expect(locale.getNamespace).toHaveBeenCalledWith('en', 'notifications');
    expect(client.sendMessage).toHaveBeenCalledWith('5501', 'Credited 19.80 (ref 900)');
    expect(db.linkedBotAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', contactVerifiedAt: { not: null } } }),
    );
  });

  it('sends nothing, and is not an error, for a user with no linked chat or no bot', async () => {
    const none = new UserNotifier(notifierPrisma() as unknown as PrismaService, registry(botClient()), localeService(ns));
    expect(await inTenant(() => none.notify({ userId: 'user-1', template: 'paymentCredited', params: {} }))).toEqual({ sent: [] });

    const noBot = new UserNotifier(
      notifierPrisma({ links: [{ platform: 'bale', platformUserId: '7' }] }) as unknown as PrismaService,
      registry(null),
      localeService(ns),
    );
    expect(await inTenant(() => noBot.notify({ userId: 'user-1', template: 'paymentCredited', params: {} }))).toEqual({ sent: [] });
  });

  it('throws when every send failed, so the caller retries the event', async () => {
    const client = { sendMessage: vi.fn(async () => Promise.reject(new Error('telegram down'))) };
    const notifier = new UserNotifier(
      notifierPrisma({ links: [{ platform: 'telegram', platformUserId: '5501' }] }) as unknown as PrismaService,
      registry(client),
      localeService(ns),
    );
    await expect(
      inTenant(() => notifier.notify({ userId: 'user-1', template: 'paymentCredited', params: { amount: '1', reference: '' } })),
    ).rejects.toThrow(/telegram down/);
  });

  it('falls back to English text when the namespace has no template', async () => {
    const client = botClient();
    const notifier = new UserNotifier(
      notifierPrisma({ links: [{ platform: 'telegram', platformUserId: '5501' }] }) as unknown as PrismaService,
      registry(client),
      localeService(undefined),
    );
    await inTenant(() => notifier.notify({ userId: 'user-1', template: 'paymentCredited', params: { amount: '19.80', reference: '900' } }));
    expect(client.sendMessage.mock.calls[0][1]).toContain('19.80');
  });
});
