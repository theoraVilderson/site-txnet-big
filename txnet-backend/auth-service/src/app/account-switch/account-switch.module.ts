import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountSwitchController } from './account-switch.controller';
import { AccountSwitchService } from './account-switch.service';

/**
 * `audit`'s account-switch group. Imports `AuthModule` for `AuthGuard` and for
 * identity's proof operations — the only two things it needs from that unit,
 * and both are on identity's exported surface.
 */
@Module({
  imports: [AuthModule],
  controllers: [AccountSwitchController],
  providers: [AccountSwitchService],
  exports: [AccountSwitchService],
})
export class AccountSwitchModule {}
