import { forwardRef, Module } from '@nestjs/common';
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
import { EmailOtpSender } from './otp/senders/email.sender';
import { TokenService } from './token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SecondFactorService } from './second-factor.service';
import { SurfaceOwnerService } from './surface-owner/surface-owner.service';
import { AuthGuard } from './auth.guard';
import { NoActiveSessionGuard } from './guards/no-active-session.guard';
import { SessionService } from './session/session.service';
import { SessionStore } from './session/session.store';
import { ActiveSessionsController } from './session/active-sessions.controller';
import { ActiveSessionsService } from './session/active-sessions.service';
import { OtpStore } from './otp/otp.store';
import { OtpDeliveryStore } from './otp/otp-delivery.store';
import { OtpDeliveryPublisher } from './otp/otp-delivery.publisher';
import { OtpInternalController } from './otp/otp-internal.controller';
import { UserNotifyInternalController } from './notify/user-notify-internal.controller';
import { NotificationInboxClient } from './notify/notification-inbox.client';
import { UserNotifier } from './notify/user-notifier';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import { RATE_LIMIT_STORE, ResellerAccess } from '@txnet-backend/shared-core';
import { RedisService } from '../redis/redis.service';
import { LocaleModule } from '../locale/locale.module';
import { MessengerModule } from '@txnet-backend/messenger';
import { AutomationModule } from '../automation/automation.module';
import { VaultModule } from '../tenant/vault/vault.module';
import { CaptchaController } from './captcha/captcha.controller';
import { CaptchaService } from './captcha/captcha.service';
import { MeController } from './me/me.controller';
import { HandoffController } from './handoff/handoff.controller';
import { HandoffService } from './handoff/handoff.service';
import { RolesController } from './roles/roles.controller';
import { TenantRolesController } from './roles/tenant-roles.controller';
import { PermissionRegistryController } from './permissions/permission-registry.controller';
import { PermissionRegistryService } from './permissions/permission-registry.service';
import { TenantRolesService } from './roles/tenant-roles.service';
import { WildcardHoldersWatch } from './roles/superadmin-cap';
import { RolesService } from './roles/roles.service';
import { UserSearchController } from './users/user-search.controller';
import { ResellerUsersController } from './users/reseller-users.controller';
import { UserStatusController } from './users/user-status.controller';
import { UserStatusService } from './users/user-status.service';
import { ResellerUsersService } from './users/reseller-users.service';
import { UserSearchService } from './users/user-search.service';
import { MeService } from './me/me.service';
import { MeEmailService } from './me/me-email.service';
import { MeMessengerService } from './me/me-messenger.service';
import { MeTimeZoneService } from './me/me-time-zone.service';
import { MeAccountService } from './me/me-account.service';
import { AccessReader } from './permissions/access.reader';
import { KeyWindowInternalController } from './permissions/key-window-internal.controller';
import { KeyWindowSweep } from './permissions/key-window.sweep';
import { PermissionStateStore } from './permissions/permission-state.store';
import {
  PERMISSIONS_LISTEN_CLIENT,
  PermissionNotificationsListener,
} from './permissions/permission-notifications.listener';
import { Client } from 'pg';
import { ConfigService } from '@nestjs/config';

@Module({
  // Required because LocaleModule is not @Global(): SmsOtpSender,
  // BaleOtpSender and TelegramOtpSender now inject LocaleService to build
  // OTP messages in the request's language.
  // MessengerModule supplies the Telegram/Bale driver (BotClientRegistry) —
  // OTP delivery and the account-link flow are both consumers of it, which is
  // why it is a shared platform library and not part of this service (ADR-0009).
  // Its integration directory is this process's own: here the schema and the
  // vault are in reach, so `automation` answers directly rather than over the
  // service seam `bot-service` has to use (F-320).
  imports: [
    LocaleModule,
    // SmsOtpSender reads the platform owner's SMS line from the vault (F-018-a).
    VaultModule,
    // `forwardRef` on both sides: this module needs `AuthBrokerPublisher`
    // (F-067-a) and `AutomationModule` needs `AuthGuard`'s dependencies for
    // its admin controller (F-031-b).
    forwardRef(() => AutomationModule),
    MessengerModule.forRoot({ imports: [AutomationModule] }),
  ],
  controllers: [
    RegisterController,
    AuthController,
    CaptchaController,
    BotLinkController,
    OtpInternalController,
    UserNotifyInternalController,
    MeController,
    HandoffController,
    RolesController,
    TenantRolesController,
    PermissionRegistryController,
    UserSearchController,
    ResellerUsersController,
    UserStatusController,
    ActiveSessionsController,
    KeyWindowInternalController,
  ],
  providers: [
    UserNotifier,
    NotificationInboxClient,
    RegisterService,
    TokenService,
    MeService,
    HandoffService,
    RolesService,
    TenantRolesService,
    WildcardHoldersWatch,
    PermissionRegistryService,
    UserSearchService,
    ResellerUsersService,
    UserStatusService,
    // The one door on a route that names a reseller (F-066-w1). `PrismaModule`
    // binds `RESELLER_ACCESS_READER` to this service's app pool.
    ResellerAccess,
    MeEmailService,
    MeMessengerService,
    MeTimeZoneService,
    MeAccountService,
    AuthService,
    SecondFactorService,
    SurfaceOwnerService,
    AuthGuard,
    PermissionStateStore,
    AccessReader,
    KeyWindowSweep,
    PermissionNotificationsListener,
    // One `pg` client per connection attempt, as the running service's own
    // least-privileged login — LISTEN needs no grant, and the owner connection
    // is never used by a running process (F-066-m-a). `DATABASE_LISTEN_URL` is
    // that login direct to main-db: LISTEN does not survive db-pool (H8).
    {
      provide: PERMISSIONS_LISTEN_CLIENT,
      useFactory: (config: ConfigService) => () =>
        new Client({ connectionString: config.get<string>('DATABASE_LISTEN_URL') }),
      inject: [ConfigService],
    },
    NoActiveSessionGuard,
    ServiceOnlyGuard,
    SessionService,
    SessionStore,
    ActiveSessionsService,
    OtpStore,
    OtpDeliveryStore,
    OtpDeliveryPublisher,
    RateLimiter,
    // The limiter lives in shared-core (F-092-r) and counts in this service's Redis.
    { provide: RATE_LIMIT_STORE, useExisting: RedisService },
    CaptchaService,
    SmsOtpSender,
    BaleOtpSender,
    TelegramOtpSender,
    EmailOtpSender,
    // The one place the concrete senders are named. `OtpChannelRegistry` takes
    // the array and keys it by each sender's own `channel`, so a new messenger
    // is a class plus a line here (plus the `OtpChannel` enum migration).
    {
      provide: OTP_SENDERS,
      useFactory: (
        sms: SmsOtpSender,
        bale: BaleOtpSender,
        telegram: TelegramOtpSender,
        email: EmailOtpSender,
      ) => [sms, bale, telegram, email],
      inject: [SmsOtpSender, BaleOtpSender, TelegramOtpSender, EmailOtpSender],
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
  // PermissionStateStore is exported with AuthGuard for the reason TokenService
  // and SessionStore are: a module that puts AuthGuard on a controller has to
  // be able to resolve every one of its dependencies (F-031-b).
  exports: [AuthGuard, TokenService, OTP_SERVICE, SessionService, SessionStore, PermissionStateStore, AccessReader, AuthService, SurfaceOwnerService],
})
export class AuthModule {}
