import { OtpPurpose } from '../otp/otp.interface';
import {
  BotLinkService,
  normalizeMessengerPhone,
} from './bot-link.service';
import { BotContact, PendingBotLink } from './bot-link.types';

/**
 * The contact check is the only thing standing between "a messenger says this
 * number is yours" and "this chat now receives that account's login codes", so
 * it is tested directly rather than through the controller.
 */
describe('normalizeMessengerPhone', () => {
  it.each([
    ['989123456789', '09123456789'],
    ['+98 912 345 6789', '09123456789'],
    ['00989123456789', '09123456789'],
    ['09123456789', '09123456789'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeMessengerPhone(raw)).toBe(expected);
  });

  it.each([['', null], ['12345', null], ['+15551234567', null]])(
    'rejects %s',
    (raw, expected) => {
      expect(normalizeMessengerPhone(raw as string)).toBe(expected);
    },
  );
});

describe('BotLinkService.handleUpdate — shared contact', () => {
  const PHONE = '09123456789';
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
    await service.handleUpdate(
      'telegram',
      contactUpdate({ phone_number: '989123456789', user_id: CHAT }, CHAT),
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create).toMatchObject({
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
