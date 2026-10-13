import { Module } from '@nestjs/common';

import { LocaleModule } from '../locale/locale.module';
import { SupportCannedReplies } from './canned';
import { SupportCannedAgentController, SupportCannedSettingsController } from './canned.controller';

/** Canned replies (F-033-j, catalog §11.3). */
@Module({
  imports: [LocaleModule],
  controllers: [SupportCannedAgentController, SupportCannedSettingsController],
  providers: [SupportCannedReplies],
})
export class SupportCannedModule {}
