import { Injectable } from '@nestjs/common';

import type { MessageOrigin } from '../attention/attention-budget';
import { AttentionBudget, type BudgetSubject } from '../attention/attention-budget.service';
import { SilenceSwitch } from './silence';

export type FloorStep = 'cross_tenant' | 'platform_silence' | 'attention_budget';

export type FloorVerdict = { pass: true } | { pass: false; suppressedBy: FloorStep; until: Date | null };

/**
 * The safety floor (F-1548, ADR-0109): the last check before any AI message
 * leaves, and the one no tenant can turn off — it is built from nothing a
 * tenant writes (no `ai.setting`, no `ai.guardrail`), so no setting can reach it.
 *
 * In order: the subject must be the action's tenant's (every origin); then, for
 * an engine message only, the platform's silence and the attention budget,
 * which charges a message it lets through (F-1501). A reply to the user's own
 * question passes the rest (F-1502).
 *
 * The bot's send ceiling is the fourth part and is not here: the messenger
 * driver spends it on every send (ADR-0066), so delivery (F-038-g) gets it by
 * sending through the driver.
 */
@Injectable()
export class SafetyFloor {
  constructor(
    private readonly silence: SilenceSwitch,
    private readonly budget: AttentionBudget,
  ) {}

  async check(tenantId: string, subject: BudgetSubject, origin: MessageOrigin, now: Date): Promise<FloorVerdict> {
    if (subject.tenantId !== tenantId) return { pass: false, suppressedBy: 'cross_tenant', until: null };
    if (origin === 'reply') return { pass: true };
    const hush = await this.silence.state(tenantId, now);
    if (hush.silent) return { pass: false, suppressedBy: 'platform_silence', until: hush.until };
    const spent = await this.budget.spend(subject, origin, now);
    if ('limit' in spent) return { pass: false, suppressedBy: 'attention_budget', until: spent.retryAt };
    return { pass: true };
  }
}
