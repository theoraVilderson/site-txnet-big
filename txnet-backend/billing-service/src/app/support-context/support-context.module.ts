import { Module } from '@nestjs/common';

import { EntitlementModule } from '../entitlement/entitlement.module';
import { SupportContextController } from './support-context.controller';
import { SupportContextService } from './support-context';

/** Support's user sidebar, billing's half (F-033-m). */
@Module({
  imports: [EntitlementModule],
  controllers: [SupportContextController],
  providers: [SupportContextService],
})
export class SupportContextModule {}
