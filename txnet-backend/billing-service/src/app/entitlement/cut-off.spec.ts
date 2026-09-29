/**
 * Cutoff notices — a user whose service stopped is told why, and what brings
 * it back (F-601-b, spec 9.5).
 *
 * What breaks without anyone seeing it:
 *  - **a metered user told to renew.** Renewing a metered Grant adds days,
 *    never bytes, so it revives nothing; the wallet top-up does
 *    (`reviveFundedGrants`). The wrong word leaves them cut off, waiting;
 *  - **an unlimited Grant cut off in silence.** It has no bag, so time is the
 *    only way it ends: its close on a passed end suspends it (F-027-do) and
 *    tells it;
 *  - **a renewed Grant told it stopped.** A close read after a renewal moved
 *    the end is not a cutoff — and a prepaid one must not be suspended on it
 *    either (`network/contract.lease.md` rule 25: Quota **or** the end);
 *  - **a notice with no period.** notification's ledger holds a notice once
 *    per period; without one the consumer dead-letters it.
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { suspendIfClosed, suspendIfExhausted } from '../traffic/exhaustion';

const GRANT = '77777777-7777-4777-8777-777777777777';
const USER = '44444444-4444-4444-8444-444444444444';
const TENANT = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-09-27T10:00:00Z');
const ENDED = new Date('2026-09-27T09:00:00Z');
const LATER = new Date('2026-10-27T09:00:00Z');

type Event = { aggregate: string; aggregateId: string; type: string; payload: Record<string, unknown> };

type Row = {
  tenantId: string;
  userId: string;
  status: GrantStatus;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  endsAt: Date | null;
};

/** A Grant the planner closed; `close` is the row it wrote, `null` for none. */
function closedTx(grant: Partial<Row>, close: { quotaBytes: bigint; expiresAt: Date | null } | null) {
  const row: Row = {
    tenantId: TENANT,
    userId: USER,
    status: GrantStatus.active,
    billingMode: VariantBillingMode.prepaid,
    trafficUnlimited: false,
    purchasedBytes: BigInt(1000),
    endsAt: LATER,
    ...grant,
  };
  const events: Event[] = [];
  const grantWrites: unknown[] = [];
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray) => (sql.join('?').includes('entitlement"."grant"') ? [row] : close ? [close] : []),
    grant: {
      // The reserve release (F-118-b) reads the Grant; vpn-reserve.spec.ts holds it.
      findUnique: async () => null,
      updateMany: async (args: { where: { status?: GrantStatus } }) => {
        grantWrites.push(args);
        return { count: row.status === args.where.status ? 1 : 0 };
      },
    },
    config: { updateMany: async () => ({ count: 2 }) },
    outboxEvent: {
      create: async (args: { data: Event }) => {
        events.push(args.data);
        return { id: 'e1' };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, events, grantWrites };
}

describe('cutoff notices on a close (suspendIfClosed)', () => {
  it('a prepaid Grant whose bag is spent is suspended and told its volume ran out — period = the suspension', async () => {
    const { tx, events } = closedTx({}, { quotaBytes: BigInt(1000), expiresAt: LATER });
    await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'suspended' });
    expect(events).toEqual([
      {
        aggregate: 'entitlement.grant',
        aggregateId: GRANT,
        type: OutboxEventType.GRANT_VOLUME_SPENT,
        payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: AT.toISOString() },
      },
    ]);
  });

  it('a prepaid Grant closed on its end is told it ended — period = the end, so a renewal opens a new one', async () => {
    const { tx, events } = closedTx({ endsAt: ENDED }, { quotaBytes: BigInt(1000), expiresAt: ENDED });
    await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'suspended' });
    expect(events.map((e) => [e.type, e.payload['period']])).toEqual([[OutboxEventType.GRANT_ENDED, ENDED.toISOString()]]);
  });

  it('an unlimited or a metered Grant closed on its end is suspended (F-027-do) and told it ended', async () => {
    for (const grant of [{ trafficUnlimited: true, purchasedBytes: BigInt(0) }, { billingMode: VariantBillingMode.metered }]) {
      const { tx, events } = closedTx({ ...grant, endsAt: ENDED }, { quotaBytes: BigInt(0), expiresAt: ENDED });
      await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'suspended' });
      expect(events.map((e) => e.type)).toEqual([OutboxEventType.GRANT_ENDED]);
    }
  });

  it('an unlimited or a metered Grant closed with time left is told nothing — its close is a bag, not the end', async () => {
    for (const grant of [{ trafficUnlimited: true }, { billingMode: VariantBillingMode.metered }]) {
      const { tx, events } = closedTx(grant, { quotaBytes: BigInt(1000), expiresAt: LATER });
      await suspendIfClosed(tx, GRANT, AT);
      expect(events).toEqual([]);
    }
  });

  it('a close whose end a renewal moved is reopened: nothing suspended, nobody told', async () => {
    const { tx, events, grantWrites } = closedTx({ endsAt: LATER }, { quotaBytes: BigInt(1000), expiresAt: ENDED });
    await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'reopened' });
    expect(events).toEqual([]);
    expect(grantWrites).toEqual([]);
  });

  it('a Grant already suspended is told nothing again on a redelivered close', async () => {
    const { tx, events } = closedTx({ status: GrantStatus.suspended }, { quotaBytes: BigInt(1000), expiresAt: LATER });
    await expect(suspendIfClosed(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'not_active' });
    expect(events).toEqual([]);
  });
});

describe('cutoff notices on a metered exhaustion (suspendIfExhausted)', () => {
  function exhaustedTx(status: GrantStatus = GrantStatus.active) {
    const events: Event[] = [];
    const grant = {
      tenantId: TENANT,
      userId: USER,
      status,
      billingMode: VariantBillingMode.metered,
      purchasedBytes: BigInt(1000),
      consumedBytes: BigInt(1000),
      trafficUnlimited: false,
    };
    const tx = {
      grant: {
        findUnique: async () => grant,
        updateMany: async (args: { where: { status?: GrantStatus } }) => ({ count: grant.status === args.where.status ? 1 : 0 }),
      },
      // No wallet row: the reserve release (F-118-b) holds nothing here; vpn-reserve.spec.ts holds it.
      // Its prepaid vpn.traffic meter at 50c/GiB (F-118-l).
      grantMeter: { findUnique: async () => ({ mode: 'prepaid', unitPrice: new Prisma.Decimal('0.5'), currencyCode: 'USD' }) },
      wallet: { findUnique: async () => null },
      config: { updateMany: async () => ({ count: 1 }) },
      $queryRaw: async () => [{ cachedBalance: new Prisma.Decimal('0.00') }],
      outboxEvent: {
        create: async (args: { data: Event }) => {
          events.push(args.data);
          return { id: 'e1' };
        },
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, events };
  }

  it('a metered Grant suspended for an empty wallet is told to top up, never to renew — period = the suspension', async () => {
    const { tx, events } = exhaustedTx();
    await expect(suspendIfExhausted(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'suspended' });
    expect(events).toEqual([
      {
        aggregate: 'entitlement.grant',
        aggregateId: GRANT,
        type: OutboxEventType.GRANT_WALLET_SPENT,
        payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: AT.toISOString() },
      },
    ]);
  });

  it('nothing suspended is nothing told', async () => {
    const { tx, events } = exhaustedTx(GrantStatus.suspended);
    await expect(suspendIfExhausted(tx, GRANT, AT)).resolves.toMatchObject({ verdict: 'not_active' });
    expect(events).toEqual([]);
  });
});
