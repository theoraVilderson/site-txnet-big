import { OtpChannel } from '@prisma/client';
import { OtpResendService } from './otp-resend.service';

/**
 * F-0201-f: "Resend code" sends a code. The step that sent the first one
 * (login, register, forgot) wrote a grant once its captcha passed; a resend
 * spends one use of it and replays that same step, so the answer, the account
 * checks and the OTP service's cooldown are the step's own.
 */
describe('OtpResendService (F-0201-f)', () => {
  const PHONE = '+989121234567';
  const build = (granted = true) => {
    const grants = { grant: vi.fn(), spend: vi.fn(async () => granted) };
    const auth = {
      requestLoginOtp: vi.fn(async () => ({ ok: true, msg: 'auth.otpSent', data: { accepted: true } })),
      forgotPassword: vi.fn(async () => ({ ok: true, msg: 'auth.resetOtpSent', data: { accepted: true } })),
    };
    const register = { resendCode: vi.fn(async () => ({ ok: true, msg: 'register.success', data: {} })) };
    const service = new OtpResendService(grants as never, auth as never, register as never);
    return { service, grants, auth, register };
  };
  const resend = (h: ReturnType<typeof build>, purpose: 'login' | 'register' | 'forgot') =>
    h.service.resend({ purpose, phoneNumber: PHONE, channel: OtpChannel.sms }, '1.2.3.4', 'fa');

  it('replays the login code request on a live grant', async () => {
    const h = build();
    expect(await resend(h, 'login')).toMatchObject({ ok: true, msg: 'auth.otpSent' });
    expect(h.grants.spend).toHaveBeenCalledWith('login', PHONE);
    expect(h.auth.requestLoginOtp).toHaveBeenCalledWith(PHONE, OtpChannel.sms, '1.2.3.4', 'fa');
  });

  it('replays the reset code and the registration code by their own steps', async () => {
    const h = build();
    await resend(h, 'forgot');
    await resend(h, 'register');
    expect(h.auth.forgotPassword).toHaveBeenCalledWith({ phoneNumber: PHONE, channel: OtpChannel.sms }, '1.2.3.4', 'fa');
    expect(h.register.resendCode).toHaveBeenCalledWith(PHONE, OtpChannel.sms, '1.2.3.4', 'fa');
  });

  it('refuses without a grant — no captcha passed, or its uses are spent — and sends nothing', async () => {
    const h = build(false);
    expect(await resend(h, 'login')).toMatchObject({ ok: false, msg: 'otp.resendExpired' });
    expect(h.auth.requestLoginOtp).not.toHaveBeenCalled();
  });
});
