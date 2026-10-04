import { Module } from '@nestjs/common';

import { GuidePublicController } from './guide-public.controller';
import { GuideGenerations, GuideReader } from './guide-reader';

/**
 * Guides (F-414, ADR-0115): the `guide` schema's module inside tenant-service.
 * Reading by Host (F-414-b).
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  controllers: [GuidePublicController],
  providers: [GuideReader, GuideGenerations],
  exports: [GuideReader, GuideGenerations],
})
export class GuideModule {}
