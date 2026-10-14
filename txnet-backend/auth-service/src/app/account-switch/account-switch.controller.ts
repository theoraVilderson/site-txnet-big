import { RateLimitBucket, rateLimitBucketKey, TenantCapability, requestLanguage } from '@txnet-backend/shared-core';
import {
  Body,
  Controller,
  Get,
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
import { AuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RateLimit } from '../auth/decorators/rate-limit.decorator';
import { RequireCaptcha } from '../auth/decorators/require-captcha.decorator';
import { AccountSwitchService } from './account-switch.service';
import type { AuthClaims } from '../auth/token.service';
import { LocaleService } from '../locale/locale.service';
import type { z } from 'zod';
import {
  addByOtpRequestSchema,
  addByOtpVerifySchema,
  addByPasswordSchema,
  removeAccountSchema,
  switchAccountSchema,
  twoFactorSwitchCodeSchema,
  twoFactorSwitchPasswordSchema,
  type TwoFactorSwitchCodeInput,
  type TwoFactorSwitchPasswordInput,
} from './account-switch.schema';
import { TwoFactorSwitchService } from './two-factor-switch.service';
import { withRefreshCookie } from '../common/http/refresh-cookie';
import { botScopeOf, resolveSwitchScope } from '../common/security/switch-scope';
import { AllowRestricted } from '../auth/decorators/allow-restricted.decorator';

/**
 * The caller's own switch group: adding to it (F-0205), reading it (F-0206),
 * and moving between its members (F-0207).
 *
 * Every route here is behind `AuthGuard` and none is behind
 * `NoActiveSessionGuard`: a live session is not an obstacle to these calls, it
 * is their *premise* (C-21). That is also why F-0101 is untouched — nothing
 * here authenticates anybody, it only records a proof.
 *
 * Rate limits are keyed on the caller's own user id rather than on the IP: the
 * caller is known here, and an IP key would let one signed-in account spend a
 * shared NAT's budget for everyone behind it.
 *
 * The two **proof** routes are captcha-gated as well (F-0201). F-0205 asks for
 * both to be metered "exactly like a login", and a login is metered *and* gated
 * — a signed-in attacker was otherwise offered the cheapest account-existence
 * oracle on the service, and `add/otp/request` sends a real message to somebody
 * else's number. The `verify` half is not gated: it spends a code this gate
 * already paid for, and a second slide mid-flow buys nothing.
 *
 * Every route reads the **switch scope** off the request (ADR-0015). It is not
 * in any body: a caller must not be able to name the surface it is acting for,
 * because that is what separates one browser's group from another's. It comes
 * from the `device_id` cookie or, for `bot-service`, from the verified service
 * token plus the platform and chat headers — all of them set below the route.
 */
@TenantCapability('account')
// A restricted account may still move to another of its accounts (ADR-0133).
@AllowRestricted()
@Controller('auth/accounts')
export class AccountSwitchController {
  constructor(
    private readonly accounts: AccountSwitchService,
    private readonly locale: LocaleService,
    private readonly twoFactor: TwoFactorSwitchService,
  ) {}


  // AuthGuard on every route here sets the claims (auth.guard.ts).
  private callerId(req: Request): string {
    return (req as Request & { user: AuthClaims }).user.sub;
  }

  /** The session this request arrived on — the one a switch revokes. */
  private callerSessionId(req: Request): string {
    return (req as Request & { user: AuthClaims }).user.sessionId;
  }

  private ua(req: Request): string {
    return req.get('user-agent') ?? 'unknown';
  }

  @TenantCapability('signIn')
  @Post('add/otp/request')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(addByOtpRequestSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_ADD_OTP_REQUEST, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_ADD_OTP_REQUEST_RATE_LIMIT',
    windowSec: 900,
  })
  requestAddOtp(@Body() body: z.infer<typeof addByOtpRequestSchema>, @Ip() ip: string, @Req() req: Request) {
    return this.accounts.requestAddOtp(
      this.callerId(req),
      body.phoneNumber,
      body.channel,
      ip,
      requestLanguage(req, this.locale),
    );
  }

  @TenantCapability('signIn')
  @Post('add/otp/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(addByOtpVerifySchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_ADD_OTP_VERIFY, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_ADD_OTP_VERIFY_RATE_LIMIT',
    windowSec: 900,
  })
  addByOtp(@Body() body: z.infer<typeof addByOtpVerifySchema>, @Req() req: Request) {
    return this.accounts.addByOtp(
      resolveSwitchScope(req),
      this.callerId(req),
      body,
    );
  }

  @TenantCapability('signIn')
  @Post('add/password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(addByPasswordSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_ADD_PASSWORD, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_ADD_PASSWORD_RATE_LIMIT',
    windowSec: 900,
  })
  addByPassword(@Body() body: z.infer<typeof addByPasswordSchema>, @Req() req: Request) {
    return this.accounts.addByPassword(
      resolveSwitchScope(req),
      this.callerId(req),
      body,
    );
  }

  /**
   * The group, as the panel's switcher renders it (F-0206).
   *
   * Read-only and cheap, so it carries a generous limit: the panel asks for it
   * on every load of a signed-in page.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_LIST, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_LIST_RATE_LIMIT',
    windowSec: 900,
  })
  list(@Req() req: Request) {
    return this.accounts.list(resolveSwitchScope(req), this.callerId(req));
  }

  /**
   * Become another member of the group (F-0207).
   *
   * The response is an ordinary token pair and an ordinary `refresh_token`
   * cookie — deliberately identical to a login, because that is what the
   * browser now holds. The old cookie is overwritten rather than cleared
   * first: same name, same options (`common/http/refresh-cookie.ts`), so there
   * is never a moment with no cookie at all.
   */
  @Post('switch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(switchAccountSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_SWITCH, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_SWITCH_RATE_LIMIT',
    windowSec: 900,
  })
  async switchTo(
    @Body() body: z.infer<typeof switchAccountSchema>,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.accounts.switchTo(
      resolveSwitchScope(req),
      this.callerId(req),
      this.callerSessionId(req),
      body.userId,
      ip,
      this.ua(req),
    );
    return withRefreshCookie(res, result);
  }

  /**
   * The two-factor switch, step 1 (ADR-0145): a holder of `*` is not reached
   * by the one-click switch, so their own password is asked here and a code
   * sent to their number. Captcha and the add-by-password budget, because this
   * is one more place to guess a password.
   */
  @TenantCapability('signIn')
  @Post('switch/password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(twoFactorSwitchPasswordSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_ADD_PASSWORD, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_ADD_PASSWORD_RATE_LIMIT',
    windowSec: 900,
  })
  switchByPassword(@Body() body: TwoFactorSwitchPasswordInput, @Ip() ip: string, @Req() req: Request) {
    return this.twoFactor.begin(resolveSwitchScope(req), this.callerId(req), body, ip, requestLanguage(req, this.locale));
  }

  /** Step 2: the code; then the same switch, token pair and cookie as `switch`. */
  @Post('switch/code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(twoFactorSwitchCodeSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_ADD_OTP_VERIFY, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_ADD_OTP_VERIFY_RATE_LIMIT',
    windowSec: 900,
  })
  async switchByCode(
    @Body() body: TwoFactorSwitchCodeInput,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.twoFactor.finish(resolveSwitchScope(req), this.callerId(req), this.callerSessionId(req), body, ip, this.ua(req));
    return withRefreshCookie(res, result);
  }

  /**
   * Remove a member from the group on this surface (F-0208).
   *
   * Removing another member mints nothing. Removing **the caller itself** in a
   * browser hands it to the member it falls back to (see the service), so the
   * response is then a token pair and the `refresh_token` cookie, like a
   * switch. Only when no member is left — and always in a chat — does it end
   * as a sign-out: the panel lands on the login screen, the bot's next call
   * offers the one-tap sign-in.
   *
   * Limit is the switch's, not the add's: it changes no credential and reveals
   * nothing (every refusal is `accountSwitch.notAMember`), but it does write.
   */
  @Post('remove')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(removeAccountSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_REMOVE, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_REMOVE_RATE_LIMIT',
    windowSec: 900,
  })
  async remove(
    @Body() body: z.infer<typeof removeAccountSchema>,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.accounts.remove(
      resolveSwitchScope(req),
      this.callerId(req),
      body.userId,
      // A browser only: a chat's session lives in the bot's own store, and
      // leaving there stays a sign-out (`bot-service` drops its token).
      botScopeOf(req)
        ? undefined
        : { sessionId: this.callerSessionId(req), ip, userAgent: this.ua(req) },
    );
    return withRefreshCookie(res, result);
  }
}
