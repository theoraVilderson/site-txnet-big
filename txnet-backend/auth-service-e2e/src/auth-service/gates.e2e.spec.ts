/**
 * The two gates that sit in front of the auth routes: the bot check
 * (F-0201) and the rate limits. Both are contract, not implementation — a
 * client that does not walk the challenge, or that retries too fast, gets a
 * specific answer it has to handle.
 */
import { ConfigService } from '@nestjs/config';
import { createE2eApp, E2eApp } from '../support/app';
import { AuthApi, sleep } from '../support/api';
import { newAccount, signUp } from '../support/fixtures';

describe('auth-api — captcha and rate-limit gates', () => {
  let e2e: E2eApp;
  let api: AuthApi;
  /**
   * The limits the booted service is actually running with. Counting to a
   * literal here pinned the same number in two places, so a deployment could
   * not move one without the suite going red for the wrong reason — and a
   * default changed in `env.validation.ts` alone would have gone unnoticed.
   */
  let limits: {
    captcha: number;
    forgotVerify: number;
    loginFailureLock: number;
  };

  beforeAll(async () => {
    e2e = await createE2eApp();
    const config = e2e.app.get(ConfigService);
    limits = {
      captcha: config.get<number>('CAPTCHA_RATE_LIMIT')!,
      forgotVerify: config.get<number>('FORGOT_VERIFY_RATE_LIMIT')!,
      loginFailureLock: config.get<number>('LOGIN_FAILURE_LOCK_THRESHOLD')!,
    };
  });

  afterAll(async () => {
    await e2e.close();
  });

  beforeEach(async () => {
    await e2e.reset();
    api = new AuthApi(e2e.server);
  });

  describe('POST /auth/captcha/*', () => {
    it('issues a challenge and turns a completed slide into a pass', async () => {
      const issued = await api.challenge();

      expect(issued.status).toBe(200);
      expect(issued.body).toEqual({
        ok: true,
        msg: 'successful',
        data: { challengeId: expect.any(String) },
      });

      await sleep(300);
      const verified = await api.verifyChallenge(issued.body.data.challengeId);

      expect(verified.status).toBe(200);
      expect(verified.body).toEqual({
        ok: true,
        msg: 'successful',
        data: { token: expect.any(String), expiresIn: 120 },
      });
    });

    it('rejects a slide completed faster than a human could drag it', async () => {
      const issued = await api.challenge();

      const verified = await api.verifyChallenge(issued.body.data.challengeId);

      expect(verified.body).toMatchObject({ ok: false, msg: 'captcha.invalid' });
    });

    it('burns the challenge on the first verify, win or lose', async () => {
      const issued = await api.challenge();
      await sleep(300);
      await api.verifyChallenge(issued.body.data.challengeId);

      const again = await api.verifyChallenge(issued.body.data.challengeId);

      expect(again.body).toMatchObject({ ok: false, msg: 'captcha.invalid' });
    });

    it('rejects a challenge id that was never issued', async () => {
      const res = await api.verifyChallenge('11111111-2222-3333-4444-555555555555');

      expect(res.body).toMatchObject({ ok: false, msg: 'captcha.invalid' });
    });
  });

  describe('the gated routes', () => {
    it.each([
      ['register', () => api.register(newAccount(), { captcha: null })],
      [
        'login/password',
        () =>
          api.login(
            { identifier: 'someone', password: 'Str0ng!Pa55phrase' },
            { captcha: null },
          ),
      ],
      [
        'login/otp/request',
        () =>
          api.requestLoginOtp(
            { phoneNumber: newAccount().phoneNumber },
            { captcha: null },
          ),
      ],
      [
        'password/forgot',
        () =>
          api.forgotPassword(
            { phoneNumber: newAccount().phoneNumber },
            { captcha: null },
          ),
      ],
    ])('POST /auth/%s refuses a request with no pass', async (_name, call) => {
      const res = await call();

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        ok: false,
        msg: 'captcha.required',
        ref: expect.any(String),
      });
    });

    it('spends the pass: the same token cannot gate two requests', async () => {
      const token = await api.solveCaptcha();

      const first = await api.register(newAccount(), { captcha: token });
      const second = await api.register(newAccount(), { captcha: token });

      expect(first.status).toBe(201);
      expect(first.body.ok).toBe(true);
      expect(second.status).toBe(400);
      expect(second.body).toMatchObject({ ok: false, msg: 'captcha.required' });
    });

    it('rejects a pass that was never minted', async () => {
      const res = await api.register(newAccount(), { captcha: 'made-up-token' });

      expect(res.body).toMatchObject({ ok: false, msg: 'captcha.required' });
    });

    it('leaves the ungated routes alone', async () => {
      await signUp(api, e2e.otp);

      // verify-phone, refresh and logout carry no pass and must still work —
      // they are the second half of flows whose first half already paid.
      const channels = await api.otpChannels();
      const refreshed = await api.refresh();
      const loggedOut = await api.logout();

      expect(channels.status).toBe(200);
      expect(refreshed.body.ok).toBe(true);
      expect(loggedOut.body.ok).toBe(true);
    });
  });

  describe('rate limits', () => {
    it('cuts the captcha challenge off at the configured limit', async () => {
      for (let i = 0; i < limits.captcha; i++) {
        expect((await api.challenge()).status).toBe(200);
      }

      const blocked = await api.challenge();

      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({
        ok: false,
        msg: 'system.rateLimit',
        ref: expect.any(String),
      });
    });

    it('cuts forgot-password OTP verification off at the configured limit', async () => {
      const phoneNumber = newAccount().phoneNumber;

      for (let i = 0; i < limits.forgotVerify; i++) {
        const res = await api.forgotVerifyOtp({ phoneNumber, otpCode: '000000' });
        expect(res.status).not.toBe(429);
      }

      const blocked = await api.forgotVerifyOtp({ phoneNumber, otpCode: '000000' });

      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ ok: false, msg: 'system.rateLimit' });
    });

    it('locks one account after the configured failures, without locking the IP', async () => {
      const { account } = await signUp(api, e2e.otp);
      const attacker = new AuthApi(e2e.server);
      const wrong = { identifier: account.username, password: 'Wr0ng!Passw0rd' };

      for (let i = 0; i < limits.loginFailureLock; i++) {
        const res = await attacker.login(wrong);
        expect(res.body).toMatchObject({ ok: false, msg: 'auth.invalidCredentials' });
      }

      const locked = await attacker.login(wrong);
      expect(locked.body).toMatchObject({ ok: false, msg: 'auth.temporarilyLocked' });

      // The lock is on the account, not the caller: the right password is
      // refused too...
      const rightPassword = await attacker.login({
        identifier: account.username,
        password: account.password,
      });
      expect(rightPassword.body).toMatchObject({
        ok: false,
        msg: 'auth.temporarilyLocked',
      });

      // ...while another account, from the same IP and inside the same
      // per-IP window, is unaffected.
      const other = await signUp(new AuthApi(e2e.server), e2e.otp);
      const unaffected = await attacker.login({
        identifier: other.account.username,
        password: other.account.password,
      });
      expect(unaffected.body).toMatchObject({ ok: true, msg: 'auth.loginSuccess' });
    });

    it('counts a phone identifier and its +98 spelling as one account', async () => {
      const { account } = await signUp(api, e2e.otp);
      const attacker = new AuthApi(e2e.server);
      const spellings = [
        account.phoneNumber,
        account.phoneNumber.replace(/^0/, '+98'),
      ];

      for (let i = 0; i < limits.loginFailureLock; i++) {
        await attacker.login({
          identifier: spellings[i % 2],
          password: 'Wr0ng!Passw0rd',
        });
      }

      const locked = await attacker.login({
        identifier: spellings[0],
        password: account.password,
      });

      expect(locked.body).toMatchObject({ ok: false, msg: 'auth.temporarilyLocked' });
    });
  });
});
