import { Module } from '@nestjs/common';

import { BrokerModule } from '../broker/broker.module';
import { PolicyModule } from '../policy/policy.module';
import { TriggerConsumer } from './trigger.consumer';

@Module({
  imports: [BrokerModule, PolicyModule],
  providers: [TriggerConsumer],
})
export class TriggersModule {}
