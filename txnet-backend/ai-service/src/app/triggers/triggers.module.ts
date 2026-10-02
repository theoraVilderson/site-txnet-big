import { Module } from '@nestjs/common';

import { BrokerModule } from '../broker/broker.module';
import { TriggerConsumer } from './trigger.consumer';

@Module({
  imports: [BrokerModule],
  providers: [TriggerConsumer],
})
export class TriggersModule {}
