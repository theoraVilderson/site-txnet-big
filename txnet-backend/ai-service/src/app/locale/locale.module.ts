import { Global, Module } from '@nestjs/common';

import { LanguageMiddleware } from './language.middleware';
import { LocaleService } from './locale.service';

@Global()
@Module({
  providers: [LocaleService, LanguageMiddleware],
  exports: [LocaleService, LanguageMiddleware],
})
export class LocaleModule {}
