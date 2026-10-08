import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { AuthModule } from '../../auth/auth.module';
import { UserGroupAdminService } from './user-group-admin.service';
import { ResellerUserGroupsController } from './reseller-user-groups.controller';
import { UserGroupController } from './user-group.controller';

/**
 * User groups (F-114-j) — the first of `governance`'s code, served by this
 * process because the users it groups are here. `AuthModule` for `AuthGuard`'s
 * own dependencies; both Prisma pools come from the global `PrismaModule`.
 * `ResellerAccess` for a reseller's groups by path (F-102-g-d), its reader
 * bound once beside the pools, as `SupportConsentModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [UserGroupController, ResellerUserGroupsController],
  providers: [UserGroupAdminService, ResellerAccess],
})
export class UserGroupModule {}
