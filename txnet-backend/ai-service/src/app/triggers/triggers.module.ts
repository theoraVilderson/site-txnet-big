import { Module } from '@nestjs/common';

import { BrokerModule } from '../broker/broker.module';
import { DecisionModule } from '../decision/decision.module';
import { PolicyModule } from '../policy/policy.module';
import { TriggerConsumer } from './trigger.consumer';

@Module({
  imports: [BrokerModule, PolicyModule, DecisionModule],
  providers: [TriggerConsumer],
})
export class TriggersModule {}
