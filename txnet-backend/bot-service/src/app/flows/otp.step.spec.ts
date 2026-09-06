import { AuthApiClient } from '../auth-api/auth-api.client';
import { OtpChannelDescriptor } from '../auth-api/auth-api.types';
import { ChatContext, NavState } from '../conversation/nav.types';
import { orderForPlatform, OtpStep } from './otp.step';

const CHANNELS: OtpChannelDescriptor[] = [
  { channel: 'sms', requiresLink: false },
  { channel: 'telegram', requiresLink: true },
  { channel: 'bale', requiresLink: true },
];

function ctxFor(platform: 'telegram' | 'bale'): ChatContext {
  return { platform, chatId: '5501', senderId: 42, lang: 'fa' };
}

const state: NavState = { flow: 'login', step: 'login.channel', data: { phoneNumber: '09121112233' } };

describe('OtpStep', () => {
  let api: jest.Mocked<Partial<AuthApiClient>>;
  let step: OtpStep;

  beforeEach(() => {
    api = {
      otpChannels: jest.fn().mockResolvedValue({ ok: true, msg: 'ok', data: { channels: CHANNELS } }),
      linkResolve: jest.fn(),
      linkContact: jest.fn(),
      linkStatus: jest.fn(),
    };
    step = new OtpStep(api as unknown as AuthApiClient);
  });

  describe('which channels are offered, and in what order', () => {
    it('offers the chat you are in first, then SMS, then the other messenger', () => {
      // This is the whole request: in Telegram you can also choose SMS or Bale,
      // and in Bale you can choose SMS or Telegram.
      expect(orderForPlatform('telegram', CHANNELS).map((c) => c.channel)).toEqual([
        'telegram',
        'sms',
        'bale',
      ]);
      expect(orderForPlatform('bale', CHANNELS).map((c) => c.channel)).toEqual([
        'bale',
        'sms',
        'telegram',
      ]);
    });

    it('names every channel after itself, this platform first', async () => {
      const view = await step.channelView(ctxFor('bale'));

      const offered = view!.actions!.flat().map((a) => [a.id, a.label.key]);

      // Never "here, in this chat": the code goes to whichever chat owns the
      // number that was typed, which is only this one by coincidence
      // (ADR-0012). Order still puts this platform first — a messenger the
      // user already has open beats waiting for an SMS.
      expect(offered.slice(0, 3)).toEqual([
        ['channel:bale', 'bot.channel.bale'],
        ['channel:sms', 'bot.channel.sms'],
        ['channel:telegram', 'bot.channel.telegram'],
      ]);
      // Every question in every flow can be walked away from.
      expect(offered.at(-1)).toEqual(['nav:cancel', 'bot.action.cancel']);
    });

    it('says so when the environment has no channel at all', async () => {
      api.otpChannels = jest
        .fn()
        .mockResolvedValue({ ok: true, msg: 'ok', data: { channels: [] } });

      expect(await step.channelView(ctxFor('telegram'))).toBeNull();
    });
  });

  describe('requesting the code', () => {
    it('asks for the code when auth-api simply sent one', async () => {
      const send = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: { accepted: true },
      });

      const result = await step.request(ctxFor('telegram'), state, 'sms', 'login.code', send);

      expect(send).toHaveBeenCalledWith('sms');
      expect(result.view.id).toBe('otp.code');
      expect(result.nextState?.step).toBe('login.code');
    });

    it('links in place when the chosen messenger is this very chat', async () => {
      // No deep-link round trip: the user is already talking to the bot that
      // would deliver the code, so the link conversation happens right here.
      const send = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: {
          accepted: true,
          linkRequired: true,
          platform: 'telegram',
          linkToken: 'tok-abc',
          deepLink: 'https://t.me/bot?start=tok-abc',
        },
      });
      api.linkResolve = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: { state: 'pending', needsContact: true, otpSent: false, messageKey: 'askContact', lang: 'fa' },
      });

      const result = await step.request(ctxFor('telegram'), state, 'telegram', 'login.code', send);

      expect(api.linkResolve).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'telegram', chatId: '5501', startToken: 'tok-abc' }),
        expect.anything(),
      );
      expect(result.view.id).toBe('link.contact');
      expect(result.view.actions?.flat()[0].kind).toBe('contact');
      expect(result.nextState?.step).toBe('login.contact');
    });

    it('hands over the other messenger’s deep link and waits to be told', async () => {
      const send = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: {
          accepted: true,
          linkRequired: true,
          platform: 'bale',
          linkToken: 'tok-xyz',
          deepLink: 'https://ble.ir/bot?start=tok-xyz',
        },
      });

      const result = await step.request(ctxFor('telegram'), state, 'bale', 'login.code', send);

      expect(api.linkResolve).not.toHaveBeenCalled();
      expect(result.view.id).toBe('link.other');
      const [open, check] = result.view.actions!.flat();
      expect(open).toMatchObject({ kind: 'url', url: 'https://ble.ir/bot?start=tok-xyz' });
      expect(check.id).toBe('link:check');
      expect(result.nextState?.step).toBe('login.link');
      expect(result.nextState?.linkPlatform).toBe('bale');
    });

    it('shows auth-api’s own rejection rather than inventing one', async () => {
      const send = jest.fn().mockResolvedValue({ ok: false, msg: 'کد را کمی بعد بخواهید' });

      const result = await step.request(ctxFor('telegram'), state, 'sms', 'login.code', send);

      expect(result.view.body.raw).toBe('کد را کمی بعد بخواهید');
      expect(result.nextState).toBe(state);
    });
  });

  describe('the cross-messenger wait', () => {
    const waiting: NavState = { ...state, step: 'login.link', linkToken: 'tok-xyz', linkPlatform: 'bale' };

    it('moves on to the code once the other messenger reports linked', async () => {
      api.linkStatus = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: { state: 'linked', otpSent: true },
      });

      const result = await step.checkLink(ctxFor('telegram'), waiting);

      expect(result.view.id).toBe('otp.code');
      expect(result.nextState?.step).toBe('login.code');
    });

    it('keeps waiting, and shows why when the link actually failed', async () => {
      api.linkStatus = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: { state: 'failed', otpSent: false, failureKey: 'otp.botLink.phoneMismatch' },
      });

      const result = await step.checkLink(ctxFor('telegram'), waiting);

      expect(result.view.body.key).toBe('otp.botLink.phoneMismatch');
      expect(result.nextState).toBe(waiting);
    });
  });

  describe('the contact shared while linking in place', () => {
    it('asks for the code once identity accepted the contact', async () => {
      api.linkContact = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: { state: 'linked', needsContact: false, otpSent: true, messageKey: 'linked', lang: 'fa' },
      });
      const ctx = { ...ctxFor('telegram'), contact: { phone_number: '989121112233', user_id: 42 } };

      const result = await step.submitContact(ctx, { ...state, step: 'login.contact' });

      expect(result.view.id).toBe('otp.code');
    });

    it('stops the flow with identity’s own reason when the contact is refused', async () => {
      // The proof itself (contact.user_id === sender) is checked in identity,
      // invariant #12 — this only renders the answer.
      api.linkContact = jest.fn().mockResolvedValue({
        ok: true,
        msg: 'ok',
        data: {
          state: 'failed',
          needsContact: false,
          otpSent: false,
          messageKey: 'senderMismatch',
          failureKey: 'otp.botLink.senderMismatch',
          lang: 'fa',
        },
      });
      const ctx = { ...ctxFor('telegram'), contact: { phone_number: '989121112233', user_id: 99 } };

      const result = await step.submitContact(ctx, { ...state, step: 'login.contact' });

      expect(result.view.body.key).toBe('otp.botLink.senderMismatch');
      expect(result.nextState).toBeNull();
    });
  });
});
