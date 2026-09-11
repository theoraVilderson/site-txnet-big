import { OtpPurpose } from '../otp/otp.interface';
import {
  BotLinkService,
  normalizeMessengerPhone,
} from './bot-link.service';
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
  let upsert: jest.Mock;
  let sent: { chatId: string; text: string }[];
  let service: BotLinkService;
  let issueOtp: jest.Mock;

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
    };
    upsert = jest.fn();
    issueOtp = jest.fn().mockResolvedValue(undefined);
    sent = [];

    const prisma = {
      linkedBotAccount: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert,
      },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }) },
    };
    const store = {
      byChat: jest.fn().mockResolvedValue(link),
      byToken: jest.fn().mockResolvedValue(link),
      update: jest.fn(async (l: PendingBotLink) => {
        link = l;
      }),
      releaseChat: jest.fn(),
      saveProvenChat: jest.fn(),
      provenChat: jest.fn().mockResolvedValue(null),
      clearProvenChat: jest.fn(),
    };
    const client = {
      sendMessage: jest.fn(async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }),
      clearKeyboard: jest.fn(async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }),
      requestContact: jest.fn(),
    };
    const bots = { client: () => client };
    const locale = { getKey: () => undefined };

    service = new BotLinkService(
      prisma as never,
      store as never,
      bots as never,
      locale as never,
      { issueOtp, verifyOtp: jest.fn() } as never,
      { mintHandles: jest.fn().mockResolvedValue({
          deliveryId: 'a'.repeat(32),
          channelId: 'c'.repeat(32),
          channelToken: 'd'.repeat(32),
        }) } as never,
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
    const store = { byToken: jest.fn().mockResolvedValue(null) };
    return new BotLinkService(
      {} as never,
      store as never,
      { client: () => undefined } as never,
      locale as never,
      { issueOtp: jest.fn(), verifyOtp: jest.fn() } as never,
      { mintHandles: jest.fn() } as never,
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
