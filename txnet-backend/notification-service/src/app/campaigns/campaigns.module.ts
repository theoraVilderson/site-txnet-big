import { Module } from '@nestjs/common';

import { CampaignAdminController } from './campaign-admin.controller';
import { CampaignAdminService } from './campaign-admin.service';
import { CampaignFanOutService } from './campaign-fan-out.service';
import { CampaignInternalController } from './campaign-internal.controller';

/** Campaign drafts (F-035-c) and sending them (F-035-d); the tick that drives the fan-out is `worker-service`'s. */
@Module({
  controllers: [CampaignAdminController, CampaignInternalController],
  providers: [CampaignAdminService, CampaignFanOutService],
})
export class CampaignsModule {}
