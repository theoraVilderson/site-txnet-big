import { Module } from '@nestjs/common';
import { ImpersonationController } from './impersonation.controller';
import { ImpersonationService } from './impersonation.service';
import { AuthModule } from '../auth/auth.module'; // برای استفاده از AuthGuard و TokenService

@Module({
  imports: [AuthModule],
  controllers: [ImpersonationController],
  providers: [ImpersonationService],
})
export class ImpersonationModule {}
