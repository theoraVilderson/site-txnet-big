import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { AuthModule } from '../auth/auth.module';
import { ImpersonationModule } from '../impersonation/impersonation.module';
import { SupportConsentController } from './support-consent.controller';
import { SupportConsentService } from './support-consent.service';

/**
 * A reseller's consent for the platform's support (F-117-a, ADR-0104 (4)).
 * `AuthModule` for `AuthGuard`'s dependencies; `ResellerAccess` provided here,
 * its reader bound once beside the pools in `PrismaModule` (as `ResellerBotModule`).
 */
@Module({
  // `ImpersonationModule` for its leash: a consent or entry that ends takes its impersonations with it (F-117-e).
  imports: [AuthModule, ImpersonationModule],
  controllers: [SupportConsentController],
  providers: [SupportConsentService, ResellerAccess],
})
export class SupportConsentModule {}
