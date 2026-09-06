import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_CAPTCHA_KEY } from '../../auth/decorators/require-captcha.decorator';
import { CaptchaService } from '../../auth/captcha/captcha.service';
import { isServiceCaller } from '../security/service-caller';

@Injectable()
export class CaptchaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly captcha: CaptchaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_CAPTCHA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context.switchToHttp().getRequest();

    // A bot cannot drag a slider. Another service of this platform, proven by
    // `SERVICE_AUTH_TOKEN`, stands in for the bot check — its own per-chat rate
    // limits are what carry the load instead (ADR-0011).
    if (isServiceCaller(request)) return true;

    const token = request.headers['x-captcha-token'];
    const passed = await this.captcha.consumePass(
      typeof token === 'string' ? token : undefined,
    );
    if (!passed) {
      throw new HttpException({ i18nKey: 'captcha.required' }, 400);
    }
    return true;
  }
}
