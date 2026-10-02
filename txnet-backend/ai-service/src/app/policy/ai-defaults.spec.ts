import { AiActionType } from '@prisma/client';

import { TriggerConsumer } from '../triggers/trigger.consumer';
import type { TriggerMessage } from '../triggers/trigger-events';
import { AI_V1_ACTION_TYPES, resolveAiMode, type AiTenantMode } from './ai-defaults';

/**
 * F-1550 as ADR-0109 point 12 reads it (user, 2026-10-02): **the package
 * decides**. A tenant whose package carries `ai_recommendation` has the engine
 * and every v1 action type on, on templates, without touching a setting; a
 * tenant without it has no engine run at all; the model stays off until the
 * tenant adds a provider, and its text starts as draft-with-approval.
 *
 * The failure worth a spec is a default that leaks across that line in either
 * direction: an unentitled tenant whose customers get suggestions (unpaid
 * feature, and messages nobody configured), or an entitled one that has to
 * discover a switch before anything happens — "most tenants never configure
 * anything, and that's exactly right".
 */

const setting = (over: Partial<NonNullable<Parameters<typeof resolveAiMode>[0]['setting']>> = {}) => ({
  engineEnabled: true,
  disabledActionTypes: [] as AiActionType[],
  automaticActionTypes: [] as AiActionType[],
  confidenceThreshold: 0.6,
  holdoutPercent: 10,
  ...over,
});

describe('the factory default, by package (F-1550, ADR-0109 point 12)', () => {
  it('runs nothing for a tenant whose package lacks ai_recommendation, whatever its settings say', () => {
    const mode = resolveAiMode({ entitled: false, setting: setting(), hasActiveProvider: true });
    expect(mode.engineRuns).toBe(false);
    expect(mode.actionTypes).toEqual([]);
    expect(mode.languageLayer).toBe('off');
  });

  it('runs every v1 type on templates for an entitled tenant that never configured anything', () => {
    const mode = resolveAiMode({ entitled: true, setting: null, hasActiveProvider: false });
    expect(mode).toMatchObject<Partial<AiTenantMode>>({
      engineRuns: true,
      languageLayer: 'off',
      confidenceThreshold: 0.6,
      holdoutPercent: 10,
    });
    expect([...mode.actionTypes].sort()).toEqual([...AI_V1_ACTION_TYPES].sort());
    expect(mode.modelText).toEqual({});
  });

  it('keeps the later types out of v1 (cross_sell, wheel_invite, referral_invite)', () => {
    expect(AI_V1_ACTION_TYPES).toEqual([
      AiActionType.renew,
      AiActionType.resize_up,
      AiActionType.resize_down,
      AiActionType.top_up_wallet,
      AiActionType.retain_offer,
      AiActionType.trial_convert,
      AiActionType.checkout_help,
      AiActionType.win_back,
      AiActionType.usage_alert,
    ]);
  });

  it('lets an entitled tenant turn the engine off, or one type off', () => {
    expect(resolveAiMode({ entitled: true, setting: setting({ engineEnabled: false }), hasActiveProvider: false }).engineRuns).toBe(false);
    const mode = resolveAiMode({
      entitled: true,
      setting: setting({ disabledActionTypes: [AiActionType.win_back] }),
      hasActiveProvider: false,
    });
    expect(mode.actionTypes).not.toContain(AiActionType.win_back);
    expect(mode.actionTypes).toContain(AiActionType.renew);
  });

  it('turns the model on only with a provider, as draft-with-approval unless a type is made automatic', () => {
    const mode = resolveAiMode({
      entitled: true,
      setting: setting({ automaticActionTypes: [AiActionType.renew] }),
      hasActiveProvider: true,
    });
    expect(mode.languageLayer).toBe('on');
    expect(mode.modelText[AiActionType.renew]).toBe('automatic');
    expect(mode.modelText[AiActionType.top_up_wallet]).toBe('draft_with_approval');
  });
});

describe('a trigger is gated on the tenant’s mode', () => {
  const message = (payload: unknown): TriggerMessage => ({
    id: '6f1c2f1e-9a5e-4c55-9d0e-1a2b3c4d5e6f',
    aggregate: 'entitlement.grant',
    aggregateId: 'b0b0b0b0-0000-4000-8000-000000000001',
    type: 'entitlement.grant.runs_out_soon',
    occurredAt: '2026-10-02T08:00:00.000Z',
    payload,
  });
  const TENANT = 'c3384bcb-8fec-4547-82b9-9d2d4254ec15';

  function consumer(mode: Pick<AiTenantMode, 'engineRuns'>) {
    const policy = { forTenant: vi.fn(async () => ({ ...resolveAiMode({ entitled: true, setting: null, hasActiveProvider: false }), ...mode })) };
    return { policy, consumer: new TriggerConsumer({} as never, policy as never) };
  }

  it('asks the policy for the payload’s tenant and stops when the engine does not run', async () => {
    const { policy, consumer: c } = consumer({ engineRuns: false });
    await expect(c.handle(message({ tenantId: TENANT }))).resolves.toBe('engine_off');
    expect(policy.forTenant).toHaveBeenCalledWith(TENANT);
  });

  it('passes an entitled tenant’s trigger on', async () => {
    const { consumer: c } = consumer({ engineRuns: true });
    await expect(c.handle(message({ tenantId: TENANT }))).resolves.toBe('accepted');
  });

  it('acknowledges and skips a trigger that names no tenant, rather than guessing one', async () => {
    const { policy, consumer: c } = consumer({ engineRuns: true });
    await expect(c.handle(message({ grantId: 'x' }))).resolves.toBe('no_tenant');
    expect(policy.forTenant).not.toHaveBeenCalled();
  });
});
