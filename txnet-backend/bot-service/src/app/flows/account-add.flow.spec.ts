import { aBotIntegration } from '@txnet-backend/messenger';
import { ConfigService } from '@nestjs/config';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotSessionStore } from '../session/bot-session.store';
import { AccountSwitcher } from '../session/account-switcher';
import { ChatAccess } from '../session/chat-access';
import { AccountAddFlow } from './account-add.flow';
import { OtpStep } from './otp.step';
import { PhoneNumbers } from './phone-number';

const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });

const at = (step: string, data: Record<string, string> = {}): NavState => ({
  flow: 'accountAdd',
  step,
  data,
});

function harness(over: { session?: unknown; api?: Partial<AuthApiClient> } = {}) {
  const api = {
    refresh: jest
      .fn()
      .mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
    otpChannels: jest
      .fn()
      .mockResolvedValue(ok({ channels: [{ channel: 'sms', requiresLink: false }] })),
    requestAddOtp: jest.fn().mockResolvedValue(ok({ accepted: true })),
    addAccountByOtp: jest
      .fn()
      .mockResolvedValue(ok({ groupId: 'g-1', added: true, userId: 'u-new' })),
    addAccountByPassword: jest
      .fn()
      .mockResolvedValue(ok({ groupId: 'g-1', added: true, userId: 'u-new' })),
    switchAccount: jest.fn().mockResolvedValue(
      ok({
        userId: 'u-new',
        fullName: 'Sara',
        accessToken: 'access-2',
        refreshToken: 'r-new',
        expiresIn: 900,
      }),
    ),
    ...over.api,
  } as unknown as jest.Mocked<AuthApiClient>;
  const sessions = {
    get: jest.fn().mockResolvedValue(
      'session' in over ? over.session : { refreshToken: 'r-1', signedInAt: 0 },
    ),
    save: jest.fn(),
    clear: jest.fn(),
  } as unknown as BotSessionStore;
  return {
    api,
    sessions,
    flow: new AccountAddFlow(
      api,
      new ChatAccess(api, sessions),
      new OtpStep(api),
      // The same switch+persist pair `AccountsFlow` performs. It lives in one
      // place because a second copy of "store the token auth-api just minted"
      // is a second place to forget it, and forgetting it signs the chat out
      // of both accounts at once.
      new AccountSwitcher(api, sessions),
      new PhoneNumbers(new ConfigService({ DEFAULT_LANGUAGE: 'fa' })),
    ),
  };
}

describe('AccountAddFlow', () => {
  it('opens on the two proofs F-0205 accepts, and asks for neither yet', async () => {
    const { flow } = harness();

    const result = await flow.start(ctx);

    expect(result.view.id).toBe('accountAdd.method');
    const ids = (result.view.actions ?? []).flat().map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['add:otp', 'add:password']));
    expect(result.nextState?.flow).toBe('accountAdd');
  });

  it('refuses to start at all when the chat has no live session', async () => {
    // The caller's own session is half the proof (audit invariant #4), so a
    // signed-out chat is told now rather than after typing a phone and a code.
    const { flow } = harness({ session: null });

    const result = await flow.start(ctx);

    expect(result.view.id).toBe('accountAdd.signedOut');
    expect(result.nextState).toBeNull();
  });

  it('sends the code to the number that was typed, on the chosen channel', async () => {
    const { flow, api } = harness();

    const phone = await flow.handle(
      { ...ctx, text: '09120000000' },
      at('accountAdd.phone', { proof: 'otp' }),
      null,
    );
    // Typed nationally, carried as E.164 from the step that read it.
    expect(phone.nextState?.data.phoneNumber).toBe('+989120000000');
    expect(phone.nextState?.step).toBe('accountAdd.channel');

    const sent = await flow.handle(
      ctx,
      at('accountAdd.channel', { proof: 'otp', phoneNumber: '+989120000000' }),
      'channel:sms',
    );

    expect(api.requestAddOtp).toHaveBeenCalledWith(
      { phoneNumber: '+989120000000', channel: 'sms' },
      expect.objectContaining({ accessToken: 'access-1' }),
    );
    expect(sent.nextState?.step).toBe('accountAdd.code');
  });

  it('never links this chat when the joining account has no messenger link', async () => {
    // The code is going to somebody else's number: linking here would either
    // move this chat's own link or walk the user through a contact card that
    // cannot match (identity invariant #12). The deep link is the honest one.
    const { flow, api } = harness({
      api: {
        requestAddOtp: jest.fn().mockResolvedValue(
          ok({
            accepted: true,
            linkRequired: true,
            platform: 'telegram',
            linkToken: 'lt-1',
            deepLink: 'https://t.me/bot?start=lt-1',
          }),
        ),
        linkResolve: jest.fn(),
      } as Partial<AuthApiClient>,
    });

    const result = await flow.handle(
      ctx,
      at('accountAdd.channel', { proof: 'otp', phoneNumber: '+989120000000' }),
      'channel:telegram',
    );

    expect(api.linkResolve).not.toHaveBeenCalled();
    expect(result.view.id).toBe('link.other');
    expect(result.nextState?.step).toBe('accountAdd.link');
  });

  it('adds the account on a good code and lands the chat ON it', async () => {
    const { flow, api, sessions } = harness();

    const result = await flow.handle(
      { ...ctx, text: '123456' },
      at('accountAdd.code', { proof: 'otp', phoneNumber: '+989120000000' }),
      null,
    );

    expect(api.addAccountByOtp).toHaveBeenCalledWith(
      { phoneNumber: '+989120000000', otpCode: '123456' },
      expect.objectContaining({ accessToken: 'access-1' }),
    );
    // The add answers with the id of the account that joined, and that id is
    // what the switch is asked for. Adding an account the user cannot then be
    // on is the defect this item exists to remove.
    expect(api.switchAccount).toHaveBeenCalledWith(
      { userId: 'u-new' },
      expect.objectContaining({ chatId: '5501', platform: 'telegram' }),
    );
    expect(result.view.id).toBe('accountAdd.switched');
    expect(result.nextState).toBeNull();
  });

  it('stores the NEW account refresh token, replacing the old one', async () => {
    // auth-api revokes the outgoing session in the same transaction that mints
    // the incoming one, so the token that comes back is the only copy in
    // existence: a chat that dropped it is signed out of both accounts.
    const { flow, sessions } = harness();

    await flow.handle(
      { ...ctx, text: '123456' },
      at('accountAdd.code', { proof: 'otp', phoneNumber: '+989120000000' }),
      null,
    );

    expect(sessions.save).toHaveBeenLastCalledWith(ctx.integration, '5501', 'r-new');
  });

  it('falls back to the plain added message when the switch is refused', async () => {
    // The account IS in the group — the add succeeded and its proof is spent.
    // Only the convenience was lost, so reporting a failure here would be a
    // lie about the state of the group.
    const { flow, sessions } = harness({
      api: {
        switchAccount: jest
          .fn()
          .mockResolvedValue({ ok: false, msg: 'accountSwitch.notAMember' }),
      } as Partial<AuthApiClient>,
    });

    const result = await flow.handle(
      { ...ctx, text: '123456' },
      at('accountAdd.code', { proof: 'otp', phoneNumber: '+989120000000' }),
      null,
    );

    expect(result.view.id).toBe('accountAdd.done');
    expect(result.nextState).toBeNull();
    // The chat is still the account it was: nothing overwrote its session
    // beyond the ordinary refresh rotation.
    expect(sessions.save).toHaveBeenCalledTimes(1);
    expect(sessions.save).toHaveBeenCalledWith(ctx.integration, '5501', 'r-next');
  });

  it('keeps the user on the code step when auth-api refuses the proof', async () => {
    const { flow } = harness({
      api: {
        addAccountByOtp: jest
          .fn()
          .mockResolvedValue({ ok: false, msg: 'accountSwitch.proofFailed' }),
      } as Partial<AuthApiClient>,
    });
    const state = at('accountAdd.code', { proof: 'otp', phoneNumber: '+989120000000' });

    const result = await flow.handle({ ...ctx, text: '000000' }, state, null);

    expect(result.view.body.raw).toBe('accountSwitch.proofFailed');
    expect(result.nextState?.step).toBe('accountAdd.code');
    // And a way to ask for a new code, so a refusal is not a dead end.
    expect((result.view.actions ?? []).flat().map((a) => a.id)).toContain('otp:resend');
  });

  it('joins by the account own password, and takes the password back out of the chat', async () => {
    const { flow, api } = harness();

    const result = await flow.handle(
      { ...ctx, text: 's3cret' },
      at('accountAdd.password', { proof: 'password', identifier: 'sara' }),
      null,
    );

    expect(api.addAccountByPassword).toHaveBeenCalledWith(
      { identifier: 'sara', password: 's3cret' },
      // The platform reaches the client, not only the chat id. Since
      // ADR-0015 the group being joined is *this chat's*, and auth-api cannot
      // name the chat without both halves — so an add with no platform header
      // is refused outright rather than landing in the wrong set.
      expect.objectContaining({
        accessToken: 'access-1',
        chatId: '5501',
        platform: 'telegram',
      }),
    );
    expect(result.view.id).toBe('accountAdd.switched');
    expect(result.deleteIncoming).toBe(true);
  });

  it('deletes the password message even when the switch after it fails', async () => {
    // The password is in the chat regardless of what the switch answers, so
    // it is taken back out on every path — including the one that falls back.
    const { flow } = harness({
      api: {
        switchAccount: jest
          .fn()
          .mockResolvedValue({ ok: false, msg: 'accountSwitch.notAMember' }),
      } as Partial<AuthApiClient>,
    });

    const result = await flow.handle(
      { ...ctx, text: 's3cret' },
      at('accountAdd.password', { proof: 'password', identifier: 'sara' }),
      null,
    );

    expect(result.deleteIncoming).toBe(true);
    expect(result.view.id).toBe('accountAdd.done');
  });

  it('deletes the password message even when the proof is rejected', async () => {
    const { flow } = harness({
      api: {
        addAccountByPassword: jest
          .fn()
          .mockResolvedValue({ ok: false, msg: 'accountSwitch.proofFailed' }),
      } as Partial<AuthApiClient>,
    });
    const state = at('accountAdd.password', { proof: 'password', identifier: 'sara' });

    const result = await flow.handle({ ...ctx, text: 'wrong' }, state, null);

    expect(result.deleteIncoming).toBe(true);
    expect(result.nextState).toBe(state);
  });
});
