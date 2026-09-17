import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TRANSLATOR, translatorFromEnv } from '@txnet-backend/shared-core';
import { AuthApiBotIntegrationDirectory, BOT_INTEGRATION_DIRECTORY, MessengerModule } from '@txnet-backend/messenger';

import { LocaleModule } from '../locale/locale.module';
import { CampaignAdminController } from './campaign-admin.controller';
import { CampaignAdminService } from './campaign-admin.service';
import { CampaignDeliveryService } from './campaign-delivery.service';
import { CampaignFanOutService } from './campaign-fan-out.service';
import { CampaignInternalController } from './campaign-internal.controller';
import { CampaignTextService } from './campaign-texts';
import { MailLineResolver } from './mail-line';
import { SmsLineResolver } from './sms-line';

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
 * (F-035-h); the ticks that drive the last two are `worker-service`'s.
 */
@Module({
  imports: [MessengerModule.forRoot({ imports: [BotDirectoryModule] }), LocaleModule],
  controllers: [CampaignAdminController, CampaignInternalController],
  providers: [
    CampaignAdminService,
    CampaignFanOutService,
    CampaignDeliveryService,
    CampaignTextService,
    { provide: SmsLineResolver, useFactory: SmsLineResolver.fromConfig, inject: [ConfigService] },
    { provide: MailLineResolver, useFactory: MailLineResolver.fromConfig, inject: [ConfigService] },
    // Drafts campaign texts (F-035-h), as billing's catalog does (ADR-0050).
    { provide: TRANSLATOR, useFactory: () => translatorFromEnv() },
  ],
})
export class CampaignsModule {}
