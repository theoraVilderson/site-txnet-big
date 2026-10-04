import { Module } from '@nestjs/common';

import { SupportAvailabilityModule } from '../availability/availability.module';
import { SupportNotifyModule } from '../notify/notify.module';
import { SupportRealtime } from '../realtime/support-realtime';
import { SupportAgentController } from './agent.controller';
import { SupportAgentService } from './agent.service';
import { PlatformAgentController } from './platform-agent.controller';
import { PlatformSupportDoor } from './platform-door';
import { BILLING_FACTS_SEAM, HttpBillingFactsSeam, SupportUserContext } from './user-context';

/** The agent's side of support (F-033-d), and the platform's staff in a reseller's under its consent (F-033-l). */
@Module({
  imports: [SupportAvailabilityModule, SupportNotifyModule],
  controllers: [SupportAgentController, PlatformAgentController],
  providers: [
    SupportAgentService,
    SupportRealtime,
    PlatformSupportDoor,
    SupportUserContext,
    { provide: BILLING_FACTS_SEAM, useClass: HttpBillingFactsSeam },
  ],
})
export class SupportAgentModule {}
