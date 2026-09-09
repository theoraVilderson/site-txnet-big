import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { RegisterService } from './register.service';
import { AuthService } from '../auth.service';
import { registerSchema, verifyPhoneSchema } from './register.schema';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ResponseType } from '../../common/response/response.util';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { RequireCaptcha } from '../decorators/require-captcha.decorator';
import { rateLimitSubject } from '../../common/security/service-caller';
import { resolveSwitchScope } from '../../common/security/switch-scope';
import { NoActiveSessionGuard } from '../guards/no-active-session.guard';

@Controller('auth')
export class RegisterController {
  constructor(
    private readonly registerService: RegisterService,
    private readonly authService: AuthService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(NoActiveSessionGuard)
  @UsePipes(new ZodValidationPipe(registerSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => `register:${rateLimitSubject(req)}`,
    limit: 10,
    windowSec: 3600,
  })
  register(
    @Body() body: ReturnType<typeof registerSchema.parse>,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const lang = (req as any).language ?? 'fa';
    // No tenant argument: the request's tenant is ambient from here down
    // (ADR-0024). `identity` still never reads `tenant_domain` (§8) — it reads
    // the scope `TenantContextMiddleware` opened from what `tenant` resolved.
    return this.registerService.register(body, ip, lang);
  }

  @Post('register/verify-phone')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(verifyPhoneSchema))
  @RateLimit({
    key: (req) => `register:verify:${rateLimitSubject(req)}`,
    limit: 20,
    windowSec: 3600,
  })
  async verifyPhone(
    @Body() body: ReturnType<typeof verifyPhoneSchema.parse>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result: any = await this.registerService.verifyPhone(body);
    if (result.ok) {
      const user = await this.authService.findUserForSession(
        result.data.userId,
      );
      const tokens = await this.authService.createSessionForUser(
        user,
        req.ip ?? '0.0.0.0',
        req.get('user-agent') ?? 'unknown',
        resolveSwitchScope(req),
      );
      const { refreshToken, ...safeTokens } = tokens;
      const DOMAINNAME = process.env.DOMAIN_NAME!;

      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE !== 'false',
        sameSite: 'lax',
        path: '/', // تغییر اول
        domain: `.${DOMAINNAME}`, // تغییر دوم
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      result.data = { ...result.data, ...safeTokens };
    }
    return result;
  }
}
