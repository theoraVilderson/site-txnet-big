/**
 * forgot-password -> verify-otp -> reset, and the revocation that comes with
 * it: every session the account had is gone, and the device that performed
 * the reset is signed back in on a session minted after the revocation
 * (auth-api/contract.md, v5).
 */
import { createE2eApp, E2eApp } from '../support/app';
import { AuthApi, parseSetCookie } from '../support/api';
import { ACCESS_TTL_SEC, REFRESH_COOKIE } from '../support/env';
import { newAccount, signUp } from '../support/fixtures';

const NEW_PASSWORD = 'Rene9ed!Secret';

describe('auth-api — password reset', () => {
  let e2e: E2eApp;
  let phone: AuthApi;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    await e2e.close();
  });

  beforeEach(async () => {
    await e2e.reset();
    phone = new AuthApi(e2e.server);
  });

  it('walks the whole flow and leaves exactly one live session behind', async () => {
    // Two devices signed in on the same account: the phone signs up, the
    // laptop logs in. The reset happens on the laptop.
    const { account, userId, refreshToken: phoneToken } = await signUp(phone, e2e.otp);
    const laptop = new AuthApi(e2e.server);
    await laptop.login({ identifier: account.username, password: account.password });
    const laptopTokenBefore = laptop.refreshCookie;

    const asked = await laptop.forgotPassword({ phoneNumber: account.phoneNumber });
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({
      ok: true,
      msg: 'auth.resetOtpSent',
      data: { accepted: true },
    });

    const code = e2e.otp.latest(account.phoneNumber, 'password_reset');
    const verified = await laptop.forgotVerifyOtp({
      phoneNumber: account.phoneNumber,
      otpCode: code,
    });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({
      ok: true,
      msg: 'auth.resetTokenGenerated',
      data: { resetToken: expect.any(String) },
    });

    const reset = await laptop.resetPassword({
      resetToken: verified.body.data.resetToken,
      newPassword: NEW_PASSWORD,
    });

    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({
      ok: true,
      msg: 'auth.passwordResetSuccess',
      data: {
        success: true,
        accessToken: expect.any(String),
        expiresIn: ACCESS_TTL_SEC,
      },
    });
    expect(reset.body.data).not.toHaveProperty('refreshToken');
    const cookie = parseSetCookie(reset.headers['set-cookie'], REFRESH_COOKIE);
    expect(cookie?.attributes).toMatchObject({ httponly: true, path: '/' });
    expect(laptop.refreshCookie).not.toBe(laptopTokenBefore);

    // Both pre-reset sessions are dead...
    for (const dead of [phoneToken, laptopTokenBefore as string]) {
      const res = await new AuthApi(e2e.server).refresh({ refreshToken: dead });
      expect(res.body).toMatchObject({ ok: false, msg: 'auth.invalidRefreshToken' });
    }
    // ...and the one the reset handed back is not.
    const stillIn = await laptop.refresh();
    expect(stillIn.body).toMatchObject({ ok: true, msg: 'auth.refreshSuccess' });

    const sessions = await e2e.prisma.session.findMany({
      where: { userId },
      orderBy: { issuedAt: 'asc' },
    });
    expect(sessions.filter((s) => s.revokedAt === null)).toHaveLength(1);
    expect(
      sessions.filter((s) => s.revokedReason === 'password_change'),
    ).toHaveLength(2);
  });

  it('changes the password that actually works', async () => {
    const { account } = await signUp(phone, e2e.otp);
    await phone.forgotPassword({ phoneNumber: account.phoneNumber });
    const verified = await phone.forgotVerifyOtp({
      phoneNumber: account.phoneNumber,
      otpCode: e2e.otp.latest(account.phoneNumber, 'password_reset'),
    });
    await phone.resetPassword({
      resetToken: verified.body.data.resetToken,
      newPassword: NEW_PASSWORD,
    });

    const withOld = await new AuthApi(e2e.server).login({
      identifier: account.username,
      password: account.password,
    });
    expect(withOld.body).toMatchObject({
      ok: false,
      msg: 'auth.invalidCredentials',
    });

    const withNew = await new AuthApi(e2e.server).login({
      identifier: account.username,
      password: NEW_PASSWORD,
    });
    expect(withNew.body).toMatchObject({ ok: true, msg: 'auth.loginSuccess' });
  });

  it('says "a code was sent" for a number with no account, and sends none', async () => {
    const stranger = newAccount();

    const res = await phone.forgotPassword({ phoneNumber: stranger.phoneNumber });

    expect(res.body).toEqual({
      ok: true,
      msg: 'auth.resetOtpSent',
      data: { accepted: true },
    });
    expect(e2e.otp.isEmpty()).toBe(true);
  });

  it('refuses a wrong code, and the right one still works afterwards', async () => {
    const { account } = await signUp(phone, e2e.otp);
    await phone.forgotPassword({ phoneNumber: account.phoneNumber });

    const wrong = await phone.forgotVerifyOtp({
      phoneNumber: account.phoneNumber,
      otpCode: '000000',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ ok: false, msg: 'system.badRequest' });

    const right = await phone.forgotVerifyOtp({
      phoneNumber: account.phoneNumber,
      otpCode: e2e.otp.latest(account.phoneNumber, 'password_reset'),
    });
    expect(right.body).toMatchObject({ ok: true, msg: 'auth.resetTokenGenerated' });
  });

  it('rejects a reset token it did not issue', async () => {
    const res = await phone.resetPassword({
      resetToken: 'not.a.valid.reset.token.at.all',
      newPassword: NEW_PASSWORD,
    });

    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.msg).not.toBe('auth.passwordResetSuccess');
  });

  it('will not accept a weak new password, and says which rule broke', async () => {
    const { account } = await signUp(phone, e2e.otp);
    await phone.forgotPassword({ phoneNumber: account.phoneNumber });
    const verified = await phone.forgotVerifyOtp({
      phoneNumber: account.phoneNumber,
      otpCode: e2e.otp.latest(account.phoneNumber, 'password_reset'),
    });

    const res = await phone.resetPassword({
      resetToken: verified.body.data.resetToken,
      newPassword: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      ok: false,
      ref: expect.any(String),
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: 'newPassword' }),
      ]),
    });
  });

  it('will not let the new password contain the account\'s own details', async () => {
    const { account } = await signUp(phone, e2e.otp);
    await phone.forgotPassword({ phoneNumber: account.phoneNumber });
    const verified = await phone.forgotVerifyOtp({
      phoneNumber: account.phoneNumber,
      otpCode: e2e.otp.latest(account.phoneNumber, 'password_reset'),
    });

    const res = await phone.resetPassword({
      resetToken: verified.body.data.resetToken,
      newPassword: `Aa1!${account.username}`,
    });

    expect(res.body).toMatchObject({
      ok: false,
      msg: 'password.containsProfileData',
    });
  });
});
