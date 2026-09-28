import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CredentialEnvGuard,
  ResellerAccess,
  CredentialVaultService,
  KekService,
  TRANSLATOR,
  VAULT_DB,
  translatorFromEnv,
} from '@txnet-backend/shared-core';
import { AuthApiBotIntegrationDirectory, BOT_INTEGRATION_DIRECTORY, MessengerModule } from '@txnet-backend/messenger';

import { LocaleModule } from '../locale/locale.module';
import { CampaignAdminController } from './campaign-admin.controller';
import { CampaignAdminService } from './campaign-admin.service';
import { CampaignDeliveryService } from './campaign-delivery.service';
import { CampaignFanOutService } from './campaign-fan-out.service';
import { CampaignInternalController } from './campaign-internal.controller';
import { CampaignTextService } from './campaign-texts';
import { MailLineResolver } from './mail-line';
import { NoticeSmsController } from './notice-sms.controller';
import { NoticeSmsService } from './notice-sms';
import { ResellerCampaignController } from './reseller-campaign.controller';
import { ResellerCampaignService } from './reseller-campaign.service';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
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
 * Campaign drafts (F-035-c), sending them (F-035-d) and delivering to Telegram
 * and Bale (F-035-e), by SMS (F-035-f) and by email in each recipient's language
 * (F-035-h); the ticks that drive the last two are `worker-service`'s. A
 * reseller reaches the same rules for itself through F-313-d's own door. A
 * notice's SMS (F-601-t) takes the same line through `NoticeSmsService`.
 */
@Module({
  imports: [MessengerModule.forRoot({ imports: [BotDirectoryModule] }), LocaleModule],
  controllers: [CampaignAdminController, ResellerCampaignController, CampaignInternalController, NoticeSmsController],
  providers: [
    CampaignAdminService,
    // A reseller acting for itself (F-313-d): admitted by the door, then served
    // by `CampaignAdminService` with the reseller as the actor's tenant.
    ResellerCampaignService,
    ResellerAccess,
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
    // A notice's SMS (F-601-t) goes out on the same line a campaign's would, chosen by the same resolver.
    {
      provide: NoticeSmsService,
      useFactory: (lines: SmsLineSource, db: CrossTenantPrismaService) => new NoticeSmsService(lines, db),
      inject: [SmsLineSource, CrossTenantPrismaService],
    },
    { provide: MailLineResolver, useFactory: MailLineResolver.fromConfig, inject: [ConfigService] },
    // Drafts campaign texts (F-035-h), as billing's catalog does (ADR-0050).
    { provide: TRANSLATOR, useFactory: () => translatorFromEnv() },
  ],
})
export class CampaignsModule {}
