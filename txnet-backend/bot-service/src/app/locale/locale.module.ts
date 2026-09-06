import { Global, Module } from '@nestjs/common';
import { LocaleService } from './locale.service';
import { BotCopy } from './bot-copy';
import { ChatLanguage } from './chat-language';

@Global()
@Module({
  providers: [LocaleService, BotCopy, ChatLanguage],
  exports: [LocaleService, BotCopy, ChatLanguage],
})
export class LocaleModule {}
