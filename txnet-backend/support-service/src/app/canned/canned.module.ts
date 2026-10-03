import { Module } from '@nestjs/common';

import { SupportCannedReplies } from './canned';
import { SupportCannedAgentController, SupportCannedSettingsController } from './canned.controller';

/** Canned replies (F-033-j, catalog §11.3). */
@Module({
  controllers: [SupportCannedAgentController, SupportCannedSettingsController],
  providers: [SupportCannedReplies],
})
export class SupportCannedModule {}
