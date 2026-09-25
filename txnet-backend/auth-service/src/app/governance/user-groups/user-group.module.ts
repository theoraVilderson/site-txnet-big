import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { UserGroupAdminService } from './user-group-admin.service';
import { UserGroupController } from './user-group.controller';

/**
 * User groups (F-114-j) — the first of `governance`'s code, served by this
 * process because the users it groups are here. `AuthModule` for `AuthGuard`'s
 * own dependencies; both Prisma pools come from the global `PrismaModule`.
 */
@Module({
  imports: [AuthModule],
  controllers: [UserGroupController],
  providers: [UserGroupAdminService],
})
export class UserGroupModule {}
