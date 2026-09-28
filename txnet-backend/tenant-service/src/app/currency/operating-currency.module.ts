import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { TenantOperatingCurrencyController } from './operating-currency.controller';
import { TenantOperatingCurrencyService } from './operating-currency.service';

/**
 * A tenant's operating currency (F-116-a, ADR-0098 part 1), on `tenant.tenant`.
 *
 * `PrismaModule` is `@Global`, so it is not imported here.
 */
@Module({
  controllers: [TenantOperatingCurrencyController],
  providers: [TenantOperatingCurrencyService, ResellerAccess],
})
export class OperatingCurrencyModule {}
