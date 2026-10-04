import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { AuthModule } from '../auth/auth.module';
import { SupportConsentController } from './support-consent.controller';
import { SupportConsentService } from './support-consent.service';

/**
 * A reseller's consent for the platform's support (F-117-a, ADR-0104 (4)).
 * `AuthModule` for `AuthGuard`'s dependencies; `ResellerAccess` provided here,
 * its reader bound once beside the pools in `PrismaModule` (as `ResellerBotModule`).
 */
@Module({
  imports: [AuthModule],
  controllers: [SupportConsentController],
  providers: [SupportConsentService, ResellerAccess],
})
export class SupportConsentModule {}
