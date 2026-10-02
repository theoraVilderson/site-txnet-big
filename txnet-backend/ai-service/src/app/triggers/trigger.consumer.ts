import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { BrokerService } from '../broker/broker.service';
import type { TriggerMessage } from './trigger-events';

/**
 * Where a trigger lands. F-038-b wires the queue end to end and records that
 * the event arrived; deciding on it is the decision pipeline's (F-038-e), and
 * whether the tenant runs the engine at all is F-1550's gate.
 */
@Injectable()
export class TriggerConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TriggerConsumer.name);

  constructor(private readonly broker: BrokerService) {}

  async onApplicationBootstrap() {
    await this.broker.consumeTriggers((message) => this.handle(message));
  }

  async handle(message: TriggerMessage): Promise<void> {
    this.logger.debug(`trigger ${message.type} ${message.aggregate}/${message.aggregateId} (${message.id})`);
  }
}
