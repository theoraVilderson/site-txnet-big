import { Injectable } from '@nestjs/common';
import { runWithTenant } from '@txnet-backend/shared-core';

import type { AiTenantMode } from '../policy/ai-defaults';
import { DecisionReader } from './decision-reader';
import { DecisionPipeline } from './pipeline';

/** Subjects per page: one pair of read transactions each. */
const DECISION_PAGE = 200;

export type DecisionResult = { subjects: number; scheduled: number; stopped: number };

/**
 * When the pipeline runs (F-038-e): for every account of a tenant with a
 * renewal or a run-out inside the lead time, right after the hourly rebuild
 * wrote its predictions (`ProfileBuilder`), and for one account when a trigger
 * names it (`TriggerConsumer`). The caller has already resolved the tenant's
 * mode (F-1550); a tenant whose engine does not run never reaches here.
 *
 * Running twice is safe: what is queued holds its type (cooldown, F-1504),
 * and a stopped row is written once a day per type and step.
 */
@Injectable()
export class DecisionRun {
  constructor(
    private readonly reader: DecisionReader,
    private readonly pipeline: DecisionPipeline,
  ) {}

  async runTenant(tenantId: string, mode: AiTenantMode, now: Date): Promise<DecisionResult> {
    const result: DecisionResult = { subjects: 0, scheduled: 0, stopped: 0 };
    if (!mode.engineRuns) return result;
    let cursor: string | null = null;
    for (;;) {
      const page = await runWithTenant({ id: tenantId }, () => this.reader.subjectsDue(tenantId, now, cursor, DECISION_PAGE));
      if (page.length === 0) break;
      this.add(result, await this.decide(tenantId, mode, page, now));
      if (page.length < DECISION_PAGE) break;
      cursor = page[page.length - 1];
    }
    return result;
  }

  async runSubject(tenantId: string, mode: AiTenantMode, userId: string, now: Date): Promise<DecisionResult> {
    if (!mode.engineRuns) return { subjects: 0, scheduled: 0, stopped: 0 };
    return this.decide(tenantId, mode, [userId], now);
  }

  private async decide(tenantId: string, mode: AiTenantMode, userIds: string[], now: Date): Promise<DecisionResult> {
    const result: DecisionResult = { subjects: userIds.length, scheduled: 0, stopped: 0 };
    const inputs = await runWithTenant({ id: tenantId }, () => this.reader.inputsFor(tenantId, userIds, now));
    for (const [id, input] of inputs) {
      const actions = await this.pipeline.decide({ tenantId, kind: 'user', id }, mode, input, now);
      for (const a of actions) {
        if (a.status === 'scheduled') result.scheduled += 1;
        else result.stopped += 1;
      }
    }
    return result;
  }

  private add(into: DecisionResult, more: DecisionResult) {
    into.subjects += more.subjects;
    into.scheduled += more.scheduled;
    into.stopped += more.stopped;
  }
}
