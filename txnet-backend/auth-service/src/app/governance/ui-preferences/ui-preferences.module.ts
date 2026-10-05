import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { UiPreferencesController } from './ui-preferences.controller';
import { UiPreferencesService } from './ui-preferences.service';

/** Display preferences (UX-1-k) — governance's `user_setting`, served by this process beside `/auth/me`. */
@Module({
  imports: [AuthModule],
  controllers: [UiPreferencesController],
  providers: [UiPreferencesService],
})
export class UiPreferencesModule {}
