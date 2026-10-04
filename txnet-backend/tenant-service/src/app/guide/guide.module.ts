import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module';
import { GuideAdmin } from './guide-admin';
import { GuideAdminController } from './guide-admin.controller';
import { GuidePublicController } from './guide-public.controller';
import { GuideGenerations, GuideReader } from './guide-reader';

/**
 * Guides (F-414, ADR-0115): the `guide` schema's module inside tenant-service.
 * Reading by Host (F-414-b); the settings, behind `guide.manage` (F-414-c).
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  imports: [FilesModule],
  controllers: [GuidePublicController, GuideAdminController],
  providers: [GuideReader, GuideGenerations, GuideAdmin],
  exports: [GuideReader, GuideGenerations],
})
export class GuideModule {}
