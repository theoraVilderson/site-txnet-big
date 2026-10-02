import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';

import { BrokerService } from '../broker/broker.service';
import { AiTenantPolicy } from '../policy/ai-tenant-policy';
import type { TriggerMessage } from './trigger-events';

/** Every trigger producer writes the tenant into its payload; nothing else is read here yet. */
const tenantOf = z.object({ tenantId: z.string().uuid() });

export type TriggerOutcome = 'no_tenant' | 'engine_off' | 'accepted';

/**
 * Where a trigger lands. The tenant's mode is read first (F-1550): a tenant
 * whose package lacks `ai_recommendation`, or that turned the engine off, has
 * no run at all. What an accepted trigger leads to is the decision
 * pipeline's (F-038-e).
 */
@Injectable()
export class TriggerConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TriggerConsumer.name);

  constructor(
    private readonly broker: BrokerService,
    private readonly policy: AiTenantPolicy,
  ) {}

  async onApplicationBootstrap() {
    await this.broker.consumeTriggers(async (message) => {
      await this.handle(message);
    });
  }

  async handle(message: TriggerMessage): Promise<TriggerOutcome> {
    const scoped = tenantOf.safeParse(message.payload);
    if (!scoped.success) {
      // Acked, not dead-lettered: a guessed tenant is the one wrong answer.
      this.logger.warn(`trigger ${message.type} ${message.id} names no tenant — skipped`);
      return 'no_tenant';
    }
    const mode = await this.policy.forTenant(scoped.data.tenantId);
    if (!mode.engineRuns) {
      this.logger.debug(`trigger ${message.type} ${message.id}: no engine run for ${scoped.data.tenantId}`);
      return 'engine_off';
    }
    this.logger.debug(`trigger ${message.type} ${message.aggregate}/${message.aggregateId} for ${scoped.data.tenantId}`);
    return 'accepted';
  }
}
