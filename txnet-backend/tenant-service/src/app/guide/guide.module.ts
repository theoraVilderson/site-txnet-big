import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module';
import { LocaleModule } from '../locale/locale.module';
import { GuideAdmin } from './guide-admin';
import { GuideAdminController } from './guide-admin.controller';
import { GuideFeedbackController } from './guide-feedback.controller';
import { GuideFileSweep } from './guide-file-sweep';
import { GuideInternalController, GuideInternalSearchController } from './guide-internal.controller';
import { GuidePublicController, GuideSearchController } from './guide-public.controller';
import { GuideGenerations, GuideReader } from './guide-reader';
import { GuideStats } from './guide-stats';

/**
 * Guides (F-414, ADR-0115): the `guide` schema's module inside tenant-service.
 * Reading by Host (F-414-b); the settings, behind `guide.manage` (F-414-c);
 * reading by tenant for the bot, behind the service token (F-414-f); views and
 * votes (F-414-l); the nightly sweep of unused guide files (F-414-m).
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  imports: [FilesModule, LocaleModule],
  controllers: [GuidePublicController, GuideSearchController, GuideAdminController, GuideFeedbackController, GuideInternalController, GuideInternalSearchController],
  providers: [GuideReader, GuideGenerations, GuideAdmin, GuideStats, GuideFileSweep],
  exports: [GuideReader, GuideGenerations],
})
export class GuideModule {}
