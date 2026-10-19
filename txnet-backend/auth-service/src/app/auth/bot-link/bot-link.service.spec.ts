import type { Mock } from 'vitest';
import { RedisTtl } from '../../redis/redis.keys';
import { OtpPurpose } from '../otp/otp.interface';
import { BotLinkService } from './bot-link.service';
import { normalizeMessengerPhone } from './messenger-phone';
import { BotContact, PendingBotLink } from './bot-link.types';
import { runWithTenant } from '../../tenant-context/tenant-context';

/**
 * A tenant in scope, the way `TenantContextMiddleware` opens one for a real
 * request: a `linked_bot_account` row names the tenant it belongs to, because
 * a chat id is unique within one and not across the platform (F-066-l).
 */
const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenant({ id: 'tenant-1', slug: 'reseller-a', via: 'domain' }, fn);

/**
 * The contact check is the only thing standing between "a messenger says this
 * number is yours" and "this chat now receives that account's login codes", so
 * it is tested directly rather than through the controller.
 */
describe('normalizeMessengerPhone', () => {
  // Every spelling a messenger has been seen to send, for numbers in three
  // different countries: the output is always the E.164 form the rest of
  // identity stores (ADR-0018), and no case here is Iran-specific by
  // construction.
  it.each([
    ['Telegram-style, no plus', '989123456789', '+989123456789'],
    ['international with spaces', '+98 912 345 6789', '+989123456789'],
    ['00 prefix', '00989123456789', '+989123456789'],
    ['national, as the owner types it', '09123456789', '+989123456789'],
    ['a German number with no plus', '4915112345678', '+4915112345678'],
    ['a US number', '+1 415 555 2671', '+14155552671'],
  ])('%s: %s', (_label, raw, expected) => {
    expect(normalizeMessengerPhone(raw)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['too short to be anyone', '12345'],
    ['not a number at all', 'not-a-phone'],
    ['a landline, which cannot receive a code', '+982112345678'],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeMessengerPhone(raw as string)).toBeNull();
  });
});

describe('BotLinkService.handleUpdate — shared contact', () => {
  // The pending link holds the canonical stored form; the messenger sends
  // whatever the account was registered with. Both must resolve to the same
  // number or the contact check refuses a genuine owner.
  const PHONE = normalizeMessengerPhone('09123456789') as string;
  const CHAT = '55501';

  let link: PendingBotLink;
  let upsert: Mock;
  let sent: { chatId: string; text: string }[];
  let service: BotLinkService;
  let issueOtp: Mock;
  let notify: Mock;

  beforeEach(() => {
    link = {
      token: 'tok',
      platform: 'telegram',
      phoneNumber: PHONE,
      purpose: OtpPurpose.login,
      lang: 'en',
      ip: '1.2.3.4',
      state: 'pending',
      otpSent: false,
      createdAt: Date.now(),
      channelId: 'e'.repeat(32),
      channelToken: 'f'.repeat(32),
    };
    upsert = vi.fn();
    // What the waiting screen hears, with the state a status read would see then (RT-1-h).
    notify = vi.fn(async () => link.state);
    issueOtp = vi.fn().mockResolvedValue(undefined);
    sent = [];

    const prisma = {
      linkedBotAccount: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert,
      },
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
    };
    const store = {
      byChat: vi.fn().mockResolvedValue(link),
      byToken: vi.fn().mockResolvedValue(link),
      update: vi.fn(async (l: PendingBotLink) => {
        link = l;
      }),
      releaseChat: vi.fn(),
      saveProvenChat: vi.fn(),
      provenChat: vi.fn().mockResolvedValue(null),
      clearProvenChat: vi.fn(),
    };
    const client = {
      sendMessage: vi.fn(async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }),
      clearKeyboard: vi.fn(async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }),
      requestContact: vi.fn(),
    };
    const bots = { client: () => client };
    const locale = { getKey: () => undefined };

    service = new BotLinkService(
      prisma as never,
      store as never,
      bots as never,
      locale as never,
      { issueOtp, verifyOtp: vi.fn() } as never,
      { mintHandles: vi.fn().mockResolvedValue({
          deliveryId: 'a'.repeat(32),
          channelId: 'c'.repeat(32),
          channelToken: 'd'.repeat(32),
        }), notify } as never,
    );
  });

  const contactUpdate = (contact: Partial<BotContact>, fromId: string) => ({
    message: {
      chat: { id: CHAT },
      from: { id: fromId },
      contact: contact as BotContact,
    },
  });

  it('links the chat and sends the code when the contact is the sender’s own', async () => {
    await inTenant(() =>
      service.handleUpdate(
        'telegram',
        contactUpdate({ phone_number: '989123456789', user_id: CHAT }, CHAT),
      ),
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create).toMatchObject({
      tenantId: 'tenant-1',
      platformUserId: CHAT,
      phoneNumber: PHONE,
    });
    expect(upsert.mock.calls[0][0].create.contactVerifiedAt).toBeInstanceOf(Date);
    expect(issueOtp).toHaveBeenCalledWith(
      PHONE,
      OtpPurpose.login,
      'telegram',
      '1.2.3.4',
      'en',
      expect.objectContaining({ deliveryId: 'a'.repeat(32) }),
    );
    expect(link.state).toBe('linked');
    expect(link.otpSent).toBe(true);
    // The screen re-reads on this, so the record already says `linked` when it lands.
    expect(notify).toHaveBeenCalledWith('e'.repeat(32), { state: 'linked', otpSent: true });
    await expect(notify.mock.results[0].value).resolves.toBe('linked');
  });

  // 2026-10-19: the waiting screen started a timer of its own guess here; it
  // now reads the server's seconds left, counted from when the bot sent.
  it('tells the waiting screen how long until another code, counted from the send', async () => {
    const sentAt = 1_000_000;
    link.state = 'linked';
    link.otpSent = true;
    link.codeSentAt = sentAt;
    vi.spyOn(Date, 'now').mockReturnValue(sentAt + 15_000);

    await expect(service.status('tok')).resolves.toMatchObject({ otpSent: true, resendIn: RedisTtl.otpCooldown - 15 });
    vi.mocked(Date.now).mockRestore();
  });

  it('refuses a forged contact card describing somebody else', async () => {
    // The number is right, but the card belongs to another account — exactly
    // what an unofficial client can fabricate.
    await service.handleUpdate(
      'telegram',
      contactUpdate({ phone_number: '989123456789', user_id: '99999' }, CHAT),
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(issueOtp).not.toHaveBeenCalled();
    expect(link.state).toBe('failed');
    expect(link.failureKey).toBe('otp.botLink.senderMismatch');
    expect(notify).toHaveBeenCalledWith('e'.repeat(32), { state: 'failed', otpSent: false, failureKey: 'otp.botLink.senderMismatch' });
  });

  it('refuses a contact card with no user_id at all', async () => {
    await service.handleUpdate(
      'telegram',
      contactUpdate({ phone_number: '989123456789' }, CHAT),
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(link.failureKey).toBe('otp.botLink.senderMismatch');
  });

  it('refuses the sender’s own contact when it is a different number', async () => {
    await service.handleUpdate(
      'telegram',
      contactUpdate({ phone_number: '989350000000', user_id: CHAT }, CHAT),
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(issueOtp).not.toHaveBeenCalled();
    expect(link.failureKey).toBe('otp.botLink.phoneMismatch');
  });
});

/**
 * The screen showing the deep link hears the outcome on `otp:` instead of
 * polling (RT-1-h): its handles ride the start answer, live as long as the
 * link, and a re-ask inside the TTL keeps them, so a second tab open on the
 * same link hears it too.
 */
describe('BotLinkService.startLink — the channel the waiting screen hears', () => {
  const open = vi.fn(async (_ttl: number, held?: { channelId: string; channelToken: string }) => held ?? { channelId: 'a'.repeat(32), channelToken: 'b'.repeat(32) });
  let saved: PendingBotLink | null;

  const build = () => {
    const store = {
      ttlSeconds: 900,
      byPhone: vi.fn(async () => saved),
      save: vi.fn(async (l: PendingBotLink) => {
        saved = { ...l };
      }),
    };
    const bots = {
      primaryFor: vi.fn().mockResolvedValue({ botUsername: 'txbot' }),
      hasToken: vi.fn().mockResolvedValue(true),
      deepLink: () => 'https://t.me/txbot?start=x',
    };
    return new BotLinkService({} as never, store as never, bots as never, {} as never, {} as never, { openChannel: open } as never);
  };
  const start = (service: BotLinkService) =>
    inTenant(() => service.startLink({ platform: 'telegram', phoneNumber: '989123456789', purpose: OtpPurpose.login, lang: 'en', ip: '1.2.3.4' }));

  beforeEach(() => {
    saved = null;
    open.mockClear();
  });

  it('answers with an otp: channel and its proof, held for the link\'s lifetime and kept on the link', async () => {
    const started = await start(build());
    expect(started).toMatchObject({ channel: `otp:${'a'.repeat(32)}`, channelToken: 'b'.repeat(32) });
    expect(open).toHaveBeenCalledWith(900, undefined);
    expect(saved).toMatchObject({ channelId: 'a'.repeat(32), channelToken: 'b'.repeat(32) });
  });

  it('a re-ask inside the TTL keeps the same channel, its proof held again', async () => {
    const service = build();
    await start(service);
    const again = await start(service);
    expect(again.channel).toBe(`otp:${'a'.repeat(32)}`);
    expect(open).toHaveBeenLastCalledWith(900, { channelId: 'a'.repeat(32), channelToken: 'b'.repeat(32) });
  });
});

/**
 * A chat we hold no pending link for still has to be answered in *some*
 * language. That answer used to be `'en'` for every hint that was not Persian,
 * which ignored both `DEFAULT_LANGUAGE` and the set of languages
 * locale-service actually serves — so a Persian-first deployment greeted a
 * German-speaking Telegram client in English (ADR-0016).
 */
describe('BotLinkService — language for a chat with no pending link', () => {
  const make = (served: string[] = ['fa', 'en']) => {
    const locale = {
      getKey: () => undefined,
      getDefaultLanguage: () => 'fa',
      getAvailableLanguages: () => served,
      resolveLanguage: (hint?: string) => {
        const base = hint?.toLowerCase().split('-')[0];
        return base && served.includes(base) ? base : 'fa';
      },
    };
    const store = { byToken: vi.fn().mockResolvedValue(null) };
    return new BotLinkService(
      {} as never,
      store as never,
      { client: () => undefined } as never,
      locale as never,
      { issueOtp: vi.fn(), verifyOtp: vi.fn() } as never,
      { mintHandles: vi.fn() } as never,
    );
  };

  it('answers a bare /start in the deployment language, not English', async () => {
    const outcome = await make().resolveStart('telegram', '55501', undefined, 'de');

    expect(outcome.lang).toBe('fa');
  });

  // The phone's language is a hint, and the hint answers last: a served
  // DEFAULT_LANGUAGE outranks it exactly as it does in bot-service.
  it("does not let the messenger's hint outrank the deployment language", async () => {
    const outcome = await make().resolveStart('telegram', '55501', undefined, 'en-US');

    expect(outcome.lang).toBe('fa');
  });

  it('falls through to the hint when the deployment language is not served', async () => {
    const outcome = await make(['en', 'ar']).resolveStart(
      'telegram',
      '55501',
      undefined,
      'en-US',
    );

    expect(outcome.lang).toBe('en');
  });

  it('answers an unknown start token in the deployment language too', async () => {
    const outcome = await make().resolveStart('telegram', '55501', 'gone', 'de');

    expect(outcome.messageKey).toBe('expired');
    expect(outcome.lang).toBe('fa');
  });
});
