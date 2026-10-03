import { Module } from '@nestjs/common';

import { SupportAvailabilityModule } from '../availability/availability.module';
import { SupportNotifyModule } from '../notify/notify.module';
import { SupportRealtime } from '../realtime/support-realtime';
import { SupportAgentController } from './agent.controller';
import { SupportAgentService } from './agent.service';

/** The agent's side of support (F-033-d). */
@Module({
  imports: [SupportAvailabilityModule, SupportNotifyModule],
  controllers: [SupportAgentController],
  providers: [SupportAgentService, SupportRealtime],
})
export class SupportAgentModule {}
