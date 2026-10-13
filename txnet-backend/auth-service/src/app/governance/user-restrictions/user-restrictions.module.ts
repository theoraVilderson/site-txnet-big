import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { AuthModule } from '../../auth/auth.module';
import { UserRestrictionsController } from './user-restrictions.controller';
import { UserRestrictionsService } from './user-restrictions.service';

/**
 * A restriction on one person (F-030-d) — governance's, served here beside the
 * people it restricts, as user groups are. `AuthModule` for `AuthGuard` and
 * `AccessReader`; `ResellerAccess` for the door by path.
 */
@Module({
  imports: [AuthModule],
  controllers: [UserRestrictionsController],
  providers: [UserRestrictionsService, ResellerAccess],
})
export class UserRestrictionsModule {}
