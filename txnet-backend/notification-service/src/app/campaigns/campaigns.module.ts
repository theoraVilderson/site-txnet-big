import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthApiBotIntegrationDirectory, BOT_INTEGRATION_DIRECTORY, MessengerModule } from '@txnet-backend/messenger';

import { CampaignAdminController } from './campaign-admin.controller';
import { CampaignAdminService } from './campaign-admin.service';
import { CampaignDeliveryService } from './campaign-delivery.service';
import { CampaignFanOutService } from './campaign-fan-out.service';
import { CampaignInternalController } from './campaign-internal.controller';
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
 * and Bale (F-035-e) and by SMS (F-035-f); the ticks that drive the last two are `worker-service`'s.
 */
@Module({
  imports: [MessengerModule.forRoot({ imports: [BotDirectoryModule] })],
  controllers: [CampaignAdminController, CampaignInternalController],
  providers: [
    CampaignAdminService,
    CampaignFanOutService,
    CampaignDeliveryService,
    { provide: SmsLineResolver, useFactory: SmsLineResolver.fromConfig, inject: [ConfigService] },
  ],
})
export class CampaignsModule {}
