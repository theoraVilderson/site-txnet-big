import {
  ConfigProtocol,
  GrantStatus,
  HoldReason,
  PanelOwnershipType,
  Prisma,
  QuarantineReason,
  UsageDispositionState,
  VariantBillingMode,
} from '@prisma/client';
import {
  USAGE_DELTA_MESSAGE_VERSION,
  usageReleaseDeltaId,
  type UsageDeltaMessage,
  type UsageReleasePayload,
} from '@txnet-backend/shared-core';

import { MeteringService, UnsupportedDeltaVersion } from './metering.service';
import { SubUsagePublisher } from './sub-usage.publisher';

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
const USER = '77777777-7777-4777-8777-777777777777';

type ConfigRow = {
  id: string;
  tenantId: string;
  grantId: string;
  remoteId: string | null;
};

/** The Grant a charge lands on: by default a prepaid one with no bag, which no threshold is told for. */
const GRANT_STARTS_AT = new Date('2026-09-01T00:00:00Z');
function grantRow(over: Record<string, unknown> = {}) {
  return {
    status: GrantStatus.active,
    billingMode: VariantBillingMode.prepaid,
    trafficUnlimited: false,
    purchasedBytes: 0n,
    usagePeriodFromBytes: 0n,
    usagePeriodStartedAt: null,
    startsAt: GRANT_STARTS_AT,
    activatedAt: null,
    endsAt: null,
    endNoticeFor: null,
    endNoticeAt: null,
    usageNoticeLevel: null,
    usageNoticeSince: null,
    ...over,
  };
}

function fakeStore(configs: ConfigRow[], stored: Array<Record<string, unknown>> = [], grant: Record<string, unknown> = {}) {
  const seen = new Map<string, Record<string, unknown>>();
  const rawLog: Array<Record<string, unknown>> = [];
  const holds: Array<Record<string, unknown>> = [...stored];
  const quarantines: Array<Record<string, unknown>> = [];
  const unattributed = new Map<string, { upBytes: bigint; downBytes: bigint; observationCount: number; lastSeenAt: Date }>();
  const consumed = new Map<string, bigint>([[GRANT, 0n]]);
  const pushedAt = new Map<string, Date>();
  const outbox: Array<Record<string, unknown>> = [];
  /** The Grant's retention state as the charges left it (F-601-n): the held usage level and the end clock. */
  const notice: Record<string, unknown> = {};
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
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> & { consumedBytes?: { increment: bigint } } }) => {
        if (!data.consumedBytes) {
          Object.assign(notice, data);
          return { id: where.id };
        }
        consumed.set(where.id, (consumed.get(where.id) ?? 0n) + data.consumedBytes.increment);
        return { ...grantRow(grant), ...notice, id: where.id, consumedBytes: consumed.get(where.id) as bigint, userId: USER };
      },
      // The usage announcement's slot (F-307-t): taken only when the last one is older than the cutoff.
      // The end clock (F-601-n): moved by a charge that tells a time level with its usage level.
      updateMany: async ({ where, data }: { where: { id: string; OR?: [unknown, { usagePushedAt: { lt: Date } }] }; data: Record<string, unknown> }) => {
        if (!where.OR) {
          Object.assign(notice, data);
          return { count: 1 };
        }
        const last = pushedAt.get(where.id);
        if (last && !(last < where.OR[1].usagePushedAt.lt)) return { count: 0 };
        pushedAt.set(where.id, data['usagePushedAt'] as Date);
        return { count: 1 };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        outbox.push(data);
        return { id: 'e' };
      },
    },
    usageHold: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        holds.push(data);
        return data;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const hold = holds.find((h) => h['id'] === where.id);
        if (!hold) return null;
        const config = configs.find((c) => c.id === hold['configId']);
        return { ...hold, config: config ? { tenantId: config.tenantId, grantId: config.grantId } : null };
      },
      updateMany: async ({ where, data }: { where: { id: string; state: string }; data: Record<string, unknown> }) => {
        const hit = holds.filter((h) => h['id'] === where.id && h['state'] === where.state);
        hit.forEach((h) => Object.assign(h, data));
        return { count: hit.length };
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

  return { client, seen, rawLog, holds, quarantines, unattributed, consumed, bound, outbox, notice };
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
    new SubUsagePublisher({ eval: async () => 1 }, 3600),
  );
}

describe('MeteringService', () => {
  it("tells the owner's open page the committed total, at most once per 30 s per Grant (F-307-t)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-27T10:00:00Z'));
      const store = fakeStore([{ id: CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-a' }]);
      const metering = service(store);
      await metering.apply(pass({ deltas: [delta()] }));
      expect(store.outbox).toEqual([
        {
          aggregate: 'entitlement.grant',
          aggregateId: GRANT,
          type: 'entitlement.grant.usage',
          payload: { tenantId: TENANT, userId: USER, grantId: GRANT, consumedBytes: '3000' },
        },
      ]);
      // Inside the window: billed, not announced.
      vi.setSystemTime(new Date('2026-09-27T10:00:29Z'));
      await metering.apply(pass({ deltas: [delta({ deltaId: '66666666-6666-4666-8666-666666666667' })] }));
      expect(store.consumed.get(GRANT)).toBe(6000n);
      expect(store.outbox).toHaveLength(1);
      // Past it: the next delta carries the total as committed, both deltas in it.
      vi.setSystemTime(new Date('2026-09-27T10:00:31Z'));
      await metering.apply(pass({ deltas: [delta({ deltaId: '66666666-6666-4666-8666-666666666668' })] }));
      expect(store.outbox).toHaveLength(2);
      expect(store.outbox[1]['payload']).toMatchObject({ consumedBytes: '9000' });
    } finally {
      vi.useRealTimers();
    }
  });

  // F-601-d, F-601-n: the crossing is seen by the charge that moves the bytes, in its transaction; 50 and 80 % wait for a time level.
  describe('usage thresholds', () => {
    const at = new Date('2026-09-27T10:00:00Z');
    const config = [{ id: CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-a' }];
    const thresholds = (outbox: Array<Record<string, unknown>>) => outbox.filter((e) => e['type'] !== 'entitlement.grant.usage');
    const withClock = async (run: () => Promise<void>) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(at);
        await run();
      } finally {
        vi.useRealTimers();
      }
    };

    it('holds 50 and 80 % on the Grant — a higher level replaces the lower, the wait keeps its start — and tells nothing yet', () =>
      withClock(async () => {
        const renewedAt = new Date('2026-09-20T00:00:00Z');
        const store = fakeStore(config, [], { purchasedBytes: 10_000n, usagePeriodStartedAt: renewedAt });
        const metering = service(store);
        // 3000 of 10 000: under 50 %. Then 6000 (over 50 %), 9000 (over 80 %).
        await metering.apply(pass({ deltas: [delta()] }));
        await metering.apply(pass({ deltas: [delta({ deltaId: '66666666-6666-4666-8666-666666666667' })] }));
        expect(store.notice).toEqual({ usageNoticeLevel: 50, usageNoticeSince: at });
        vi.setSystemTime(new Date(at.getTime() + 3_600_000));
        await metering.apply(pass({ deltas: [delta({ deltaId: '66666666-6666-4666-8666-666666666668' })] }));

        expect(store.notice).toEqual({ usageNoticeLevel: 80, usageNoticeSince: at });
        expect(thresholds(store.outbox)).toEqual([]);
      }));

    it('tells 95 % at once, named by the period, and clears the held level', () =>
      withClock(async () => {
        const store = fakeStore(config, [], { purchasedBytes: 3_100n, usageNoticeLevel: 80, usageNoticeSince: at });
        await service(store).apply(pass({ deltas: [delta()] }));

        expect(thresholds(store.outbox)).toEqual([
          {
            aggregate: 'entitlement.grant',
            aggregateId: GRANT,
            type: 'entitlement.grant.usage_95',
            payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: GRANT_STARTS_AT.toISOString(), percent: '95', remaining: '1 MB' },
          },
        ]);
        expect(store.notice).toEqual({ usageNoticeLevel: null, usageNoticeSince: null });
      }));

    it('tells a time level already due with the usage level, as one event, and moves the end clock past it', () =>
      withClock(async () => {
        const endsAt = new Date('2026-09-30T04:00:00Z'); // the 3-day level fell due 6 h ago, held by the sweep
        const store = fakeStore(config, [], { purchasedBytes: 5_000n, endsAt, endNoticeFor: endsAt, endNoticeAt: new Date('2026-09-27T04:00:00Z') });
        await service(store).apply(pass({ deltas: [delta()] }));

        expect(thresholds(store.outbox).map((e) => e['payload'])).toEqual([
          {
            tenantId: TENANT,
            userId: USER,
            grantId: GRANT,
            period: GRANT_STARTS_AT.toISOString(),
            percent: '50',
            remaining: '1 MB',
            endNotice: 'entitlement.grant.ends_in_3d',
            endPeriod: endsAt.toISOString(),
            days: '3',
          },
        ]);
        expect(store.notice).toEqual({ endNoticeFor: endsAt, endNoticeAt: new Date('2026-09-29T04:00:00Z') });
      }));

    it('never pulls forward a time level not yet due — nothing is told early', () =>
      withClock(async () => {
        const endsAt = new Date('2026-09-30T22:00:00Z'); // the 3-day level is 12 h away
        const store = fakeStore(config, [], { purchasedBytes: 5_000n, endsAt, endNoticeFor: endsAt, endNoticeAt: new Date('2026-09-27T22:00:00Z') });
        await service(store).apply(pass({ deltas: [delta()] }));

        expect(thresholds(store.outbox)).toEqual([]);
        expect(store.notice).toEqual({ usageNoticeLevel: 50, usageNoticeSince: at });
      }));
  });

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

  describe('release (F-027-at, ADR-0080 decision 3)', () => {
    const HOLD = '77777777-7777-4777-8777-777777777777';
    const ADMIN = '88888888-8888-4888-8888-888888888888';
    const heldFrom = new Date('2026-09-21T10:00:00.000Z');

    function heldStore(state: UsageDispositionState = UsageDispositionState.pending) {
      return fakeStore(
        [{ id: CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-a' }],
        [{ id: HOLD, configId: CONFIG, panelId: PANEL, upBytes: 1000n, downBytes: 2000n, heldFrom,
           reason: HoldReason.attribution_ambiguous, state, resolvedAt: null, resolvedByAdminId: null, resolutionNote: null }],
      );
    }
    const release: UsageReleasePayload = { holdId: HOLD, adminId: ADMIN, note: 'client-a is this config' };

    it("bills the hold's own bytes through the meter and flips it, under the config's tenant", async () => {
      const store = heldStore();

      expect(await service(store).release(release)).toBe('released');

      expect(store.consumed.get(GRANT)).toBe(3000n);
      expect(store.rawLog).toEqual([expect.objectContaining({ tenantId: TENANT, configId: CONFIG, uploadBytes: 1000n, downloadBytes: 2000n })]);
      // The seen row is the one a collected delta would have written, keyed
      // by the id derived from the hold — the meter's own deduplication.
      expect([...store.seen.keys()]).toEqual([usageReleaseDeltaId(HOLD)]);
      expect(store.holds[0]).toMatchObject({ state: UsageDispositionState.released, resolvedByAdminId: ADMIN, resolutionNote: release.note });
      expect(store.holds[0]['resolvedAt']).toBeInstanceOf(Date);
      expect(store.bound).toContain(TENANT);
    });

    it('absorbs a second release of the same hold — redelivered or clicked twice — without billing it again', async () => {
      const store = heldStore();
      await service(store).release(release);

      expect(await service(store).release({ ...release, adminId: OTHER_CONFIG, note: 'again' })).toBe('already_resolved');

      expect(store.consumed.get(GRANT)).toBe(3000n);
      expect(store.rawLog).toHaveLength(1);
      expect(store.holds[0]).toMatchObject({ resolvedByAdminId: ADMIN, resolutionNote: release.note });
    });

    it('still bills once when the seen row already exists and the flip is what refuses', async () => {
      // The pre-read of the state is an optimisation: defeat it, and the
      // conditional flip inside the transaction must still hold the line.
      const store = heldStore();
      store.seen.set(usageReleaseDeltaId(HOLD), {});

      expect(await service(store).release(release)).toBe('already_resolved');
      expect(store.consumed.get(GRANT)).toBe(0n);
    });

    it('never bills a hold that was written off, even if a release was already queued', async () => {
      const store = heldStore(UsageDispositionState.written_off);

      expect(await service(store).release(release)).toBe('already_resolved');

      expect(store.consumed.get(GRANT)).toBe(0n);
      expect(store.rawLog).toHaveLength(0);
      expect(store.seen.size).toBe(0);
      expect(store.holds[0]['state']).toBe(UsageDispositionState.written_off);
    });
  });
});
