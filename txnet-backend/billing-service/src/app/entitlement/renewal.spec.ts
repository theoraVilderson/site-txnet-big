/**
 * A renewal is `Quota += X` on the same Grant (F-027-dg; SPEC weakness #30).
 *
 * Quota (`purchasedBytes`) and Used (Σ lifetime counters, retired configs
 * included — the lease planner's own sum) are cumulative per Grant, so what one
 * period under- or over-delivered moves to the next by arithmetic alone. The
 * one rule on top is the user's (2026-09-27): a debt of up to 2 GiB — the
 * panel's tick lag, not the user's doing — is forgiven at renewal; a larger one
 * is carried whole.
 */
import { GrantSource, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { EntitlementRefused } from './grant';
import { DEBT_FORGIVEN, DEBT_FORGIVEN_UP_TO, carryOver, renewGrant } from './renewal';
import { QUOTA_EXHAUSTED } from './suspension';

const GIB = BigInt(1024 ** 3);
const GRANT = '99999999-9999-4999-8999-999999999991';
const TENANT = '77777777-7777-4777-8777-777777777771';
const AT = new Date('2026-09-27T12:00:00Z');
const DAY_MS = 86_400_000;

type Row = {
  id: string;
  tenantId: string;
  status: GrantStatus;
  statusReason: string | null;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  endsAt: Date | null;
  consumedBytes: bigint;
};

function build(row: Partial<Row> | null, usedPerConfig: bigint[], opts: { moved?: boolean } = {}) {
  const grant: Row | null = row && {
    id: GRANT,
    tenantId: TENANT,
    status: GrantStatus.active,
    statusReason: null,
    billingMode: VariantBillingMode.prepaid,
    trafficUnlimited: false,
    purchasedBytes: BigInt(10) * GIB,
    endsAt: new Date(AT.getTime() + 3 * DAY_MS),
    consumedBytes: BigInt(7) * GIB,
    ...row,
  };
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const adjustments: Array<Record<string, unknown>> = [];
  const configScans: Array<Record<string, unknown>> = [];
  const tx = {
    grant: {
      findUnique: async () => grant,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        // The first write is the renewal's own; a later one is the revive.
        if (updates.length === 1) return { count: opts.moved ? 0 : 1 };
        return { count: 1 };
      },
    },
    config: {
      findMany: async (args: Record<string, unknown>) => {
        configScans.push(args);
        return usedPerConfig.map((b) => ({ counterState: { lifetimeUpBytes: b / BigInt(2), lifetimeDownBytes: b - b / BigInt(2) } }));
      },
      updateMany: async () => ({ count: usedPerConfig.length }),
    },
    quotaAdjustment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        adjustments.push(data);
        return data;
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, updates, adjustments, configScans };
}

const renew = (tx: Prisma.TransactionClient, bytes: bigint, days = 30) =>
  renewGrant(tx, { grantId: GRANT, bytes, days, source: GrantSource.purchase, at: AT });

describe('carryOver', () => {
  it('carries a credit by doing nothing: the unused bytes are still under Quota', () => {
    expect(carryOver({ purchasedBytes: BigInt(10) * GIB, usedBytes: BigInt(7) * GIB, bytes: BigInt(10) * GIB })).toEqual({
      debtBytes: BigInt(0),
      forgivenBytes: BigInt(0),
      raiseBytes: BigInt(10) * GIB,
    });
  });

  it('forgives a debt of up to 2 GiB, the bound included', () => {
    expect(DEBT_FORGIVEN_UP_TO).toBe(BigInt(2) * GIB);
    expect(carryOver({ purchasedBytes: BigInt(10) * GIB, usedBytes: BigInt(11) * GIB, bytes: BigInt(10) * GIB })).toEqual({
      debtBytes: GIB,
      forgivenBytes: GIB,
      raiseBytes: BigInt(11) * GIB,
    });
    expect(carryOver({ purchasedBytes: BigInt(10) * GIB, usedBytes: BigInt(12) * GIB, bytes: BigInt(10) * GIB }).forgivenBytes).toBe(BigInt(2) * GIB);
  });

  it('carries a debt over 2 GiB whole — not only the part above the bound', () => {
    expect(carryOver({ purchasedBytes: BigInt(10) * GIB, usedBytes: BigInt(12) * GIB + BigInt(1), bytes: BigInt(10) * GIB })).toEqual({
      debtBytes: BigInt(2) * GIB + BigInt(1),
      forgivenBytes: BigInt(0),
      raiseBytes: BigInt(10) * GIB,
    });
  });
});

describe('renewGrant', () => {
  it('raises Quota on the same Grant, moves its end, and writes the history', async () => {
    const { tx, updates, adjustments } = build({}, [BigInt(4) * GIB, BigInt(3) * GIB]);

    const r = await renew(tx, BigInt(10) * GIB);

    expect(r).toMatchObject({ debtBytes: BigInt(0), forgivenBytes: BigInt(0), purchasedBytes: BigInt(20) * GIB, revived: false });
    expect(updates[0].where).toEqual({ id: GRANT, status: GrantStatus.active, purchasedBytes: BigInt(10) * GIB, endsAt: new Date(AT.getTime() + 3 * DAY_MS) });
    // Bytes bought open a usage period, measured from what was consumed (F-601-d).
    expect(updates[0].data).toEqual({
      purchasedBytes: BigInt(20) * GIB,
      endsAt: new Date(AT.getTime() + 33 * DAY_MS),
      usagePeriodFromBytes: BigInt(7) * GIB,
      usagePeriodStartedAt: AT,
    });
    expect(adjustments).toEqual([
      expect.objectContaining({ grantId: GRANT, tenantId: TENANT, delta: BigInt(10) * GIB, source: GrantSource.purchase, reason: null }),
    ]);
  });

  it('leaves the usage period alone on a renewal of days alone (F-601-d)', async () => {
    const { tx, updates } = build({}, [BigInt(7) * GIB]);
    await renew(tx, BigInt(0), 30);
    expect(updates[0].data).not.toHaveProperty('usagePeriodFromBytes');
    expect(updates[0].data).not.toHaveProperty('usagePeriodStartedAt');
  });

  it('adds a forgiven debt to Quota as its own adjustment row', async () => {
    const { tx, updates, adjustments } = build({}, [BigInt(11) * GIB]);

    const r = await renew(tx, BigInt(10) * GIB);

    expect(r).toMatchObject({ debtBytes: GIB, forgivenBytes: GIB, purchasedBytes: BigInt(21) * GIB });
    expect(updates[0].data['purchasedBytes']).toBe(BigInt(21) * GIB);
    expect(adjustments.map((a) => [a['delta'], a['reason']])).toEqual([
      [BigInt(10) * GIB, null],
      [GIB, DEBT_FORGIVEN],
    ]);
  });

  it('counts retired configs in Used, as the planner does', async () => {
    const { tx, configScans } = build({}, [GIB]);
    await renew(tx, GIB);
    expect(configScans[0]['where']).toEqual({ grantId: GRANT });
  });

  it('extends a Grant already past its end from now, and leaves a permanent Grant permanent', async () => {
    const late = build({ endsAt: new Date(AT.getTime() - DAY_MS) }, []);
    await renew(late.tx, GIB, 30);
    expect(late.updates[0].data['endsAt']).toEqual(new Date(AT.getTime() + 30 * DAY_MS));

    const forever = build({ endsAt: null }, []);
    await renew(forever.tx, GIB, 30);
    expect(forever.updates[0].data['endsAt']).toBeNull();
  });

  it('revives a Grant suspended for quota once the bag has room again', async () => {
    const { tx, updates } = build({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED }, [BigInt(10) * GIB]);

    const r = await renew(tx, BigInt(10) * GIB);

    expect(r.revived).toBe(true);
    expect(updates[1].where).toMatchObject({ id: GRANT, status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED });
  });

  it('leaves it suspended when a carried debt still eats the whole renewal', async () => {
    const { tx, updates } = build({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED }, [BigInt(15) * GIB]);

    const r = await renew(tx, BigInt(5) * GIB);

    expect(r).toMatchObject({ debtBytes: BigInt(5) * GIB, forgivenBytes: BigInt(0), purchasedBytes: BigInt(15) * GIB, revived: false });
    expect(updates).toHaveLength(1);
  });

  it('only lengthens a metered or unlimited Grant: bytes there are refused', async () => {
    const metered = build({ billingMode: VariantBillingMode.metered, purchasedBytes: BigInt(0) }, []);
    await expect(renew(metered.tx, GIB)).rejects.toMatchObject({ reason: 'traffic_not_renewable' });
    const r = await renew(metered.tx, BigInt(0), 30);
    expect(r.forgivenBytes).toBe(BigInt(0));

    const unlimited = build({ trafficUnlimited: true, purchasedBytes: BigInt(0) }, []);
    await expect(renew(unlimited.tx, GIB)).rejects.toMatchObject({ reason: 'traffic_not_renewable' });
  });

  it.each([GrantStatus.pending, GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled])(
    'refuses a %s Grant and writes nothing',
    async (status) => {
      const { tx, updates, adjustments } = build({ status }, []);
      await expect(renew(tx, GIB)).rejects.toMatchObject({ reason: 'grant_not_renewable' });
      expect(updates).toHaveLength(0);
      expect(adjustments).toHaveLength(0);
    },
  );

  it('refuses when the Grant moved between the read and the write, so a debt is never forgiven twice', async () => {
    const { tx, adjustments } = build({}, [BigInt(11) * GIB], { moved: true });
    const err = await renew(tx, GIB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntitlementRefused);
    expect(err).toMatchObject({ reason: 'grant_moved' });
    expect(adjustments).toHaveLength(0);
  });

  it('refuses nothing to renew, and an unknown Grant', async () => {
    await expect(renew(build({}, []).tx, BigInt(0), 0)).rejects.toMatchObject({ reason: 'nothing_to_renew' });
    await expect(renew(build(null, []).tx, GIB)).rejects.toMatchObject({ reason: 'grant_not_found' });
  });
});
