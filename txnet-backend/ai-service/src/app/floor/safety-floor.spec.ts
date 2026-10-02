import { UnscopedRedisKeys } from '@txnet-backend/shared-core';

import type { AttentionBudget } from '../attention/attention-budget.service';
import type { RedisService } from '../redis/redis.service';
import { SafetyFloor } from './safety-floor';
import { SILENCE_MAX_MS, SilenceSwitch } from './silence';

/**
 * F-1548 / ADR-0109: the floor every AI message passes, whatever the tenant
 * configured — the model is theirs, the guardrails are ours.
 *
 * The failures worth a spec: a platform silence the engine talks through
 * (one tenant's, or everyone's), a silence that outlives its end or swallows
 * an answer to the user's own question, a Redis that cannot be read read as
 * "not silent", a spent budget skipped, and a subject of another tenant let
 * through because the action carried the wrong tenant.
 */

const T0 = new Date('2026-10-02T12:00:00Z');
const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000009';
const subject = { tenantId: TENANT, kind: 'user' as const, id: '00000000-0000-4000-8000-000000000002' };

function fakeRedis(values: Record<string, string> = {}, broken = false) {
  const store = new Map(Object.entries(values));
  return {
    store,
    mget: vi.fn(async (...keys: string[]) => {
      if (broken) throw new Error('connection refused');
      return keys.map((k) => store.get(k) ?? null);
    }),
    setFor: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    del: vi.fn(async (key: string) => void store.delete(key)),
  };
}

function floor(redis = fakeRedis(), spend: AttentionBudget['spend'] = vi.fn(async () => ({ allowed: true as const, charged: true }))) {
  const silence = new SilenceSwitch(redis as unknown as RedisService);
  const budget = { spend: vi.fn(spend) };
  return { floor: new SafetyFloor(silence, budget as unknown as AttentionBudget), budget, silence, redis };
}

describe('platform silence (F-1548)', () => {
  it('holds every engine message of the silenced tenant until its end, and nobody else’s', async () => {
    const redis = fakeRedis({ [UnscopedRedisKeys.aiSilence(TENANT)]: '2026-10-02T15:00:00.000Z' });
    const { floor: f, budget } = floor(redis);
    await expect(f.check(TENANT, subject, 'engine', T0)).resolves.toEqual({
      pass: false,
      suppressedBy: 'platform_silence',
      until: new Date('2026-10-02T15:00:00Z'),
    });
    expect(budget.spend).not.toHaveBeenCalled();
    await expect(f.check(OTHER, { ...subject, tenantId: OTHER }, 'engine', T0)).resolves.toEqual({ pass: true });
  });

  it('holds every tenant under the platform-wide silence', async () => {
    const { floor: f } = floor(fakeRedis({ [UnscopedRedisKeys.aiSilenceAll()]: '2026-10-02T13:00:00.000Z' }));
    await expect(f.check(OTHER, { ...subject, tenantId: OTHER }, 'engine', T0)).resolves.toMatchObject({ pass: false, suppressedBy: 'platform_silence' });
  });

  it('never silences an answer to the user’s own question', async () => {
    const { floor: f, redis } = floor(fakeRedis({ [UnscopedRedisKeys.aiSilenceAll()]: '2026-10-02T13:00:00.000Z' }));
    await expect(f.check(TENANT, subject, 'reply', T0)).resolves.toEqual({ pass: true });
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('reads a value past its end as no silence', async () => {
    const { floor: f } = floor(fakeRedis({ [UnscopedRedisKeys.aiSilence(TENANT)]: '2026-10-02T11:59:59.000Z' }));
    await expect(f.check(TENANT, subject, 'engine', T0)).resolves.toEqual({ pass: true });
  });

  it('fails closed: a Redis that cannot be read silences the engine', async () => {
    const { floor: f, budget } = floor(fakeRedis({}, true));
    await expect(f.check(TENANT, subject, 'engine', T0)).resolves.toEqual({ pass: false, suppressedBy: 'platform_silence', until: null });
    expect(budget.spend).not.toHaveBeenCalled();
  });
});

describe('the silence switch (F-1548)', () => {
  it('turns a tenant’s silence on with its end as the expiry, and lifts it', async () => {
    const { silence, redis } = floor();
    const until = new Date(T0.getTime() + 3 * 3_600_000);
    await silence.set(TENANT, until, T0);
    expect(redis.setFor).toHaveBeenCalledWith(UnscopedRedisKeys.aiSilence(TENANT), until.toISOString(), 3 * 3_600_000);
    await silence.set(TENANT, null, T0);
    expect(redis.del).toHaveBeenCalledWith(UnscopedRedisKeys.aiSilence(TENANT));
  });

  it('refuses an end in the past or further than the cap', async () => {
    const { silence } = floor();
    await expect(silence.set(null, T0, T0)).rejects.toThrow('until_out_of_range');
    await expect(silence.set(null, new Date(T0.getTime() + SILENCE_MAX_MS + 1), T0)).rejects.toThrow('until_out_of_range');
  });
});

describe('the attention budget under the floor (F-1548, F-1501)', () => {
  it('stops an engine message the budget refuses, and charges a passing one', async () => {
    const retryAt = new Date('2026-10-03T12:00:00Z');
    const { floor: f } = floor(fakeRedis(), vi.fn(async () => ({ allowed: false as const, charged: false as const, limit: 'per_day' as const, retryAt })));
    await expect(f.check(TENANT, subject, 'engine', T0)).resolves.toEqual({ pass: false, suppressedBy: 'attention_budget', until: retryAt });

    const ok = floor();
    await expect(ok.floor.check(TENANT, subject, 'engine', T0)).resolves.toEqual({ pass: true });
    expect(ok.budget.spend).toHaveBeenCalledWith(subject, 'engine', T0);
  });
});

describe('no other tenant’s data (F-1548)', () => {
  it('refuses a subject of another tenant before reading anything, a reply included', async () => {
    const { floor: f, budget, redis } = floor();
    for (const origin of ['engine', 'reply'] as const) {
      await expect(f.check(OTHER, subject, origin, T0)).resolves.toEqual({ pass: false, suppressedBy: 'cross_tenant', until: null });
    }
    expect(redis.mget).not.toHaveBeenCalled();
    expect(budget.spend).not.toHaveBeenCalled();
  });
});
