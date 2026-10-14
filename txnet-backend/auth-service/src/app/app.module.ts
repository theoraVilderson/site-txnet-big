import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { TenantAgnostic } from './tenant/tenant-agnostic.decorator';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { AccountSwitchModule } from './account-switch/account-switch.module';
import { LocaleModule } from './locale/locale.module';
import { TenantModule } from './tenant/tenant.module';
import { AutomationModule } from './automation/automation.module';
import { WebhookRotationModule } from './automation/webhook-rotation.module';
import { ResellerBotModule } from './automation/reseller-bot.module';
import { AccessHistoryModule } from './access-history/access-history.module';
import { SupportConsentModule } from './support-consent/support-consent.module';
import { VaultModule } from './tenant/vault/vault.module';
import { UserGroupModule } from './governance/user-groups/user-group.module';
import { UiPreferencesModule } from './governance/ui-preferences/ui-preferences.module';
import { UserRestrictionsModule } from './governance/user-restrictions/user-restrictions.module';
import { LanguageMiddleware } from './common/middlewares/language.middleware';
import { ServiceCallerMiddleware } from './common/security/service-caller';
import { SwitchScopeMiddleware } from './common/security/switch-scope.middleware';
import { TenantMiddleware } from './common/middlewares/tenant.middleware';
import { TenantContextMiddleware } from './tenant-context/tenant-context.middleware';
import { JsonLoggerModule, HealthModule } from '@txnet-backend/shared-core';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    JsonLoggerModule,
    PrismaModule,
    // The container check (hosting H15) has no tenant host to resolve.
    HealthModule.withPool(PrismaService, TenantAgnostic()),
    RedisModule,
    AuthModule,
    AccountSwitchModule,
    LocaleModule,
    TenantModule,
    VaultModule,
    AutomationModule,
    WebhookRotationModule,
    ResellerBotModule,
    SupportConsentModule,
    AccessHistoryModule,
    UserGroupModule,
    UiPreferencesModule,
    UserRestrictionsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // ServiceCallerMiddleware runs on every route: the guards and the
    // rate-limit keys below read what it decided, so it cannot be optional.
    // TenantMiddleware reads it for a bot's claim; every route needs the
    // tenant already resolved (ADR-0020). SwitchScopeMiddleware follows both —
    // it tells a bot chat from a browser, mints the browser's `device_id`
    // (ADR-0015) and keys a chat by its bot's tenant (F-061-g).
    // TenantContextMiddleware then opens the ambient scope that resolution
    // feeds, so everything downstream — including the guards and pipes on a
    // route — can read it without being handed it (ADR-0024).
    consumer
      .apply(
        ServiceCallerMiddleware,
        TenantMiddleware,
        SwitchScopeMiddleware,
        TenantContextMiddleware,
        LanguageMiddleware,
      )
      // The container check (hosting H15) asks from inside, with no tenant host.
      .exclude('health')
      .forRoutes('{*path}');
  }
}
