import { Module } from '@nestjs/common';

import { SupportAvailability } from './availability';
import { SupportSla } from '../sla/sla';
import { SupportSettingsController } from './settings.controller';

/** Presence, working hours and the live/async decision (F-033-g); the SLA settings (F-033-h). */
@Module({
  controllers: [SupportSettingsController],
  providers: [SupportAvailability, SupportSla],
  exports: [SupportAvailability],
})
export class SupportAvailabilityModule {}
