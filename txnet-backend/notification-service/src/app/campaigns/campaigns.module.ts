import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CredentialEnvGuard,
  CredentialVaultService,
  KekService,
  TRANSLATOR,
  VAULT_DB,
  translatorFromEnv,
} from '@txnet-backend/shared-core';
import { AuthApiBotIntegrationDirectory, BOT_INTEGRATION_DIRECTORY, MessengerModule, SEND_RATE_STORE } from '@txnet-backend/messenger';

import { LocaleModule } from '../locale/locale.module';
import { CampaignAdminController } from './campaign-admin.controller';
import { CampaignAdminService } from './campaign-admin.service';
import { CampaignDeliveryService } from './campaign-delivery.service';
import { CampaignFanOutService } from './campaign-fan-out.service';
import { CampaignInternalController } from './campaign-internal.controller';
import { CampaignTextService } from './campaign-texts';
import { MailLineResolver } from './mail-line';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { RedisService } from '../redis/redis.service';
import { SmsLineSource } from './sms-line';

/**
 * `messenger`'s directory in this service: `auth-service` answers over the seam
 * (F-320), and the vault audit rows name `notification-service` (F-035-e).
 */
@Module({
  providers: [
    {
      provide: BOT_INTEGRATION_DIRECTORY,
      useFactory: (config: ConfigService) => new AuthApiBotIntegrationDirectory(config, 'notification-service'),
      inject: [ConfigService],
    },
  ],
  exports: [BOT_INTEGRATION_DIRECTORY],
})
class BotDirectoryModule {}

/**
 * The Redis the outbound pacer counts in (F-313-a, ADR-0066).
 *
 * This is the one app that binds it, because it is the one that sends in bulk.
 * `messenger` cannot hold a client of its own — four apps import it, each with
 * its own connection and keyspace prefix — so it takes this seam instead, the
 * same way `RateLimitStore` does. `RedisService` already has the one method it
 * asks for, and `RedisModule` is global, so this is a binding and not a wiring.
 */
@Module({
  providers: [{ provide: SEND_RATE_STORE, useExisting: RedisService }],
  exports: [SEND_RATE_STORE],
})
class SendRateModule {}

/**
 * Campaign drafts (F-035-c), sending them (F-035-d) and delivering to Telegram
 * and Bale (F-035-e), by SMS (F-035-f) and by email in each recipient's language
 * (F-035-h); the ticks that drive the last two are `worker-service`'s.
 */
@Module({
  imports: [MessengerModule.forRoot({ imports: [BotDirectoryModule, SendRateModule] }), LocaleModule],
  controllers: [CampaignAdminController, CampaignInternalController],
  providers: [
    CampaignAdminService,
    CampaignFanOutService,
    CampaignDeliveryService,
    CampaignTextService,
    // An SMS line is a tenant's vault values — the owner's (F-018-a, ADR-0039)
    // or a reseller's own (F-035-i-a): read-only, on the cross-tenant pool
    // delivery already runs on, since a run has no request tenant. `CredentialEnvGuard` comes with the vault.
    KekService,
    CredentialVaultService,
    CredentialEnvGuard,
    { provide: VAULT_DB, useExisting: CrossTenantPrismaService },
    {
      provide: SmsLineSource,
      useFactory: (config: ConfigService, vault: CredentialVaultService, db: CrossTenantPrismaService) => new SmsLineSource(config, vault, db),
      inject: [ConfigService, CredentialVaultService, CrossTenantPrismaService],
    },
    { provide: MailLineResolver, useFactory: MailLineResolver.fromConfig, inject: [ConfigService] },
    // Drafts campaign texts (F-035-h), as billing's catalog does (ADR-0050).
    { provide: TRANSLATOR, useFactory: () => translatorFromEnv() },
  ],
})
export class CampaignsModule {}
