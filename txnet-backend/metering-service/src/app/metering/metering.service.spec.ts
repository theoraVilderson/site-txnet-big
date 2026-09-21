import { ConfigProtocol, PanelOwnershipType, Prisma, QuarantineReason } from '@prisma/client';
import { USAGE_DELTA_MESSAGE_VERSION, type UsageDeltaMessage } from '@txnet-backend/shared-core';

import { MeteringService, UnsupportedDeltaVersion } from './metering.service';

/**
 * The delta consumer (F-027-n).
 *
 * Two invariants are on trial here and they are the reason this file exists:
 *
 * - **network invariant 19 — one delta is applied at most once.** Delivery is
 *   at-least-once (ADR-0027), so a redelivered pass is not an edge case: it is
 *   the normal consequence of any process dying between its work and its ack.
 *   `usage_delta_seen.deltaId` is the primary key and the insert is the
 *   deduplication, so the second application of a delta is a unique violation
 *   the consumer absorbs rather than a second charge.
 * - **network invariant 18 — every measured byte ends billed, held or
 *   quarantined, never dropped.** The assertion below is arithmetic over the
 *   whole message rather than a check per row: bytes in equals bytes landed,
 *   whichever of the four places each one landed in. A rule stated as a sum is
 *   the only form that catches a byte falling between two branches.
 *
 * The fake is a store rather than a list of expected calls, for
 * `wallet-ledger.spec.ts`'s reason: what is being asserted is what the database
 * ends up holding, and a mock that agrees with the code's call sequence cannot
 * tell a correct write from a plausible one. `$transaction` and `$executeRaw`
 * are real enough to carry `tenantTransaction`'s `SET LOCAL`, so the tenant
 * binding the RLS policy on `traffic_raw_log` needs is exercised too.
 */

const PANEL = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const CONFIG = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const OTHER_CONFIG = '55555555-5555-4555-8555-555555555555';

type ConfigRow = {
  id: string;
  tenantId: string;
  grantId: string;
  remoteId: string | null;
};

function fakeStore(configs: ConfigRow[]) {
  const seen = new Map<string, Record<string, unknown>>();
  const rawLog: Array<Record<string, unknown>> = [];
  const holds: Array<Record<string, unknown>> = [];
  const quarantines: Array<Record<string, unknown>> = [];
  const unattributed = new Map<string, { upBytes: bigint; downBytes: bigint; observationCount: number; lastSeenAt: Date }>();
  const consumed = new Map<string, bigint>([[GRANT, 0n]]);
  /** What `SET LOCAL app.tenant_id` bound, per transaction — the RLS scope. */
  const bound: Array<string | null> = [];

  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  const client = {
    config: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        configs.filter((c) => where.id.in.includes(c.id)).map((c) => ({ ...c })),
    },
    usageDeltaSeen: {
      findMany: async ({ where }: { where: { deltaId: { in: string[] } } }) =>
        where.deltaId.in.filter((id) => seen.has(id)).map((deltaId) => ({ deltaId })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = data['deltaId'] as string;
        if (seen.has(id)) throw uniqueViolation();
        seen.set(id, data);
        return data;
      },
    },
    trafficRawLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rawLog.push(data);
        return data;
      },
    },
    grant: {
      update: async ({ where, data }: { where: { id: string }; data: { consumedBytes: { increment: bigint } } }) => {
        consumed.set(where.id, (consumed.get(where.id) ?? 0n) + data.consumedBytes.increment);
        return { id: where.id };
      },
    },
    usageHold: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        holds.push(data);
        return data;
      },
    },
    usageDeltaQuarantine: {
      findMany: async ({ where }: { where: { deltaId: { in: string[] } } }) =>
        quarantines
          .filter((q) => where.deltaId.in.includes(q['deltaId'] as string))
          .map((q) => ({ deltaId: q['deltaId'] })),
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        quarantines.push(...data);
        return { count: data.length };
      },
    },
    unattributedUsage: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { panelId: string; remoteIdentifier: string; lastSeenAt: { lt: Date } };
        data: Record<string, { increment: bigint | number } | Date>;
      }) => {
        const key = `${where.panelId}|${where.remoteIdentifier}`;
        const row = unattributed.get(key);
        if (!row || !(row.lastSeenAt < where.lastSeenAt.lt)) return { count: 0 };
        row.upBytes += (data['upBytes'] as { increment: bigint }).increment;
        row.downBytes += (data['downBytes'] as { increment: bigint }).increment;
        row.observationCount += 1;
        row.lastSeenAt = data['lastSeenAt'] as Date;
        return { count: 1 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = `${data['panelId'] as string}|${data['remoteIdentifier'] as string}`;
        if (unattributed.has(key)) throw uniqueViolation();
        unattributed.set(key, {
          upBytes: data['upBytes'] as bigint,
          downBytes: data['downBytes'] as bigint,
          observationCount: 1,
          lastSeenAt: data['lastSeenAt'] as Date,
        });
        return data;
      },
    },
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      bound.push((values[0] as string) ?? null);
      return 1;
    },
    $transaction: async <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => fn(client),
  };

  return { client, seen, rawLog, holds, quarantines, unattributed, consumed, bound };
}

/** One pass, with whatever the caller wants in it. Bytes are decimal strings on the wire. */
function pass(message: Partial<UsageDeltaMessage> = {}): UsageDeltaMessage {
  return {
    version: USAGE_DELTA_MESSAGE_VERSION,
    panelId: PANEL,
    ownershipType: PanelOwnershipType.tenant,
    tenantId: TENANT,
    observedAt: '2026-09-21T10:00:00.000Z',
    chunk: 1,
    chunks: 1,
    deltas: [],
    quarantines: [],
    unattributed: [],
    ...message,
  };
}

function delta(over: Partial<UsageDeltaMessage['deltas'][number]> = {}) {
  return {
    deltaId: '66666666-6666-4666-8666-666666666666',
    configId: CONFIG,
    remoteId: 'client-a',
    protocol: ConfigProtocol.vless,
    upBytes: '1000',
    downBytes: '2000',
    observedAt: '2026-09-21T10:00:00.000Z',
    sessionId: '',
    afterReset: false,
    ...over,
  };
}

function service(store: ReturnType<typeof fakeStore>) {
  return new MeteringService(
    store.client as never,
    store.client as never,
  );
}

describe('MeteringService', () => {
  it('bills a delta: a raw-log row, the Grant cursor, and a seen row under the config tenant', async () => {
    const store = fakeStore([{ id: CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-a' }]);

    const outcome = await service(store).apply(pass({ deltas: [delta()] }));

    expect(outcome.applied).toBe(1);
    expect(store.rawLog).toHaveLength(1);
    expect(store.rawLog[0]).toMatchObject({
      tenantId: TENANT,
      configId: CONFIG,
      uploadBytes: 1000n,
      downloadBytes: 2000n,
    });
    expect(store.consumed.get(GRANT)).toBe(3000n);
    expect(store.seen.size).toBe(1);
    // The write went through a transaction that bound the config's tenant —
    // without it the RLS policy on `traffic_raw_log` refuses the insert.
    expect(store.bound).toContain(TENANT);
  });

  it('applies a redelivered pass exactly once, whether or not the seen row was read first', async () => {
    const store = fakeStore([{ id: CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-a' }]);
    const meter = service(store);
    const message = pass({ deltas: [delta()] });

    await meter.apply(message);
    const second = await meter.apply(message);

    expect(second.applied).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(store.rawLog).toHaveLength(1);
    expect(store.consumed.get(GRANT)).toBe(3000n);

    // The same message again, with the pre-read defeated — two consumers
    // racing on one delta. The unique index is what absorbs it, not the read.
    store.client.usageDeltaSeen.findMany = async () => [];
    const third = await meter.apply(message);
    expect(third.duplicates).toBe(1);
    expect(store.rawLog).toHaveLength(1);
    expect(store.consumed.get(GRANT)).toBe(3000n);
  });

  it('holds a delta whose config no longer claims the remote client it names', async () => {
    const store = fakeStore([{ id: CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-renamed' }]);

    const outcome = await service(store).apply(pass({ deltas: [delta()] }));

    expect(outcome.held).toBe(1);
    expect(store.holds[0]).toMatchObject({
      configId: CONFIG,
      panelId: PANEL,
      upBytes: 1000n,
      downBytes: 2000n,
      reason: 'attribution_ambiguous',
    });
    // Believed, but not billed: the Grant cursor does not move on a hold.
    expect(store.consumed.get(GRANT)).toBe(0n);
    expect(store.rawLog).toHaveLength(0);
    // Still recorded as seen, so a redelivery does not hold the same bytes twice.
    expect(store.seen.size).toBe(1);
  });

  it('writes down a delta for a config this platform does not have, against the panel client', async () => {
    const store = fakeStore([]);

    const outcome = await service(store).apply(
      pass({ deltas: [delta({ configId: OTHER_CONFIG, remoteId: 'ghost' })] }),
    );

    expect(outcome.unattributed).toBe(1);
    expect(store.unattributed.get(`${PANEL}|ghost`)).toMatchObject({ upBytes: 1000n, downBytes: 2000n });
    expect(store.consumed.get(GRANT)).toBe(0n);
  });

  it('does not count an unattributed row twice when the pass is redelivered', async () => {
    const store = fakeStore([]);
    const meter = service(store);
    const message = pass({
      unattributed: [{ remoteIdentifier: 'nobody', upBytes: '10', downBytes: '20', observedAt: '2026-09-21T10:00:00.000Z' }],
    });

    await meter.apply(message);
    await meter.apply(message);

    expect(store.unattributed.get(`${PANEL}|nobody`)).toMatchObject({
      upBytes: 10n,
      downBytes: 20n,
      observationCount: 1,
    });
  });

  it('stores the pass quarantines once, deltaId by deltaId', async () => {
    const store = fakeStore([]);
    const meter = service(store);
    const message = pass({
      quarantines: [
        {
          deltaId: '77777777-7777-4777-8777-777777777777',
          configId: null,
          remoteId: 'client-b',
          upBytes: '7',
          downBytes: '8',
          observedAt: '2026-09-21T10:00:00.000Z',
          reason: QuarantineReason.implausible_volume,
        },
      ],
    });

    await meter.apply(message);
    await meter.apply(message);

    expect(store.quarantines).toHaveLength(1);
    expect(store.quarantines[0]).toMatchObject({ panelId: PANEL, upBytes: 7n, downBytes: 8n });
  });

  it('accounts for every byte of a mixed pass — billed, held, quarantined or written down', async () => {
    const store = fakeStore([
      { id: CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-a' },
      { id: OTHER_CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-renamed' },
    ]);
    const message = pass({
      deltas: [
        delta(),
        delta({ deltaId: '88888888-8888-4888-8888-888888888888', configId: OTHER_CONFIG, remoteId: 'client-b', upBytes: '5', downBytes: '5' }),
        delta({ deltaId: '99999999-9999-4999-8999-999999999999', configId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', remoteId: 'ghost', upBytes: '1', downBytes: '1' }),
      ],
      quarantines: [
        {
          deltaId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          configId: CONFIG,
          remoteId: 'client-a',
          upBytes: '100',
          downBytes: '100',
          observedAt: '2026-09-21T10:00:00.000Z',
          reason: QuarantineReason.clock_went_backward,
        },
      ],
      unattributed: [{ remoteIdentifier: 'nobody', upBytes: '3', downBytes: '4', observedAt: '2026-09-21T10:00:00.000Z' }],
    });

    const outcome = await service(store).apply(message);

    const offered =
      [...message.deltas, ...message.quarantines, ...message.unattributed].reduce(
        (sum, row) => sum + BigInt(row.upBytes) + BigInt(row.downBytes),
        0n,
      );
    const billed = store.rawLog.reduce((s, r) => s + (r['uploadBytes'] as bigint) + (r['downloadBytes'] as bigint), 0n);
    const held = store.holds.reduce((s, h) => s + (h['upBytes'] as bigint) + (h['downBytes'] as bigint), 0n);
    const quarantined = store.quarantines.reduce((s, q) => s + (q['upBytes'] as bigint) + (q['downBytes'] as bigint), 0n);
    const written = [...store.unattributed.values()].reduce((s, u) => s + u.upBytes + u.downBytes, 0n);

    expect(billed + held + quarantined + written).toBe(offered);
    expect(outcome).toMatchObject({ applied: 1, held: 1, unattributed: 2, quarantined: 1, duplicates: 0 });
  });

  it('refuses a message version it was not written against instead of guessing at the fields', async () => {
    const store = fakeStore([]);

    await expect(service(store).apply(pass({ version: USAGE_DELTA_MESSAGE_VERSION + 1 }))).rejects.toBeInstanceOf(
      UnsupportedDeltaVersion,
    );
    expect(store.seen.size).toBe(0);
  });
});
