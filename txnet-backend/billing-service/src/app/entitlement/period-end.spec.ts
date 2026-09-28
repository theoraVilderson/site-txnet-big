/**
 * An expired Grant stays renewable in place (F-027-do; user 2026-09-27).
 *
 * Running out of days is `suspended` with `statusReason = period_ended` and a
 * purge clock — never `expired`, which `grant_status_one_way` makes terminal —
 * so `renewGrant` reaches the Grant, its link, configs and debt, until the
 * purge. What breaks without anyone seeing it:
 *  - **a new Grant per lapsed period.** A terminal expiry leaves a renewal
 *    nothing to land on; the user gets a new link and loses the carried debt;
 *  - **a metered or unlimited Grant held forever.** Its end suspended nothing,
 *    so no purge clock ran and its panel seat was never freed;
 *  - **bytes that revive a lapsed Grant.** A top-up or an admin's traffic buys
 *    traffic, not time: the reason keeps them apart;
 *  - **a lapsed metered user told to top up.** Only a renewal of days helps.
 */
import { GrantSource, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { suspendIfClosed } from '../traffic/exhaustion';
import { reviveOnTopUp } from './purge';
import { purgeNoticeType } from './purge-notice';
import { renewGrant } from './renewal';
import { PERIOD_ENDED, QUOTA_EXHAUSTED } from './suspension';

const GIB = BigInt(1024 ** 3);
const GRANT = '99999999-9999-4999-8999-999999999992';
const TENANT = '77777777-7777-4777-8777-777777777772';
const USER = '44444444-4444-4444-8444-444444444442';
const AT = new Date('2026-09-28T12:00:00Z');
const ENDED = new Date('2026-09-28T09:00:00Z');
const DAY_MS = 86_400_000;

type Write = { where: Record<string, unknown>; data: Record<string, unknown> };

describe('a close on a passed end suspends as period_ended (suspendIfClosed)', () => {
  function closedTx(grant: { billingMode?: VariantBillingMode; trafficUnlimited?: boolean; purchasedBytes?: bigint }, closeQuota: bigint) {
    const row = {
      tenantId: TENANT,
      userId: USER,
      status: GrantStatus.active,
      billingMode: VariantBillingMode.prepaid,
      trafficUnlimited: false,
      purchasedBytes: BigInt(1000),
      endsAt: ENDED,
      ...grant,
    };
    const writes: Write[] = [];
    const events: string[] = [];
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray) =>
        sql.join('?').includes('entitlement"."grant"') ? [row] : [{ quotaBytes: closeQuota, expiresAt: ENDED }],
      grant: {
        updateMany: async (args: Write) => {
          writes.push(args);
          return { count: 1 };
        },
      },
      config: { updateMany: async () => ({ count: 2 }) },
      outboxEvent: {
        create: async (args: { data: { type: string } }) => {
          events.push(args.data.type);
          return { id: 'e' };
        },
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, writes, events };
  }

  it.each([
    ['prepaid', {}],
    ['metered', { billingMode: VariantBillingMode.metered, purchasedBytes: BigInt(0) }],
    ['unlimited', { trafficUnlimited: true, purchasedBytes: BigInt(0) }],
  ])('a %s Grant: suspended with a clock, told it ended', async (_, grant) => {
    const { tx, writes, events } = closedTx(grant, BigInt(1000));
    await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toEqual({ grantId: GRANT, verdict: 'suspended', configsDisabled: 2 });
    expect(writes[0]).toEqual({
      where: { id: GRANT, status: GrantStatus.active },
      data: { status: GrantStatus.suspended, statusReason: PERIOD_ENDED, suspendedAt: AT },
    });
    expect(events).toEqual([OutboxEventType.GRANT_ENDED]);
  });

  it('a passed end wins over a Quota a renewal of bytes alone moved: the time is still gone', async () => {
    const { tx, writes } = closedTx({ purchasedBytes: BigInt(2000) }, BigInt(1000));
    await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'suspended' });
    expect(writes[0].data['statusReason']).toBe(PERIOD_ENDED);
  });
});

describe('renewGrant on a Grant whose period ended', () => {
  function build(row: { billingMode?: VariantBillingMode; trafficUnlimited?: boolean; purchasedBytes?: bigint }, usedBytes: bigint) {
    const grant = {
      id: GRANT,
      tenantId: TENANT,
      userId: USER,
      status: GrantStatus.suspended,
      statusReason: PERIOD_ENDED,
      suspendedAt: ENDED,
      billingMode: VariantBillingMode.prepaid,
      trafficUnlimited: false,
      purchasedBytes: BigInt(10) * GIB,
      endsAt: ENDED,
      consumedBytes: usedBytes,
      ...row,
    };
    const writes: Write[] = [];
    const events: string[] = [];
    const tx = {
      grant: {
        findUnique: async () => grant,
        updateMany: async (args: Write) => {
          writes.push(args);
          return { count: 1 };
        },
      },
      config: {
        findMany: async () => [{ counterState: { lifetimeUpBytes: BigInt(0), lifetimeDownBytes: usedBytes } }],
        updateMany: async () => ({ count: 1 }),
      },
      leaseClose: { findUnique: async () => null },
      outboxEvent: {
        create: async (args: { data: { type: string } }) => {
          events.push(args.data.type);
          return { id: 'e' };
        },
      },
      quotaAdjustment: { create: async ({ data }: { data: unknown }) => data },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, writes, events };
  }

  const renew = (tx: Prisma.TransactionClient, bytes: bigint, days: number) =>
    renewGrant(tx, { grantId: GRANT, bytes, days, source: GrantSource.purchase, at: AT });

  it.each([
    ['prepaid with bytes left', {}, BigInt(0)],
    ['metered', { billingMode: VariantBillingMode.metered, purchasedBytes: BigInt(0) }, BigInt(0)],
    ['unlimited', { trafficUnlimited: true, purchasedBytes: BigInt(0) }, BigInt(0)],
  ])('revives a %s Grant on the same row, its end moved from now, and tells it', async (_, row, bytes) => {
    const { tx, writes, events } = build(row, BigInt(4) * GIB);

    const r = await renew(tx, bytes, 30);

    expect(r).toMatchObject({ revived: true, endsAt: new Date(AT.getTime() + 30 * DAY_MS) });
    expect(writes[0].where).toMatchObject({ id: GRANT, status: GrantStatus.suspended });
    expect(writes[1]).toEqual({
      where: { id: GRANT, status: GrantStatus.suspended, statusReason: PERIOD_ENDED },
      data: { status: GrantStatus.active, statusReason: null, suspendedAt: null },
    });
    expect(events).toEqual([OutboxEventType.GRANT_REACTIVATED]);
  });

  it('revives nothing on bytes alone: the end is still behind it', async () => {
    const { tx, writes, events } = build({}, BigInt(4) * GIB);
    await expect(renew(tx, GIB, 0)).resolves.toMatchObject({ revived: false });
    expect(writes).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('days onto a spent bag: still suspended, but now for quota, so the next bytes revive it', async () => {
    const { tx, writes, events } = build({}, BigInt(15) * GIB);

    await expect(renew(tx, BigInt(0), 30)).resolves.toMatchObject({ revived: false });

    // The purge clock keeps running: the user has had no service since it started.
    expect(writes[1]).toEqual({
      where: { id: GRANT, status: GrantStatus.suspended, statusReason: PERIOD_ENDED },
      data: { statusReason: QUOTA_EXHAUSTED },
    });
    expect(events).toEqual([]);
  });
});

describe('what does not revive a Grant whose period ended', () => {
  it('a top-up, or an admin’s bytes, buys traffic, not time: reviveOnTopUp is guarded on quota_exhausted', async () => {
    const writes: Write[] = [];
    const tx = {
      grant: {
        updateMany: async (args: Write) => {
          writes.push(args);
          return { count: args.where['statusReason'] === PERIOD_ENDED ? 1 : 0 };
        },
      },
    } as unknown as Prisma.TransactionClient;
    await expect(reviveOnTopUp(tx, GRANT)).resolves.toEqual({ revived: false, configsRestored: 0 });
    expect(writes[0].where).toMatchObject({ statusReason: QUOTA_EXHAUSTED });
  });

  it('its purge notice says renew, a metered one too — a top-up would not bring it back', () => {
    expect(purgeNoticeType(VariantBillingMode.metered, PERIOD_ENDED)).toBe(OutboxEventType.GRANT_PURGE_SOON);
    expect(purgeNoticeType(VariantBillingMode.metered, QUOTA_EXHAUSTED)).toBe(OutboxEventType.GRANT_PURGE_SOON_METERED);
    expect(purgeNoticeType(VariantBillingMode.prepaid, PERIOD_ENDED)).toBe(OutboxEventType.GRANT_PURGE_SOON);
  });
});
