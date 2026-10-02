import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';

import { BrokerService } from '../broker/broker.service';
import { DecisionRun } from '../decision/decision-run';
import { AiTenantPolicy } from '../policy/ai-tenant-policy';
import type { TriggerMessage } from './trigger-events';

/** Every trigger producer writes the tenant into its payload; most also name the user it is about. */
const tenantOf = z.object({ tenantId: z.string().uuid(), userId: z.string().uuid().optional() });

export type TriggerOutcome = 'no_tenant' | 'engine_off' | 'accepted';

/**
 * Where a trigger lands. The tenant's mode is read first (F-1550): a tenant
 * whose package lacks `ai_recommendation`, or that turned the engine off, has
 * no run at all. An accepted trigger that names a user runs the decision
 * pipeline for that user now, on the predictions of the last hourly rebuild
 * (F-038-e); one that names none waits for the hourly run.
 */
@Injectable()
export class TriggerConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TriggerConsumer.name);

  constructor(
    private readonly broker: BrokerService,
    private readonly policy: AiTenantPolicy,
    private readonly decisions: DecisionRun,
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
    if (scoped.data.userId) await this.decisions.runSubject(scoped.data.tenantId, mode, scoped.data.userId, new Date());
    return 'accepted';
  }
}
