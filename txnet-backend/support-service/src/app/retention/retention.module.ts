import { Module } from '@nestjs/common';

import { SupportConversationsModule } from '../conversations/conversations.module';
import { SupportRetentionInternalController } from './retention.controller';
import { SupportRetention } from './retention';

/** Retention: expired files and archived months (F-033-n). */
@Module({
  imports: [SupportConversationsModule],
  controllers: [SupportRetentionInternalController],
  providers: [SupportRetention],
})
export class SupportRetentionModule {}
