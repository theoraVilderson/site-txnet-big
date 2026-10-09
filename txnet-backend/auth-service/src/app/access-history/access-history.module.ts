import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { AuthModule } from '../auth/auth.module';
import { AccessHistoryController } from './access-history.controller';
import { AccessHistoryService } from './access-history.service';

/**
 * Access history (AC-1-p). `AuthModule` for `AuthGuard`'s dependencies;
 * `ResellerAccess` provided here, its reader bound once beside the pools in
 * `PrismaModule` (as `SupportConsentModule`).
 */
@Module({
  imports: [AuthModule],
  controllers: [AccessHistoryController],
  providers: [AccessHistoryService, ResellerAccess],
})
export class AccessHistoryModule {}
