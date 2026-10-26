import { Body, Controller, HttpCode, HttpStatus, Ip, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, TenantCapability, requestLanguage, ZodValidationPipe } from '@txnet-backend/shared-core';
import { Request, Response } from 'express';
import { LocaleService } from '../../locale/locale.service';
import { withRefreshCookie } from '../../common/http/refresh-cookie';
import { rateLimitSubject } from '../../common/security/service-caller';
import { resolveSwitchScope } from '../../common/security/switch-scope';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { NoActiveSessionGuard } from '../guards/no-active-session.guard';
import { ownerSetupCodeSchema, ownerSetupSchema, type OwnerSetupCodeInput, type OwnerSetupInput } from './owner-setup.schema';
import { OwnerSetupService } from './owner-setup.service';

/**
 * F-0102: the fresh install owner's first sign-in, after the password step
 * answered `setupRequired`. Not captcha-gated, like the second factor: the
 * caller holds the setup token a gated password step handed out, and each
 * route shares its code step's per-caller budget.
 */
@TenantCapability('signIn')
@Controller('auth/owner-setup')
export class OwnerSetupController {
  constructor(
    private readonly setup: OwnerSetupService,
    private readonly locale: LocaleService,
  ) {}

  // 202, like every code send (F-067-a): accepted for delivery, not delivered.
  @Post('code')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(NoActiveSessionGuard)
  @UsePipes(new ZodValidationPipe(ownerSetupCodeSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.LOGIN_OTP_REQUEST, rateLimitSubject(req)),
    configKey: 'LOGIN_OTP_REQUEST_RATE_LIMIT',
    windowSec: 900,
  })
  sendCode(@Body() body: OwnerSetupCodeInput, @Ip() ip: string, @Req() req: Request) {
    return this.setup.sendCode(body, ip, requestLanguage(req, this.locale));
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(NoActiveSessionGuard)
  @UsePipes(new ZodValidationPipe(ownerSetupSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.LOGIN_OTP_VERIFY, rateLimitSubject(req)),
    configKey: 'LOGIN_OTP_VERIFY_RATE_LIMIT',
    windowSec: 900,
  })
  async complete(
    @Body() body: OwnerSetupInput,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userAgent = req.get('user-agent') ?? 'unknown';
    const result = await this.setup.complete(body, { ip, userAgent, scopeKey: resolveSwitchScope(req) });
    return withRefreshCookie(res, result);
  }
}
