import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_CAPTCHA_KEY } from '../../auth/decorators/require-captcha.decorator';
import { CaptchaService } from '../../auth/captcha/captcha.service';

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
