import {
  RateLimitBucket,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';
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
import { REFRESH_TOKEN_COOKIE } from '@txnet-backend/shared-core';
import { Request, Response } from 'express';
import { RegisterService } from './register.service';
import { AuthService } from '../auth.service';
import { registerSchema, verifyPhoneSchema } from './register.schema';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ResponseType } from '../../common/response/response.util';
import { refreshCookieOptions } from '../../common/http/refresh-cookie';
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

  // 202, not 201 (F-067-a): nothing is created here — the `user` row lands at
  // `verify-phone` (invariant #11) — and the code is accepted for delivery
  // rather than delivered.
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(NoActiveSessionGuard)
  @UsePipes(new ZodValidationPipe(registerSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.REGISTER, rateLimitSubject(req)),
    configKey: 'REGISTER_RATE_LIMIT',
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
    key: (req) => rateLimitBucketKey(RateLimitBucket.REGISTER_VERIFY, rateLimitSubject(req)),
    configKey: 'REGISTER_VERIFY_RATE_LIMIT',
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

      // The shared builder, not a second copy of it. This block used to
      // re-declare `domain`, `secure`, `sameSite` and `maxAge` inline, which
      // is the split-cookie failure `refresh-cookie.ts` warns about in its own
      // comment: a cookie written here with a different `domain` than the one
      // `auth` writes would not overwrite it, the browser would hold two
      // `refresh_token` cookies, and the user would land in whichever session
      // it chose to send.
      res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, refreshCookieOptions());
      result.data = { ...result.data, ...safeTokens };
    }
    return result;
  }
}
