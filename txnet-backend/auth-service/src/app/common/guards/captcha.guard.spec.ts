import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CaptchaGuard } from './captcha.guard';
import { CaptchaService } from '../../auth/captcha/captcha.service';
import { REQUIRE_CAPTCHA_KEY } from '../../auth/decorators/require-captcha.decorator';
import { fakeExecutionContext } from '../../../test-support/execution-context';

describe('CaptchaGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let captcha: { consumePass: jest.Mock };
  let guard: CaptchaGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    captcha = { consumePass: jest.fn().mockResolvedValue(true) };
    guard = new CaptchaGuard(
      reflector as unknown as Reflector,
      captcha as unknown as CaptchaService,
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
});
