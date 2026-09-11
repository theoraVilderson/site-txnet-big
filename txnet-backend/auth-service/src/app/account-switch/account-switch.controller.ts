import {
  RateLimitBucket,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';
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
import { AccountSwitchService } from './account-switch.service';
import {
  addByOtpRequestSchema,
  addByOtpVerifySchema,
  addByPasswordSchema,
  removeAccountSchema,
  switchAccountSchema,
} from './account-switch.schema';
import { withRefreshCookie } from '../common/http/refresh-cookie';
import { resolveSwitchScope } from '../common/security/switch-scope';

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
 * Every route reads the **switch scope** off the request (ADR-0015). It is not
 * in any body: a caller must not be able to name the surface it is acting for,
 * because that is what separates one browser's group from another's. It comes
 * from the `device_id` cookie or, for `bot-service`, from the verified service
 * token plus the platform and chat headers — all of them set below the route.
 */
@Controller('auth/accounts')
export class AccountSwitchController {
  constructor(private readonly accounts: AccountSwitchService) {}

  private lang(req: Request): string {
    return (req as any).language ?? 'fa';
  }

  private callerId(req: Request): string {
    return (req as any).user.sub;
  }

  /** The session this request arrived on — the one a switch revokes. */
  private callerSessionId(req: Request): string {
    return (req as any).user.sessionId;
  }

  private ua(req: Request): string {
    return req.get('user-agent') ?? 'unknown';
  }

  @Post('add/otp/request')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(addByOtpRequestSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_ADD_OTP_REQUEST, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_ADD_OTP_REQUEST_RATE_LIMIT',
    windowSec: 900,
  })
  requestAddOtp(@Body() body: any, @Ip() ip: string, @Req() req: Request) {
    return this.accounts.requestAddOtp(
      this.callerId(req),
      body.phoneNumber,
      body.channel,
      ip,
      this.lang(req),
    );
  }

  @Post('add/otp/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(addByOtpVerifySchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_ADD_OTP_VERIFY, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_ADD_OTP_VERIFY_RATE_LIMIT',
    windowSec: 900,
  })
  addByOtp(@Body() body: any, @Req() req: Request) {
    return this.accounts.addByOtp(
      resolveSwitchScope(req),
      this.callerId(req),
      body,
    );
  }

  @Post('add/password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(addByPasswordSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ACCOUNTS_ADD_PASSWORD, req?.user?.sub ?? req?.ip),
    configKey: 'ACCOUNTS_ADD_PASSWORD_RATE_LIMIT',
    windowSec: 900,
  })
  addByPassword(@Body() body: any, @Req() req: Request) {
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
    @Body() body: any,
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
   * Remove a member from the group on this surface (F-0208).
   *
   * Mints nothing and sets no cookie, even when the caller removes itself: the
   * caller's *own* session is only revoked if it was minted in this scope, and
   * that is a sign-out, not a handover — there is no replacement session to
   * hand back. The panel reloads and lands on the login screen; the bot's next
   * call finds no session and offers the one-tap sign-in.
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
  remove(@Body() body: any, @Req() req: Request) {
    return this.accounts.remove(
      resolveSwitchScope(req),
      this.callerId(req),
      body.userId,
    );
  }
}
