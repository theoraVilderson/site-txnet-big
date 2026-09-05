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
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import {
  forgotPasswordSchema,
  forgotVerifySchema,
  logoutSchema,
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
    key: (req) => `login:pwd:${req.ip}`,
    limit: 20,
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
    );
    return this.withRefreshCookie(res, result);
  }

  @Post('login/otp/request')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NoActiveSessionGuard)
  @UsePipes(new ZodValidationPipe(otpRequestSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => `login:otp:req:${req.ip}`,
    limit: 10,
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
    key: (req) => `login:otp:verify:${req.ip}`,
    limit: 20,
    windowSec: 900,
  })
  async verifyOtp(
    @Body() body: any,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verifyLoginOtp(body, ip, this.ua(req));
    return this.withRefreshCookie(res, result);
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
      body.refreshToken ?? readCookie(req.headers.cookie, 'refresh_token');
    const result = await this.auth.refresh(
      { refreshToken: token },
      ip,
      this.ua(req),
    );
    // A refresh token that no longer resolves to a live session is dead weight:
    // it can never succeed again (revoked, expired, or unknown), and leaving it
    // in the browser makes every later page load pay for the same answer —
    // panel-web's auth-screen check reads exactly this cookie. Drop it.
    if (!result?.ok) res.clearCookie('refresh_token', this.cookieOptions());
    return this.withRefreshCookie(res, result);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(logoutSchema))
  async logout(
    @Body() body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token =
      body.refreshToken ?? readCookie(req.headers.cookie, 'refresh_token');
    const result = await this.auth.logout({ refreshToken: token });
    res.clearCookie('refresh_token', this.cookieOptions());
    return result;
  }

  @Post('password/forgot')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(forgotPasswordSchema))
  @RequireCaptcha()
  @RateLimit({
    key: (req) => `pwd:forgot:${req.ip}`,
    limit: 10,
    windowSec: 900,
  })
  forgot(@Body() body: any, @Ip() ip: string, @Req() req: Request) {
    return this.auth.forgotPassword(body, ip, this.lang(req));
  }

  @Post('password/forgot/verify-otp')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(forgotVerifySchema))
  @RateLimit({
    key: (req) => `pwd:forgot:verify:${req.ip}`,
    limit: 20,
    windowSec: 900,
  })
  verifyForgot(@Body() body: any) {
    return this.auth.verifyForgotPassword(body);
  }

  // Answers "which delivery methods can I offer the user?" — the set is
  // environment-driven (`OTP_ALLOWED_CHANNELS` + whether each one is actually
  // configured), so a client must ask rather than hard-code sms/telegram/bale.
  @Get('otp/channels')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => `otp:channels:${req.ip}`,
    limit: 60,
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
    const result = await this.auth.resetPassword(body, ip, this.ua(req));
    return this.withRefreshCookie(res, result);
  }

  private async withRefreshCookie(res: Response, result: any) {
    if (result?.ok && result?.data?.refreshToken) {
      res.cookie(
        'refresh_token',
        result.data.refreshToken,
        this.cookieOptions(),
      );
      const { refreshToken, ...restData } = result.data;
      result.data = restData;
    }
    return result;
  }

  private cookieOptions() {
    const DOMAINNAME = process.env.DOMAIN_NAME!;

    return {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE !== 'false',
      sameSite: 'lax' as const,
      path: '/', // تغییر اول
      domain: `.${DOMAINNAME}`, // تغییر دوم
      maxAge: 30 * 24 * 60 * 60 * 1000,
    };
  }
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  const value = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : undefined;
}
