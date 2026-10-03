import { Module } from '@nestjs/common';

import { SupportAvailability } from './availability';
import { SupportSettingsController } from './settings.controller';

/** Presence, working hours and the live/async decision (F-033-g). */
@Module({
  controllers: [SupportSettingsController],
  providers: [SupportAvailability],
  exports: [SupportAvailability],
})
export class SupportAvailabilityModule {}
