import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { UsageDeltaMessage } from '@txnet-backend/shared-core';

import { BrokerService } from '../broker/broker.service';
import { MeteringService } from './metering.service';

/**
 * The queue end of the delta consumer (F-027-n): it subscribes, and it decides
 * nothing.
 *
 * Everything about what a pass *means* is {@link MeteringService}, which is why
 * that class is tested without a broker. What is here is the one rule this
 * layer owns: a handler that throws does not ack, so the pass dead-letters with
 * its bytes still owed rather than being recorded as applied.
 */
@Injectable()
export class DeltaConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeltaConsumer.name);

  constructor(
    private readonly broker: BrokerService,
    private readonly metering: MeteringService,
  ) {}

  async onApplicationBootstrap() {
    await this.broker.consumeUsageDeltas((message) => this.handle(message));
    this.logger.log('consuming network.usage.# — every measured byte is billed, held or quarantined');
  }

  private async handle(message: UsageDeltaMessage): Promise<void> {
    await this.metering.apply(message);
  }
}
