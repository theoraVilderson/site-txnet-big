import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LocaleModule } from '../locale/locale.module';
import { AccountSwitchController } from './account-switch.controller';
import { AccountSwitchService } from './account-switch.service';

/**
 * `audit`'s account-switch group. Imports `AuthModule` for `AuthGuard` and for
 * identity's proof operations — the only two things it needs from that unit,
 * and both are on identity's exported surface — and `LocaleModule` for the
 * request's language (CS-1-a).
 */
@Module({
  imports: [AuthModule, LocaleModule],
  controllers: [AccountSwitchController],
  providers: [AccountSwitchService],
  exports: [AccountSwitchService],
})
export class AccountSwitchModule {}
