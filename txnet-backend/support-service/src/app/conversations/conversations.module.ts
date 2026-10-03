import { Module } from '@nestjs/common';

import { SupportConversationsController } from './conversations.controller';
import { SupportConversationService } from './conversations.service';

@Module({
  controllers: [SupportConversationsController],
  providers: [SupportConversationService],
})
export class SupportConversationsModule {}
