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
import { REFRESH_TOKEN_COOKIE } from '@txnet-backend/shared-core';
import { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import {
  forgotPasswordSchema,
  forgotVerifySchema,
  logoutSchema,
  otpDeliveryStatusSchema,
  otpRequestSchema,
  otpVerifySchema,
  passwordLoginSchema,
  refreshSchema,
  resetPasswordSchema,
} from './auth.schema';
import { ResponseType } from '../common/response/response.util';
import { RateLimit } from './decorators/rate-limit.decorator';
import { RequireCaptcha } from './decorators/require-captcha.decorator';
import { ConfigService } from '@nestjs/config';
import { NoActiveSessionGuard } from './guards/no-active-session.guard';
import { rateLimitSubject } from '../common/security/service-caller';
import {
  refreshCookieOptions,
  withRefreshCookie,
} from '../common/http/refresh-cookie';
import { readCookie } from '../common/http/cookies';
import { resolveSwitchScope } from '../common/security/switch-scope';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private ua(req: Request) {
    return req.get('user-agent') ?? 'unknown';
  }

  // Resolved by LanguageMiddleware from Accept-Language; always defined.
  private lang(req: Request): string {
    return (req as any).language ?? 'fa';
  }

  @Post('login/password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NoActiveSessionGuard)
  @UsePipes(new ZodValidationPipe(passwordLoginSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.LOGIN_PWD, rateLimitSubject(req)),
    configKey: 'LOGIN_PWD_RATE_LIMIT',
    windowSec: 900,
  })
  async login(
    @Body() body: any,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.loginWithPassword(
      body,
      ip,
      this.ua(req),
      this.lang(req),
      resolveSwitchScope(req),
    );
    return this.withRefreshCookie(res, result);
  }

  // 202, not 200 (F-067-a): the code has been accepted for delivery, not
  // delivered. What became of it is `otp/delivery/status`.
  @Post('login/otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(NoActiveSessionGuard)
  @UsePipes(new ZodValidationPipe(otpRequestSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.LOGIN_OTP_REQUEST, rateLimitSubject(req)),
    configKey: 'LOGIN_OTP_REQUEST_RATE_LIMIT',
    windowSec: 900,
  })
  requestOtp(@Body() body: any, @Ip() ip: string, @Req() req: Request) {
    return this.auth.requestLoginOtp(
      body.phoneNumber,
      body.channel,
      ip,
      this.lang(req),
    );
  }

  @Post('login/otp/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NoActiveSessionGuard)
  @UsePipes(new ZodValidationPipe(otpVerifySchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.LOGIN_OTP_VERIFY, rateLimitSubject(req)),
    configKey: 'LOGIN_OTP_VERIFY_RATE_LIMIT',
    windowSec: 900,
  })
  async verifyOtp(
    @Body() body: any,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verifyLoginOtp(
      body,
      ip,
      this.ua(req),
      resolveSwitchScope(req),
    );
    return this.withRefreshCookie(res, result);
  }

  /**
   * Is this visitor signed in? Read-only, and the only route that answers it.
   *
   * `refresh` used to double as this question, but refreshing rotates: it
   * revoked the caller's session and minted a replacement, so a probe that
   * discarded the rotated `Set-Cookie` left the browser with a dead cookie it
   * still displayed as present. `panel-web`'s proxy (F-0101) asks this instead.
   *
   * A dead token is still cleared here — it can never succeed again, and every
   * later page load would otherwise pay for the same answer.
   */
  @Get('session')
  @HttpCode(HttpStatus.OK)
  async session(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = readCookie(req.headers.cookie, REFRESH_TOKEN_COOKIE);
    const result = await this.auth.sessionStatus(token);
    const active = result.ok && result.data.active;
    if (token && !active) {
      res.clearCookie(REFRESH_TOKEN_COOKIE, this.cookieOptions());
    }
    return result;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(refreshSchema))
  async refresh(
    @Body() body: any,
    @Req() req: Request,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token =
      body.refreshToken ?? readCookie(req.headers.cookie, REFRESH_TOKEN_COOKIE);
    const result = await this.auth.refresh(
      { refreshToken: token },
      ip,
      this.ua(req),
    );
    // A refresh token that no longer resolves to a live session is dead weight:
    // it can never succeed again (revoked, expired, or unknown), and leaving it
    // in the browser makes every later page load pay for the same answer —
    // panel-web's auth-screen check reads exactly this cookie. Drop it.
    if (!result?.ok) res.clearCookie(REFRESH_TOKEN_COOKIE, this.cookieOptions());
    return this.withRefreshCookie(res, result);
  }

  /**
   * Sign out of the account this token names.
   *
   * ADR-0035: when the place still holds another account the user has already
   * proved, this **falls back onto it** and answers with that account's
   * session — the cookie is replaced rather than cleared. Signing out of the
   * place entirely is `logout/all`, deliberately a different route.
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(logoutSchema))
  async logout(
    @Body() body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token =
      body.refreshToken ?? readCookie(req.headers.cookie, REFRESH_TOKEN_COOKIE);
    const result: any = await this.auth.logout({ refreshToken: token });

    // A fallback mints a session, so the cookie carries the new refresh token
    // instead of being cleared. Clearing it and *then* setting it would leave
    // two `Set-Cookie` headers for one name, whose winner is the client's
    // choice rather than ours.
    if (result?.ok && result.data?.switchedTo) {
      return this.withRefreshCookie(res, result);
    }
    res.clearCookie(REFRESH_TOKEN_COOKIE, this.cookieOptions());
    return result;
  }

  /**
   * Sign out of **every** account this place holds (`F-0211`, ADR-0035).
   *
   * Its own route because it is its own intention: ordinary logout is "I am
   * done with this account", this is "I am handing this device over". Every
   * surface puts it somewhere deliberate — never next to the ordinary one.
   */
  @Post('logout/all')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(logoutSchema))
  async logoutAll(
    @Body() body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token =
      body.refreshToken ?? readCookie(req.headers.cookie, REFRESH_TOKEN_COOKIE);
    const result = await this.auth.logoutEverywhere({ refreshToken: token });
    res.clearCookie(REFRESH_TOKEN_COOKIE, this.cookieOptions());
    return result;
  }

  // 202 for the reason `login/otp/request` is (F-067-a).
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(forgotPasswordSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.PASSWORD_FORGOT, rateLimitSubject(req)),
    configKey: 'PASSWORD_FORGOT_RATE_LIMIT',
    windowSec: 900,
  })
  forgot(@Body() body: any, @Ip() ip: string, @Req() req: Request) {
    return this.auth.forgotPassword(body, ip, this.lang(req));
  }

  @Post('password/forgot/verify-otp')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(forgotVerifySchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.PASSWORD_FORGOT_VERIFY, rateLimitSubject(req)),
    configKey: 'FORGOT_VERIFY_RATE_LIMIT',
    windowSec: 900,
  })
  verifyForgot(@Body() body: any) {
    return this.auth.verifyForgotPassword(body);
  }

  // Answers "which delivery methods can I offer the user?" — the set is
  // environment-driven (`OTP_ALLOWED_CHANNELS` + whether each one is actually
  // configured), so a client must ask rather than hard-code sms/telegram/bale.
  /**
   * What became of one OTP send (F-067-a).
   *
   * The fallback D-15 keeps for ever: once F-067-j lands, the result arrives on
   * the user's socket and a client stops polling this — but a client that
   * reconnects, or never opened a socket, still reads it once.
   *
   * `POST`, so the delivery id stays out of access logs and referrers, and
   * unauthenticated because `login` and `register` have no session yet. The id
   * is the only credential it needs: it was handed out exactly once, in the
   * 202 for the request that minted it.
   */
  @Post('otp/delivery/status')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(otpDeliveryStatusSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.OTP_DELIVERY_STATUS, rateLimitSubject(req)),
    configKey: 'OTP_DELIVERY_STATUS_RATE_LIMIT',
    windowSec: 900,
  })
  otpDeliveryStatus(@Body() body: any) {
    return this.auth.otpDeliveryStatus(body.deliveryId);
  }

  @Get('otp/channels')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.OTP_CHANNELS, rateLimitSubject(req)),
    configKey: 'OTP_CHANNELS_RATE_LIMIT',
    windowSec: 900,
  })
  otpChannels() {
    return this.auth.otpChannels();
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(resetPasswordSchema))
  async reset(
    @Body() body: any,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The reset revoked every session this user had; the response carries a
    // new one for the device that performed it, so "all other devices are
    // signed out" is true without also signing this one out.
    const result = await this.auth.resetPassword(
      body,
      ip,
      this.ua(req),
      resolveSwitchScope(req),
    );
    return this.withRefreshCookie(res, result);
  }

  // Both live in common/http/refresh-cookie.ts now: account-switch mints
  // sessions too (F-0207), and two definitions of this cookie would mean two
  // cookies in the browser.
  private withRefreshCookie(res: Response, result: any) {
    return withRefreshCookie(res, result);
  }

  private cookieOptions() {
    return refreshCookieOptions();
  }
}
