import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { AuthModule } from '../../auth/auth.module';
import { AudienceGroupsController } from './audience-groups.controller';
import { AudienceGroupsService } from './audience-groups.service';
import { UserGroupAdminService } from './user-group-admin.service';
import { UserGroupPersonService } from './user-group-person.service';
import { MembershipEndInternalController } from './membership-end-internal.controller';
import { MembershipEndSweep } from './membership-end.sweep';
import { ResellerUserGroupsController } from './reseller-user-groups.controller';
import { UserGroupController } from './user-group.controller';

/**
 * User groups (F-114-j) — the first of `governance`'s code, served by this
 * process because the users it groups are here. `AuthModule` for `AuthGuard`'s
 * own dependencies; both Prisma pools come from the global `PrismaModule`.
 * `ResellerAccess` for a reseller's groups by path (F-102-g-d), its reader
 * bound once beside the pools, as `SupportConsentModule`. `MembershipEndSweep`
 * keeps a membership's end (GR-1-c), on the worker's clock. `AudienceGroups*`
 * answers the audience picker (GR-1-w).
 */
@Module({
  imports: [AuthModule],
  controllers: [UserGroupController, ResellerUserGroupsController, AudienceGroupsController, MembershipEndInternalController],
  providers: [UserGroupAdminService, UserGroupPersonService, AudienceGroupsService, MembershipEndSweep, ResellerAccess],
})
export class UserGroupModule {}
