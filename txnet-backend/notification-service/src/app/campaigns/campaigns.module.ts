import { Module } from '@nestjs/common';

import { CampaignAdminController } from './campaign-admin.controller';
import { CampaignAdminService } from './campaign-admin.service';

/** Campaign drafts (F-035-c). The fan-out that sends them is `worker-service`'s (F-035-d). */
@Module({
  controllers: [CampaignAdminController],
  providers: [CampaignAdminService],
})
export class CampaignsModule {}
