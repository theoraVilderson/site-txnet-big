import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { TenantOnboardingController } from './tenant-onboarding.controller';
import { TenantOnboardingService } from './tenant-onboarding.service';

/**
 * The onboarding console's checklist (F-018-l). The gate it reports is
 * enforced elsewhere — `TenantOnboardingPolicy` in shared-core, through the
 * key `StatusModule`'s listener writes.
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here.
 */
@Module({
  controllers: [TenantOnboardingController],
  providers: [TenantOnboardingService, ResellerAccess],
})
export class OnboardingModule {}
