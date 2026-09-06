import { HttpException } from '@nestjs/common';
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
  limit: 5,
  windowSec: 900,
};

describe('RateLimitGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let limiter: { hit: jest.Mock };
  let guard: RateLimitGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(loginLimit) };
    limiter = {
      hit: jest.fn().mockResolvedValue({ allowed: true, current: 1, limit: 5 }),
    };
    guard = new RateLimitGuard(
      reflector as unknown as Reflector,
      limiter as unknown as RateLimiter,
    );
  });

  const contextWithBody = (body: unknown) =>
    fakeExecutionContext({ extra: { body } });

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
      limit: 3,
      windowSec: 60,
    });
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
