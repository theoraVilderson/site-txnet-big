import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { CaptchaGuard } from '../common/guards/captcha.guard';
import { ServiceOnlyGuard } from '../common/guards/service-only.guard';
import { RegisterController } from './register/register.controller';
import { RegisterService } from './register/register.service';
import { OTP_SERVICE } from './otp/otp.interface';
import { OTP_SENDERS } from './otp/senders/otp-sender.interface';
import { OtpService } from './otp/otp.service';
import { OtpChannelRegistry } from './otp/otp-channels.service';
import { BotLinkController } from './bot-link/bot-link.controller';
import { BotLinkService } from './bot-link/bot-link.service';
import { BotSessionService } from './bot-link/bot-session.service';
import { BotLinkStore } from './bot-link/bot-link.store';
import { SmsOtpSender } from './otp/senders/sms.sender';
import { BaleOtpSender } from './otp/senders/bale.sender';
import { TelegramOtpSender } from './otp/senders/telegram.sender';
import { TokenService } from './token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { NoActiveSessionGuard } from './guards/no-active-session.guard';
import { SessionService } from './session/session.service';
import { SessionStore } from './session/session.store';
import { OtpStore } from './otp/otp.store';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { LocaleModule } from '../locale/locale.module';
import { MessengerModule } from '@txnet-backend/messenger';
import { CaptchaController } from './captcha/captcha.controller';
import { CaptchaService } from './captcha/captcha.service';

@Module({
  // Required because LocaleModule is not @Global(): SmsOtpSender,
  // BaleOtpSender and TelegramOtpSender now inject LocaleService to build
  // OTP messages in the request's language.
  // MessengerModule supplies the Telegram/Bale driver (BotClientRegistry) —
  // OTP delivery and the account-link flow are both consumers of it, which is
  // why it is a shared platform library and not part of this service (ADR-0009).
  imports: [LocaleModule, MessengerModule],
  controllers: [
    RegisterController,
    AuthController,
    CaptchaController,
    BotLinkController,
  ],
  providers: [
    RegisterService,
    TokenService,
    AuthService,
    AuthGuard,
    NoActiveSessionGuard,
    ServiceOnlyGuard,
    SessionService,
    SessionStore,
    OtpStore,
    RateLimiter,
    CaptchaService,
    SmsOtpSender,
    BaleOtpSender,
    TelegramOtpSender,
    // The one place the concrete senders are named. `OtpChannelRegistry` takes
    // the array and keys it by each sender's own `channel`, so a new messenger
    // is a class plus a line here (plus the `OtpChannel` enum migration).
    {
      provide: OTP_SENDERS,
      useFactory: (
        sms: SmsOtpSender,
        bale: BaleOtpSender,
        telegram: TelegramOtpSender,
      ) => [sms, bale, telegram],
      inject: [SmsOtpSender, BaleOtpSender, TelegramOtpSender],
    },
    OtpChannelRegistry,
    BotLinkService,
    BotSessionService,
    BotLinkStore,
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
