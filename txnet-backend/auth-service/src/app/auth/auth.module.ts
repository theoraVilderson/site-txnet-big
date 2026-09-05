import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { CaptchaGuard } from '../common/guards/captcha.guard';
import { RegisterController } from './register/register.controller';
import { RegisterService } from './register/register.service';
import { OTP_SERVICE } from './otp/otp.interface';
import { OtpService } from './otp/otp.service';
import { SmsOtpSender } from './otp/senders/sms.sender';
import { BaleOtpSender } from './otp/senders/bale.sender';
import { TelegramOtpSender } from './otp/senders/telegram.sender';
import { TokenService } from './token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { SessionService } from './session/session.service';
import { SessionStore } from './session/session.store';
import { OtpStore } from './otp/otp.store';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { LocaleModule } from '../locale/locale.module';
import { CaptchaController } from './captcha/captcha.controller';
import { CaptchaService } from './captcha/captcha.service';

@Module({
  // Required because LocaleModule is not @Global(): SmsOtpSender,
  // BaleOtpSender and TelegramOtpSender now inject LocaleService to build
  // OTP messages in the request's language.
  imports: [LocaleModule],
  controllers: [RegisterController, AuthController, CaptchaController],
  providers: [
    RegisterService,
    TokenService,
    AuthService,
    AuthGuard,
    SessionService,
    SessionStore,
    OtpStore,
    RateLimiter,
    CaptchaService,
    SmsOtpSender,
    BaleOtpSender,
    TelegramOtpSender,
    {
      provide: OTP_SERVICE,
      useClass: OtpService,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CaptchaGuard,
    },
  ],
  exports: [AuthGuard, TokenService, SessionService, SessionStore, AuthService],
})
export class AuthModule {}
