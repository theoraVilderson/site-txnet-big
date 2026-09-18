import { Module } from '@nestjs/common';

import { ResellerController } from './reseller.controller';
import { ResellerService } from './reseller.service';

/**
 * The platform owner creates, lists and reads resellers (F-018-c), moved out of
 * `auth-service` with F-018-y (ADR-0058).
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  controllers: [ResellerController],
  providers: [ResellerService],
})
export class ResellersModule {}
