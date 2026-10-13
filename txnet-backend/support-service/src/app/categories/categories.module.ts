import { Module } from '@nestjs/common';

import { LocaleModule } from '../locale/locale.module';
import { SupportCategories } from './categories';
import { SupportCategoriesController } from './categories.controller';

/** A tenant's support categories (F-033-e, ADR-0112 point 6). */
@Module({
  imports: [LocaleModule],
  controllers: [SupportCategoriesController],
  providers: [SupportCategories],
})
export class SupportCategoriesModule {}
