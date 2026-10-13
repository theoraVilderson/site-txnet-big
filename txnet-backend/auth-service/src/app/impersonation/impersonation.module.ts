import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';
import { ImpersonationController } from './impersonation.controller';
import { ImpersonationService } from './impersonation.service';
import { ImpersonationLeash } from './impersonation-leash';
import { AuthModule } from '../auth/auth.module'; // for AuthGuard and TokenService

@Module({
  imports: [AuthModule],
  controllers: [ImpersonationController],
  // `ResellerAccess`: a reseller's user is reached through the consent door (F-117-e).
  providers: [ImpersonationService, ImpersonationLeash, ResellerAccess],
  exports: [ImpersonationLeash],
})
export class ImpersonationModule {}
