import {
  METER_KEYS,
  OutboxEventType,
  recordUsage,
  usageEventMessageSchema,
  usageEventPayloadSchema,
  UsageRefused,
  type UsageEvent,
} from '@txnet-backend/shared-core';

import { MeteringService } from './metering.service';
import { SubUsagePublisher } from './sub-usage.publisher';

/**
 * Usage intake (F-118-f, ADR-0105 decision 5): a `usage_event` advances its
 * Grant's `grant_meter.consumed`, at most once per idempotency key.
 *
 * On trial: **one key, one advance.** Delivery is at-least-once through the
 * outbox and a reporter may retry its own call, so the second copy of an event
 * is the normal case. The insert of `usage_event` is the deduplication and it
 * must not abort the caller's transaction (the in-process door runs inside
 * one), so a duplicate is an `ON CONFLICT DO NOTHING` — `createMany` with
 * `skipDuplicates` — never a caught unique violation. A key reused for a
 * different figure is refused rather than absorbed: two numbers under one key
 * means one of them is wrong, and the dead-lettered message is the evidence.
 *
 * The fake is a store, for `metering.service.spec.ts`'s reason.
 */

const TENANT = '22222222-2222-4222-8222-222222222222';
const GRANT = '44444444-4444-4444-8444-444444444444';
const SMS = 'sms.sent';

type EventRow = UsageEvent & { tenantId: string };

function fakeStore(meters: Array<{ grantId: string; meterKey: string; tenantId: string }>) {
  const consumed = new Map<string, bigint>(meters.map((m) => [`${m.grantId}|${m.meterKey}`, 0n]));
  const events: EventRow[] = [];
  const bound: string[] = [];

  const meterOf = (where: { grantId_meterKey: { grantId: string; meterKey: string } }) =>
    meters.find((m) => m.grantId === where.grantId_meterKey.grantId && m.meterKey === where.grantId_meterKey.meterKey);

  const client = {
    grantMeter: {
      findUnique: async ({ where }: { where: { grantId_meterKey: { grantId: string; meterKey: string } } }) => {
        const m = meterOf(where);
        return m ? { ...m, consumed: consumed.get(`${m.grantId}|${m.meterKey}`) } : null;
      },
      update: async ({ where, data }: { where: { grantId_meterKey: { grantId: string; meterKey: string } }; data: { consumed: { increment: bigint } } }) => {
        const m = meterOf(where);
        if (!m) throw new Error('no such grant_meter');
        const key = `${m.grantId}|${m.meterKey}`;
        consumed.set(key, (consumed.get(key) as bigint) + data.consumed.increment);
        return { ...m, consumed: consumed.get(key) };
      },
    },
    usageEvent: {
      createMany: async ({ data, skipDuplicates }: { data: EventRow[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of data) {
          const clash = events.some((e) => e.source === row.source && e.idempotencyKey === row.idempotencyKey);
          if (clash && !skipDuplicates) throw new Error('unique violation would abort the caller transaction');
          if (clash) continue;
          events.push({ ...row });
          count += 1;
        }
        return { count };
      },
      findUnique: async ({ where }: { where: { source_idempotencyKey: { source: string; idempotencyKey: string } } }) =>
        events.find((e) => e.source === where.source_idempotencyKey.source && e.idempotencyKey === where.source_idempotencyKey.idempotencyKey) ?? null,
    },
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      bound.push(values[0] as string);
      return 1;
    },
    $transaction: async <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => fn(client),
  };

  return { client, consumed: (grantId = GRANT, meterKey = SMS) => consumed.get(`${grantId}|${meterKey}`), events, bound };
}

function service(store: ReturnType<typeof fakeStore>) {
  return new MeteringService(store.client as never, store.client as never, new SubUsagePublisher({ eval: async () => 1 }, 3600));
}

/** An event as the outbox carries it: the quantity is a decimal string. */
function wire(over: Record<string, unknown> = {}) {
  return usageEventPayloadSchema.parse({
    grantId: GRANT,
    meterKey: SMS,
    quantity: '3',
    occurredAt: '2026-09-29T10:00:00.000Z',
    source: 'notification-service',
    idempotencyKey: 'sms-0001',
    ...over,
  });
}

describe('usage intake (F-118-f)', () => {
  it("advances the Grant's meter by the event's quantity, under the meter's own tenant", async () => {
    const store = fakeStore([{ grantId: GRANT, meterKey: SMS, tenantId: TENANT }]);
    await expect(service(store).intake(wire())).resolves.toEqual({ outcome: 'recorded', consumed: 3n });
    expect(store.consumed()).toBe(3n);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ tenantId: TENANT, grantId: GRANT, meterKey: SMS, quantity: 3n });
    expect(store.bound).toEqual([TENANT]);
  });

  it('applies a redelivered event once: the second copy is a duplicate, not a second advance', async () => {
    const store = fakeStore([{ grantId: GRANT, meterKey: SMS, tenantId: TENANT }]);
    const metering = service(store);
    await metering.intake(wire());
    await expect(metering.intake(wire())).resolves.toEqual({ outcome: 'duplicate', consumed: 3n });
    expect(store.consumed()).toBe(3n);
    expect(store.events).toHaveLength(1);
  });

  it('counts distinct keys separately, and the same key from another reporter is its own event', async () => {
    const store = fakeStore([{ grantId: GRANT, meterKey: SMS, tenantId: TENANT }]);
    const metering = service(store);
    await metering.intake(wire());
    await metering.intake(wire({ idempotencyKey: 'sms-0002', quantity: '2' }));
    await metering.intake(wire({ source: 'bot-service' }));
    expect(store.consumed()).toBe(8n);
    expect(store.events).toHaveLength(3);
  });

  it('refuses a key reused for a different figure, and advances nothing', async () => {
    const store = fakeStore([{ grantId: GRANT, meterKey: SMS, tenantId: TENANT }]);
    const metering = service(store);
    await metering.intake(wire());
    await expect(metering.intake(wire({ quantity: '4' }))).rejects.toMatchObject({ reason: 'key_reused' });
    expect(store.consumed()).toBe(3n);
  });

  it('refuses usage on a meter the Grant was not sold with — it throws, so the message dead-letters as evidence', async () => {
    const store = fakeStore([{ grantId: GRANT, meterKey: SMS, tenantId: TENANT }]);
    const err = await service(store).intake(wire({ meterKey: 'ai.tokens' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageRefused);
    expect(err).toMatchObject({ reason: 'meter_not_on_grant' });
    expect(store.events).toHaveLength(0);
  });

  it('refuses vpn.traffic: VPN bytes keep their delta path until F-118-l', async () => {
    const store = fakeStore([{ grantId: GRANT, meterKey: METER_KEYS.vpnTraffic, tenantId: TENANT }]);
    await expect(service(store).intake(wire({ meterKey: METER_KEYS.vpnTraffic }))).rejects.toMatchObject({
      reason: 'meter_on_its_own_path',
    });
    expect(store.consumed(GRANT, METER_KEYS.vpnTraffic)).toBe(0n);
    expect(store.events).toHaveLength(0);
  });

  it("is also a door in the caller's own transaction: a duplicate never throws there", async () => {
    const store = fakeStore([{ grantId: GRANT, meterKey: SMS, tenantId: TENANT }]);
    const event = wire();
    await expect(recordUsage(store.client as never, event)).resolves.toEqual({ outcome: 'recorded', consumed: 3n });
    await expect(recordUsage(store.client as never, event)).resolves.toEqual({ outcome: 'duplicate', consumed: 3n });
  });

  it('parses only a whole, positive quantity and a routed outbox message', () => {
    for (const quantity of ['0', '-1', '1.5', '', 'x']) {
      expect(usageEventPayloadSchema.safeParse({ ...wire(), quantity, occurredAt: '2026-09-29T10:00:00.000Z' }).success).toBe(false);
    }
    const message = {
      id: '99999999-9999-4999-8999-999999999999',
      aggregate: 'entitlement.grant',
      aggregateId: GRANT,
      type: OutboxEventType.USAGE_EVENT,
      occurredAt: '2026-09-29T10:00:00.000Z',
      payload: { grantId: GRANT, meterKey: SMS, quantity: '3', occurredAt: '2026-09-29T10:00:00.000Z', source: 's', idempotencyKey: 'k' },
    };
    expect(usageEventMessageSchema.parse(message).payload.quantity).toBe(3n);
  });
});
