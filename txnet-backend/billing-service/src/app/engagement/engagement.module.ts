import { Module } from '@nestjs/common';

import { WheelAdminController } from './wheel-admin.controller';
import { WheelAdminService } from './wheel-admin.service';

/**
 * The wheel and the lottery (F-707, ADR-0111 point 1): a module of
 * `billing-service`, so a prize and its spin commit in one transaction. Tables
 * in the `engagement` schema; no other unit writes them.
 *
 * No imports: `PrismaModule` is `@Global()`.
 */
@Module({
  controllers: [WheelAdminController],
  providers: [WheelAdminService],
})
export class EngagementModule {}
