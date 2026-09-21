import type { Mock } from 'vitest';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CaptchaGuard } from './captcha.guard';
import { CaptchaService } from '../../auth/captcha/captcha.service';
import { REQUIRE_CAPTCHA_KEY } from '../../auth/decorators/require-captcha.decorator';
import { RateLimiter } from '../rate-limit/rate-limiter';
import { ConfigService } from '@nestjs/config';
import { fakeExecutionContext } from '../../../test-support/execution-context';

describe('CaptchaGuard', () => {
  let reflector: { getAllAndOverride: Mock };
  let captcha: { consumePass: Mock };
  let limiter: { hit: Mock };
  let config: { get: Mock };
  let guard: CaptchaGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn().mockReturnValue(true) };
    captcha = { consumePass: vi.fn().mockResolvedValue(true) };
    limiter = {
      hit: vi.fn().mockResolvedValue({ allowed: true, current: 1, limit: 120 }),
    };
    config = { get: vi.fn().mockReturnValue(120) };
    guard = new CaptchaGuard(
      reflector as unknown as Reflector,
      captcha as unknown as CaptchaService,
      limiter as unknown as RateLimiter,
      config as unknown as ConfigService,
    );
  });

  describe('routes not marked @RequireCaptcha', () => {
    it.each([
      ['no metadata', undefined],
      ['metadata explicitly false', false],
    ])('is skipped entirely when the route has %s', async (_label, meta) => {
      reflector.getAllAndOverride.mockReturnValue(meta);
      const { context } = fakeExecutionContext();

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(captcha.consumePass).not.toHaveBeenCalled();
    });
  });

  describe('a proven service caller', () => {
    it('passes a captcha-gated route without a token (ADR-0011)', async () => {
      // A bot cannot drag a slider; its per-chat rate limits carry the load.
      const { context } = fakeExecutionContext({ extra: { serviceCaller: true } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(captcha.consumePass).not.toHaveBeenCalled();
    });

    it('still demands a captcha when the caller only claims to be one', async () => {
      captcha.consumePass.mockResolvedValue(false);
      const { context } = fakeExecutionContext({ extra: { serviceCaller: false } });

      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
    });
  });

  describe('routes marked @RequireCaptcha', () => {
    it('reads the flag off the handler first, then the controller', async () => {
      const { context, handler, controllerClass } = fakeExecutionContext({
        headers: { 'x-captcha-token': 'tok-1' },
      });

      await guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
        REQUIRE_CAPTCHA_KEY,
        [handler, controllerClass],
      );
    });

    it('passes the X-Captcha-Token header to the service and allows the request', async () => {
      const { context } = fakeExecutionContext({
        headers: { 'x-captcha-token': 'tok-1' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(captcha.consumePass).toHaveBeenCalledWith('tok-1');
    });

    // The token is spent by the check itself (consumePass DELs it), so one
    // solved captcha must not cover two requests.
    it('rejects a token the service has already spent', async () => {
      captcha.consumePass.mockResolvedValue(false);
      const { context } = fakeExecutionContext({
        headers: { 'x-captcha-token': 'tok-1' },
      });

      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
    });

    it('rejects with the captcha.required key and status 400', async () => {
      captcha.consumePass.mockResolvedValue(false);
      const { context } = fakeExecutionContext();

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 400,
        response: { i18nKey: 'captcha.required' },
      });
    });

    it('still asks the service when no token was sent, and is refused', async () => {
      captcha.consumePass.mockResolvedValue(false);
      const { context } = fakeExecutionContext();

      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
      expect(captcha.consumePass).toHaveBeenCalledWith(undefined);
    });

    // A repeated header arrives as an array; sending one must not let a
    // non-string value reach the store lookup.
    it('treats a repeated X-Captcha-Token header as no token', async () => {
      captcha.consumePass.mockResolvedValue(false);
      const { context } = fakeExecutionContext();
      (
        context.switchToHttp().getRequest() as { headers: Record<string, unknown> }
      ).headers['x-captcha-token'] = ['tok-1', 'tok-2'];

      await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
      expect(captcha.consumePass).toHaveBeenCalledWith(undefined);
    });
  });

  /**
   * What stands in for the slider the bot cannot drag (F-0201-c, F-0201-e).
   *
   * ADR-0011 waives the captcha for a proven service caller and says plainly
   * what that leaves: "the rate limits, not the captcha, are then the only
   * thing between an attacker and these routes". This is the limit that
   * answers it: one budget for the acting **chat's** unproven traffic, across
   * exactly the routes the captcha is waived on.
   *
   * It is keyed on the chat and not on the tenant. ADR-0069 shipped the tenant
   * key first, to price an attacker who buys messenger accounts; ADR-0070
   * reversed it, because a budget shared across a reseller's whole bot is one
   * an attacker can spend, and then the sign-in it refuses belongs to a
   * customer who spent nothing. These tests pin the subject, so a return to a
   * shared budget cannot happen by accident.
   */
  describe('the ceiling that replaces the waived captcha', () => {
    const botCall = (chatId = '55') =>
      fakeExecutionContext({
        extra: { serviceCaller: true, rateSubject: `bot:${chatId}` },
      }).context;

    it('spends the acting chat\'s own budget, named by the chat', async () => {
      await expect(guard.canActivate(botCall())).resolves.toBe(true);

      expect(limiter.hit).toHaveBeenCalledWith('bot:unproven:bot:55', 120, 900);
    });

    // The point of ADR-0070: one chat running out must leave every other chat
    // of the same reseller untouched, because the customer a shared budget
    // refuses is never the attacker who spent it.
    it('gives two chats of one tenant separate budgets', async () => {
      await guard.canActivate(botCall('55'));
      await guard.canActivate(botCall('66'));

      const buckets = limiter.hit.mock.calls.map((call) => call[0]);
      expect(buckets).toEqual(['bot:unproven:bot:55', 'bot:unproven:bot:66']);
    });

    // The tenant is still in the key — `RedisKeys.rateLimit` prefixes it
    // (F-1206) — so a chat id, which is the messenger's and identical at two
    // resellers' front doors, never joins their budgets.
    it('names no tenant itself, leaving that to the key builder', async () => {
      await guard.canActivate(botCall());

      expect(limiter.hit.mock.calls[0][0]).toBe('bot:unproven:bot:55');
    });

    it('refuses with 429 once this chat has spent it', async () => {
      limiter.hit.mockResolvedValue({ allowed: false, current: 121, limit: 120 });

      await expect(guard.canActivate(botCall())).rejects.toMatchObject({
        status: 429,
      });
      expect(captcha.consumePass).not.toHaveBeenCalled();
    });

    // `reason` is what F-0201-d branches on to offer the Mini App instead of a
    // dead end, and it is read rather than the status code (ADR-0043,
    // ADR-0009). A refusal that stopped naming it would silently become an
    // ordinary "try later".
    it('names the reason the bot recognises', async () => {
      limiter.hit.mockResolvedValue({ allowed: false, current: 121, limit: 120 });

      await expect(guard.canActivate(botCall())).rejects.toMatchObject({
        response: {
          i18nKey: 'auth.temporarilyLocked',
          reason: 'botTrafficThrottled',
        },
      });
    });

    it('leaves an ungated route alone, however it arrived', async () => {
      // The ceiling is the captcha's stand-in, so it covers the captcha's
      // routes and nothing else — a bot reading `/auth/me` is ordinary traffic.
      reflector.getAllAndOverride.mockReturnValue(undefined);

      await expect(guard.canActivate(botCall())).resolves.toBe(true);
      expect(limiter.hit).not.toHaveBeenCalled();
    });

    it('does not spend it for a browser, which pays with a slide instead', async () => {
      const { context } = fakeExecutionContext({ headers: { 'x-captcha-token': 'tok-1' } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(limiter.hit).not.toHaveBeenCalled();
    });
  });

});
