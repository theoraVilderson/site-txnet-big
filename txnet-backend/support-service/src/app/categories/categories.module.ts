import { Module } from '@nestjs/common';

import { SupportCategories } from './categories';
import { SupportCategoriesController } from './categories.controller';

/** A tenant's support categories (F-033-e, ADR-0112 point 6). */
@Module({
  controllers: [SupportCategoriesController],
  providers: [SupportCategories],
})
export class SupportCategoriesModule {}
