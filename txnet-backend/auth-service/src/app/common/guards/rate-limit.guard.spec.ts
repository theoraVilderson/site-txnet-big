import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimiter } from '../rate-limit/rate-limiter';
import {
  RATE_LIMIT_KEY,
  RateLimitOptions,
} from '../../auth/decorators/rate-limit.decorator';
import { fakeExecutionContext } from '../../../test-support/execution-context';

const loginLimit: RateLimitOptions = {
  key: (req) => `login:${req.body?.identifier}`,
  configKey: 'LOGIN_PWD_RATE_LIMIT',
  windowSec: 900,
};

/** What the validated env holds for each limit — the schema's defaults. */
const configured: Record<string, number> = { LOGIN_PWD_RATE_LIMIT: 5 };

describe('RateLimitGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let limiter: { hit: jest.Mock; hitPlatform: jest.Mock };
  let config: { get: jest.Mock };
  let guard: RateLimitGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(loginLimit) };
    limiter = {
      hit: jest.fn().mockResolvedValue({ allowed: true, current: 1, limit: 5 }),
      // The platform-wide ceiling over the same bucket (F-066-s). It is
      // exercised in `rate-limit-platform.spec.ts`; here it always allows, so
      // these cases still describe the per-tenant counter alone.
      hitPlatform: jest
        .fn()
        .mockResolvedValue({ allowed: true, current: 1, limit: 50 }),
    };
    // The validated env: every limit has a value, because the schema gives
    // each one a default.
    config = { get: jest.fn((key: string) => configured[key]) };
    guard = new RateLimitGuard(
      reflector as unknown as Reflector,
      limiter as unknown as RateLimiter,
      config as unknown as ConfigService,
    );
  });

  const contextWithBody = (body: unknown) =>
    fakeExecutionContext({ extra: { body } });

  /**
   * F-087, decided 2026-09-11: every limit is deployment config and every one
   * has a default. The default lives once, in the env schema — not on the
   * decorator as well — so the guard reads the variable and has no second
   * number to fall back on. Decorator metadata is evaluated once at
   * class-definition time and cannot see ConfigService, which is why the route
   * names the variable and the guard resolves it per request.
   */
  describe('where the limit comes from', () => {
    it('reads the limit from the variable the route names', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'LOGIN_PWD_RATE_LIMIT' ? 3 : undefined,
      );

      await guard.canActivate(contextWithBody({ identifier: '0912' }).context);

      expect(config.get).toHaveBeenCalledWith('LOGIN_PWD_RATE_LIMIT');
      expect(limiter.hit).toHaveBeenCalledWith(expect.any(String), 3, 900);
    });

    it('uses the schema default when the environment sets nothing', async () => {
      await guard.canActivate(contextWithBody({ identifier: '0912' }).context);

      expect(limiter.hit).toHaveBeenCalledWith(expect.any(String), 5, 900);
    });

    it('refuses to guess when the variable resolves to nothing', async () => {
      // Only reachable if a route names a key the schema does not declare,
      // which the `configKey` type already forbids. If it happens anyway it is
      // a deployment bug, and a silent default is exactly the failure the
      // decision was made to avoid — so it fails the request loudly.
      config.get.mockReturnValue(undefined);

      await expect(
        guard.canActivate(contextWithBody({ identifier: '0912' }).context),
      ).rejects.toThrow(/LOGIN_PWD_RATE_LIMIT/);
      expect(limiter.hit).not.toHaveBeenCalled();
    });

    it('refuses a limit that is not a positive whole number', async () => {
      for (const bad of [0, -1, 2.5, Number.NaN]) {
        config.get.mockReturnValue(bad);
        await expect(
          guard.canActivate(contextWithBody({ identifier: '0912' }).context),
        ).rejects.toThrow(/LOGIN_PWD_RATE_LIMIT/);
      }
      expect(limiter.hit).not.toHaveBeenCalled();
    });
  });

  it('is skipped on a route with no @RateLimit metadata', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const { context } = fakeExecutionContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(limiter.hit).not.toHaveBeenCalled();
  });

  it('reads the options off the handler first, then the controller', async () => {
    const { context, handler, controllerClass } = contextWithBody({
      identifier: '09120000000',
    });

    await guard.canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(RATE_LIMIT_KEY, [
      handler,
      controllerClass,
    ]);
  });

  // The bucket is derived from the request by the decorator's own key
  // function, so two callers of the same route must not share a counter.
  it('buckets by the decorator key function, per caller', async () => {
    const { context } = contextWithBody({ identifier: '09120000000' });
    const other = contextWithBody({ identifier: '09129999999' });

    await guard.canActivate(context);
    await guard.canActivate(other.context);

    expect(limiter.hit).toHaveBeenNthCalledWith(1, 'login:09120000000', 5, 900);
    expect(limiter.hit).toHaveBeenNthCalledWith(2, 'login:09129999999', 5, 900);
  });

  it('passes the configured limit and window straight through', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      key: () => 'otp:send',
      configKey: 'OTP_CHANNELS_RATE_LIMIT',
      windowSec: 60,
    });
    config.get.mockImplementation((key: string) =>
      key === 'OTP_CHANNELS_RATE_LIMIT' ? 3 : undefined,
    );
    const { context } = fakeExecutionContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(limiter.hit).toHaveBeenCalledWith('otp:send', 3, 60);
  });

  it('allows the request while the limiter says allowed', async () => {
    limiter.hit.mockResolvedValue({ allowed: true, current: 5, limit: 5 });
    const { context } = contextWithBody({ identifier: '09120000000' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects with 429 once the limiter refuses', async () => {
    limiter.hit.mockResolvedValue({ allowed: false, current: 6, limit: 5 });
    const { context } = contextWithBody({ identifier: '09120000000' });

    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 429,
    });
  });

  // Every hit counts, refused ones included — that is what makes hammering a
  // limited route keep the window open rather than reset it.
  it('counts a refused request as a hit as well', async () => {
    limiter.hit.mockResolvedValue({ allowed: false, current: 9, limit: 5 });
    const { context } = contextWithBody({ identifier: '09120000000' });

    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
    expect(limiter.hit).toHaveBeenCalledTimes(1);
  });

  // Redis being down must not silently disable the limiter: the error
  // propagates and the exception filter turns it into a 500.
  it('propagates a limiter failure instead of falling open', async () => {
    limiter.hit.mockRejectedValue(new Error('redis unreachable'));
    const { context } = contextWithBody({ identifier: '09120000000' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'redis unreachable',
    );
  });
});
