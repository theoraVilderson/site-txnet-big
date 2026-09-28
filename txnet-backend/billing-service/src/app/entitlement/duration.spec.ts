/**
 * An admin changes a Grant's days (F-311-i, spec F-311): its `endsAt` moves by
 * ±N days or to a date, and the move is written down. What would break
 * quietly here, and nowhere else:
 *
 *  - **duration is `endsAt`, not a quota** (§4.5), so no `quota_adjustment`
 *    holds it: each move writes one `grant_duration_change` row — actor, the
 *    end before, the end after, the reason — or the change did not happen;
 *  - **±N days count from the end it has**, not from now: "+3 days after an
 *    outage" is three more days for everyone, whatever is left;
 *  - **a closed Grant is refused** (§4.4 one way): an expired, exhausted or
 *    cancelled Grant comes back only by renewal (F-311-d), never by moving a
 *    date; a permanent one has no end to move;
 *  - **the new end is in the future**: cutting a service short is a delete
 *    (F-311-m), not a date in the past;
 *  - **the write is conditional on the end read** — a renewal or an unfreeze
 *    in between is `grant_moved`, never an end changed twice;
 *  - **days given back to a lapsed Grant revive it** (F-311-z), as a renewal of
 *    days does: a Grant `suspended` as `period_ended` whose end moves ahead is
 *    `active` again and told so — or, on a spent bag, waits as
 *    `quota_exhausted` — so it is never purged with days left on it.
 */
import { GrantStatus, VariantBillingMode } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { changeGrantDuration } from './duration';
import { ADMIN_FROZEN } from './freeze';
import { EntitlementRefused } from './grant';
import { PERIOD_ENDED, QUOTA_EXHAUSTED } from './suspension';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GRANT = '99999999-9999-4999-8999-999999999991';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const GIB = BigInt(1024 ** 3);
const DAY = 86_400_000;
const AT = new Date('2026-09-28T10:00:00.000Z');
const START = new Date(AT.getTime() - 20 * DAY);
const END = new Date(AT.getTime() + 10 * DAY);

type Row = {
  id: string;
  tenantId: string;
  userId: string;
  status: GrantStatus;
  statusReason: string | null;
  suspendedAt: Date | null;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  startsAt: Date;
  endsAt: Date | null;
};

function build(row: Partial<Row> | null, usedBytes = BigInt(0)) {
  const grant: Row | null = row
    ? {
        id: GRANT,
        tenantId: TENANT,
        userId: USER,
        status: GrantStatus.active,
        statusReason: null,
        suspendedAt: null,
        billingMode: VariantBillingMode.prepaid,
        trafficUnlimited: false,
        purchasedBytes: BigInt(50) * GIB,
        startsAt: START,
        endsAt: END,
        ...row,
      }
    : null;
  const configs: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const changes: Array<Record<string, unknown>> = [];
  const same = (a: unknown, b: unknown) => (a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime() : a === b);
  const tx = {
    grant: {
      findFirst: async ({ where }: { where: { id: string } }) => (grant && where.id === grant.id ? { ...grant } : null),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push({ where, data });
        if (!grant || !Object.entries(where).every(([k, v]) => same((grant as Record<string, unknown>)[k], v))) return { count: 0 };
        Object.assign(grant, data);
        return { count: 1 };
      },
    },
    config: {
      findMany: async () => [{ counterState: { lifetimeUpBytes: BigInt(0), lifetimeDownBytes: usedBytes } }],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        configs.push(data);
        return { count: 1 };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { id: 'event-1' };
      },
    },
    grantDurationChange: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        changes.push(data);
        return { id: 'change-1' };
      },
    },
  };
  return { tx: tx as never, grant, writes, changes, configs, events };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EntitlementRefused);
  return (e as EntitlementRefused).reason;
};

const by = (days: number) => ({ at: AT, actorUserId: ADMIN, change: { days }, reason: 'outage 2026-09-27' });
const to = (endsAt: Date) => ({ at: AT, actorUserId: ADMIN, change: { endsAt }, reason: 'agreed with the user' });

describe('changeGrantDuration', () => {
  it('adds N days to the end the Grant has, not to now, and writes the move down', async () => {
    const { tx, grant, changes } = build({});
    const done = await changeGrantDuration(tx, GRANT, by(3));

    const after = new Date(END.getTime() + 3 * DAY);
    expect(done).toEqual({ changeId: 'change-1', endsAtBefore: END, endsAtAfter: after, revived: false, reactivated: false });
    expect(grant?.endsAt).toEqual(after);
    expect(changes).toEqual([
      { tenantId: TENANT, grantId: GRANT, actorUserId: ADMIN, endsAtBefore: END, endsAtAfter: after, reason: 'outage 2026-09-27' },
    ]);
  });

  it('takes days off, and moves to a date', async () => {
    const cut = build({});
    await changeGrantDuration(cut.tx, GRANT, by(-4));
    expect(cut.grant?.endsAt).toEqual(new Date(END.getTime() - 4 * DAY));

    const date = new Date(AT.getTime() + 45 * DAY);
    const set = build({});
    const done = await changeGrantDuration(set.tx, GRANT, to(date));
    expect(done.endsAtAfter).toEqual(date);
    expect(set.changes[0]).toMatchObject({ endsAtBefore: END, endsAtAfter: date, reason: 'agreed with the user' });
  });

  it('moves a suspended Grant too — frozen or out of volume — without touching why it stopped', async () => {
    const frozen = build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN });
    await changeGrantDuration(frozen.tx, GRANT, by(5));
    expect(frozen.grant).toMatchObject({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, endsAt: new Date(END.getTime() + 5 * DAY) });
    expect(Object.keys(frozen.writes[0].data)).toEqual(['endsAt']);
  });

  it.each([GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled])('refuses a %s Grant: that is a renewal, not a date', async (status) => {
    const { tx, writes, changes } = build({ status });
    expect(await refusal(changeGrantDuration(tx, GRANT, by(3)))).toBe('grant_closed');
    expect(writes).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('refuses a pending Grant, a permanent one, and an unknown one', async () => {
    expect(await refusal(changeGrantDuration(build({ status: GrantStatus.pending }).tx, GRANT, by(3)))).toBe('grant_not_active');
    expect(await refusal(changeGrantDuration(build({ endsAt: null }).tx, GRANT, by(3)))).toBe('grant_permanent');
    expect(await refusal(changeGrantDuration(build(null).tx, GRANT, by(3)))).toBe('grant_not_found');
  });

  it('refuses an end that is not in the future — cutting a service off is a delete', async () => {
    const { tx, changes } = build({});
    expect(await refusal(changeGrantDuration(tx, GRANT, by(-10)))).toBe('duration_end_not_future');
    expect(await refusal(changeGrantDuration(tx, GRANT, to(new Date(AT.getTime() - DAY))))).toBe('duration_end_not_future');
    expect(changes).toEqual([]);
  });

  it('refuses a move to the end it already has', async () => {
    const { tx, changes } = build({});
    expect(await refusal(changeGrantDuration(tx, GRANT, to(END)))).toBe('duration_unchanged');
    expect(await refusal(changeGrantDuration(tx, GRANT, by(0)))).toBe('duration_unchanged');
    expect(changes).toEqual([]);
  });

  it('writes conditionally on the end read: a renewal in between is grant_moved, and nothing is written down', async () => {
    const { tx, grant, writes, changes } = build({});
    const read = tx as unknown as { grant: { findFirst: (a: unknown) => Promise<Row> } };
    const original = read.grant.findFirst;
    read.grant.findFirst = async (a) => {
      const r = await original(a);
      (grant as Row).endsAt = new Date(END.getTime() + 30 * DAY);
      return r;
    };
    expect(await refusal(changeGrantDuration(tx, GRANT, by(3)))).toBe('grant_moved');
    expect(writes[0].where).toMatchObject({ id: GRANT, status: GrantStatus.active, endsAt: END });
    expect(changes).toEqual([]);
  });

  describe('a lapsed Grant (F-311-z)', () => {
    const LAPSED_AT = new Date(AT.getTime() - 5 * DAY);
    const lapsed = (row: Partial<Row> = {}, used = BigInt(0)) =>
      build({ status: GrantStatus.suspended, statusReason: PERIOD_ENDED, suspendedAt: LAPSED_AT, endsAt: LAPSED_AT, ...row }, used);

    it('is revived by an end moved ahead — configs back, the purge clock cleared, the revival reported', async () => {
      const { tx, grant, configs, events, changes } = lapsed({}, BigInt(10) * GIB);
      const done = await changeGrantDuration(tx, GRANT, by(30));

      expect(done.revived).toBe(true);
      expect(grant).toMatchObject({ status: GrantStatus.active, statusReason: null, suspendedAt: null, endsAt: new Date(LAPSED_AT.getTime() + 30 * DAY) });
      expect(configs).toEqual([expect.objectContaining({ desiredEnabled: true, desiredRemote: 'present' })]);
      // F-311-s: told once, in the admin's own notice, never as a second "active again".
      expect(done.reactivated).toBe(true);
      expect(events).toEqual([]);
      expect(changes).toHaveLength(1);
    });

    it('revives an unlimited or metered Grant on days alone — it has no bag to be spent', async () => {
      for (const row of [{ trafficUnlimited: true }, { billingMode: VariantBillingMode.metered }]) {
        const { tx, grant } = lapsed(row, BigInt(900) * GIB);
        expect((await changeGrantDuration(tx, GRANT, to(new Date(AT.getTime() + 7 * DAY)))).revived).toBe(true);
        expect(grant?.status).toBe(GrantStatus.active);
      }
    });

    it('on a spent bag gets its days but waits as quota_exhausted, its purge clock still running, untold', async () => {
      const { tx, grant, configs, events } = lapsed({}, BigInt(50) * GIB);
      const done = await changeGrantDuration(tx, GRANT, by(30));

      expect(done.revived).toBe(false);
      expect(grant).toMatchObject({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: LAPSED_AT });
      expect(configs).toEqual([]);
      expect(events).toEqual([]);
    });

    it('still refuses an end that stays in the past, and revives nothing', async () => {
      const { tx, grant, changes } = lapsed();
      expect(await refusal(changeGrantDuration(tx, GRANT, by(3)))).toBe('duration_end_not_future');
      expect(grant).toMatchObject({ status: GrantStatus.suspended, statusReason: PERIOD_ENDED });
      expect(changes).toEqual([]);
    });

    it('leaves a Grant suspended for another reason as it was', async () => {
      const { tx, grant, events } = build({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: LAPSED_AT });
      expect((await changeGrantDuration(tx, GRANT, by(3))).revived).toBe(false);
      expect(grant).toMatchObject({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED });
      expect(events).toEqual([]);
    });
  });
});
