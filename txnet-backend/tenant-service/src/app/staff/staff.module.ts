import { Module } from '@nestjs/common';

import { ResellerAccess } from '../request/reseller-access';
import { TenantStaffController } from './tenant-staff.controller';
import { TenantStaffService } from './tenant-staff.service';

/**
 * A reseller's own team (F-018-j).
 *
 * `PrismaModule` is `@Global`, so neither pool is imported here.
 */
@Module({
  controllers: [TenantStaffController],
  providers: [TenantStaffService, ResellerAccess],
})
export class StaffModule {}
