import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotSessionStore } from '../session/bot-session.store';
import { ForgotFlow } from './forgot.flow';
import { LoginFlow } from './login.flow';
import { OtpStep } from './otp.step';
import { RegisterFlow } from './register.flow';

const ctx: ChatContext = { platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });

function harness() {
  const api = {
    otpChannels: jest.fn().mockResolvedValue(
      ok({ channels: [{ channel: 'sms', requiresLink: false }] }),
    ),
    requestLoginOtp: jest.fn().mockResolvedValue(ok({ accepted: true })),
    verifyLoginOtp: jest.fn().mockResolvedValue(ok({ accessToken: 'a', expiresIn: 900, refreshToken: 'r-1' })),
    loginWithPassword: jest.fn().mockResolvedValue(ok({ accessToken: 'a', expiresIn: 900, refreshToken: 'r-2' })),
    botSession: jest.fn().mockResolvedValue(ok({ state: 'needsContact' })),
    register: jest.fn().mockResolvedValue(ok({ accepted: true, requiresPhoneVerification: true })),
    verifyPhone: jest.fn().mockResolvedValue(ok({ accessToken: 'a', expiresIn: 900, refreshToken: 'r-3' })),
    forgotPassword: jest.fn().mockResolvedValue(ok({ accepted: true })),
    verifyForgotOtp: jest.fn().mockResolvedValue(ok({ resetToken: 'reset-1' })),
    resetPassword: jest.fn().mockResolvedValue(ok({ success: true, accessToken: 'a', expiresIn: 900, refreshToken: 'r-4' })),
  } as unknown as jest.Mocked<AuthApiClient>;
  const sessions = { save: jest.fn(), clear: jest.fn(), get: jest.fn() } as unknown as BotSessionStore;
  const otp = new OtpStep(api);
  return {
    api,
    sessions,
    login: new LoginFlow(api, otp, sessions),
    register: new RegisterFlow(api, otp, sessions),
    forgot: new ForgotFlow(api, otp, sessions),
  };
}

describe('LoginFlow', () => {
  it('walks phone -> channel -> code and stores the session it was given', async () => {
    const { login, api, sessions } = harness();

    // The fast path is not what this test is about: it walks the phone/code
    // conversation a chat with no usable link still gets.
    let state = (await login.start()).nextState as NavState;
    const method = await login.handle(ctx, state, 'login:otp');
    expect(method.view.id).toBe('login.phone');

    // A shared contact and a typed number are the same answer to the flow.
    const phone = await login.handle(
      { ...ctx, contact: { phone_number: '09121112233', user_id: 42 } },
      method.nextState as NavState,
      null,
    );
    expect(phone.view.id).toBe('otp.channels');

    const requested = await login.handle(ctx, phone.nextState as NavState, 'channel:sms');
    expect(api.requestLoginOtp).toHaveBeenCalledWith(
      { phoneNumber: '09121112233', channel: 'sms' },
      expect.anything(),
    );

    const verified = await login.handle(
      { ...ctx, text: '123456' },
      requested.nextState as NavState,
      null,
    );
    expect(api.verifyLoginOtp).toHaveBeenCalledWith(
      { phoneNumber: '09121112233', otpCode: '123456' },
      expect.anything(),
    );
    expect(sessions.save).toHaveBeenCalledWith('telegram', '5501', 'r-1');
    // A success says so; the menu underneath it is the router's job
    // (`ConversationRouter.decorate`), so a flow never ends on a bare menu the
    // user has to infer a result from.
    expect(verified.view.id).toBe('login.done');
    expect(verified.view.body.key).toBe('bot.common.signedIn');
    expect(verified.nextState).toBeNull();
  });

  it('keeps the chat on the code step, with auth-api’s reason, on a wrong code', async () => {
    const { login, api, sessions } = harness();
    (api.verifyLoginOtp as jest.Mock).mockResolvedValue({ ok: false, msg: 'کد نادرست است' });
    const state: NavState = { flow: 'login', step: 'login.code', data: { phoneNumber: '09121112233' } };

    const result = await login.handle({ ...ctx, text: '000000' }, state, null);

    expect(result.view.body.raw).toBe('کد نادرست است');
    expect(result.nextState).toBe(state);
    expect(sessions.save).not.toHaveBeenCalled();
  });

  it('deletes the password message whether the password was right or wrong', async () => {
    const { login, api } = harness();
    const state: NavState = { flow: 'login', step: 'login.password', data: { identifier: 'sara' } };

    const good = await login.handle({ ...ctx, text: 'Str0ng!pass' }, state, null);
    expect(good.deleteIncoming).toBe(true);

    (api.loginWithPassword as jest.Mock).mockResolvedValue({ ok: false, msg: 'نام کاربری یا رمز اشتباه است' });
    const bad = await login.handle({ ...ctx, text: 'nope' }, state, null);
    expect(bad.deleteIncoming).toBe(true);
    expect(bad.view.body.raw).toBe('نام کاربری یا رمز اشتباه است');
  });

  it('continues into the code step when the account answers requiresOtp', async () => {
    const { login, api } = harness();
    (api.loginWithPassword as jest.Mock).mockResolvedValue(ok({ requiresOtp: true, otpToken: 't' }));
    const state: NavState = { flow: 'login', step: 'login.password', data: { identifier: 'sara' } };

    const result = await login.handle({ ...ctx, text: 'Str0ng!pass' }, state, null);

    expect(result.view.id).toBe('otp.channels');
    expect(result.nextState?.step).toBe('login.channel');
  });
});

describe('RegisterFlow', () => {
  it('asks the channel before the password, so the password is never stored', async () => {
    const { register, api, sessions } = harness();

    let step = register.start();
    expect(step.view.id).toBe('register.phone');

    step = await register.handle(
      { ...ctx, contact: { phone_number: '09121112233', user_id: 42 } },
      step.nextState as NavState,
      null,
    );
    expect(step.view.id).toBe('register.name');

    step = await register.handle({ ...ctx, text: 'Sara Ahmadi' }, step.nextState as NavState, null);
    expect(step.view.id).toBe('register.username');

    step = await register.handle({ ...ctx, text: 'sara' }, step.nextState as NavState, null);
    // The channel comes first: registration is one call and it carries the
    // password, so the password can be spent in the request it arrives in.
    expect(step.view.id).toBe('otp.channels');

    step = await register.handle(ctx, step.nextState as NavState, 'channel:sms');
    expect(step.view.id).toBe('register.password');
    expect(step.nextState?.data).not.toHaveProperty('password');

    step = await register.handle({ ...ctx, text: 'Str0ng!pass' }, step.nextState as NavState, null);
    expect(api.register).toHaveBeenCalledWith(
      {
        fullName: 'Sara Ahmadi',
        username: 'sara',
        phoneNumber: '09121112233',
        password: 'Str0ng!pass',
        channel: 'sms',
      },
      expect.anything(),
    );
    expect(step.deleteIncoming).toBe(true);
    expect(step.nextState?.data).not.toHaveProperty('password');

    const done = await register.handle({ ...ctx, text: '123456' }, step.nextState as NavState, null);
    expect(api.verifyPhone).toHaveBeenCalled();
    expect(sessions.save).toHaveBeenCalledWith('telegram', '5501', 'r-3');
    expect(done.view.id).toBe('register.done');
    expect(done.view.body.key).toBe('bot.register.done');
    expect(done.nextState).toBeNull();
  });

  it('shows auth-api’s duplicate-account answer instead of deciding itself', async () => {
    const { register, api } = harness();
    (api.register as jest.Mock).mockResolvedValue({ ok: false, msg: 'این شماره قبلاً ثبت شده است' });
    const state: NavState = {
      flow: 'register',
      step: 'register.password',
      data: { phoneNumber: '09121112233', fullName: 'S', username: 'sara', channel: 'sms' },
    };

    const result = await register.handle({ ...ctx, text: 'Str0ng!pass' }, state, null);

    expect(result.view.body.raw).toBe('این شماره قبلاً ثبت شده است');
    expect(result.deleteIncoming).toBe(true);
  });
});

describe('ForgotFlow', () => {
  it('resets the password and keeps this chat signed in', async () => {
    const { forgot, api, sessions } = harness();

    let step = forgot.start();
    step = await forgot.handle({ ...ctx, text: '09121112233' }, step.nextState as NavState, null);
    expect(step.view.id).toBe('otp.channels');

    step = await forgot.handle(ctx, step.nextState as NavState, 'channel:sms');
    expect(api.forgotPassword).toHaveBeenCalled();

    step = await forgot.handle({ ...ctx, text: '123456' }, step.nextState as NavState, null);
    expect(step.view.id).toBe('forgot.password');
    expect(step.nextState?.data.resetToken).toBe('reset-1');

    const done = await forgot.handle({ ...ctx, text: 'N3w!password' }, step.nextState as NavState, null);
    expect(api.resetPassword).toHaveBeenCalledWith(
      { resetToken: 'reset-1', newPassword: 'N3w!password' },
      expect.anything(),
    );
    // The reset revoked every session; the one it returned is this chat's.
    expect(sessions.save).toHaveBeenCalledWith('telegram', '5501', 'r-4');
    expect(done.deleteIncoming).toBe(true);
    expect(done.view.id).toBe('forgot.done');
  });
});

describe('LoginFlow — the messenger account as the credential (ADR-0012)', () => {
  it('signs a linked chat in on the spot, with nothing typed and no code', async () => {
    const { login, api, sessions } = harness();
    (api.botSession as jest.Mock).mockResolvedValue(
      ok({ state: 'authenticated', tokens: { refreshToken: 'r-9' } }),
    );

    const result = await login.start(ctx);

    expect(api.botSession).toHaveBeenCalledWith(
      { platform: 'telegram', chatId: '5501', senderId: 42 },
      expect.anything(),
    );
    expect(sessions.save).toHaveBeenCalledWith('telegram', '5501', 'r-9');
    expect(result.view.body.key).toBe('bot.common.signedIn');
    expect(result.nextState).toBeNull();
  });

  it('asks an unlinked chat for its contact card, then signs it in', async () => {
    const { login, api, sessions } = harness();

    const asked = await login.start(ctx);
    expect(asked.view.id).toBe('login.chat');

    (api.botSession as jest.Mock).mockResolvedValue(
      ok({ state: 'authenticated', tokens: { refreshToken: 'r-10' } }),
    );
    const done = await login.handle(
      { ...ctx, contact: { phone_number: '+989121112233', user_id: 42 } },
      asked.nextState as NavState,
      null,
    );

    expect(sessions.save).toHaveBeenCalledWith('telegram', '5501', 'r-10');
    expect(done.nextState).toBeNull();
  });

  it("falls back to the ordinary ways in, carrying auth-api's reason", async () => {
    // A privileged role, or a number with no account: not a dead end, and not
    // a decision this flow makes — it opens the OTP/password screen instead.
    const { login, api } = harness();
    const asked = await login.start(ctx);
    (api.botSession as jest.Mock).mockResolvedValue({
      ok: false,
      msg: 'این روش برای این حساب مجاز نیست',
    });

    const result = await login.handle(
      { ...ctx, contact: { phone_number: '+989121112233', user_id: 42 } },
      asked.nextState as NavState,
      null,
    );

    expect(result.view.id).toBe('login.method');
    expect(result.view.hint?.raw).toBe('این روش برای این حساب مجاز نیست');
  });
});
