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
 *    in between is `grant_moved`, never an end changed twice.
 */
import { GrantStatus } from '@prisma/client';

import { changeGrantDuration } from './duration';
import { ADMIN_FROZEN } from './freeze';
import { EntitlementRefused } from './grant';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GRANT = '99999999-9999-4999-8999-999999999991';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const DAY = 86_400_000;
const AT = new Date('2026-09-28T10:00:00.000Z');
const START = new Date(AT.getTime() - 20 * DAY);
const END = new Date(AT.getTime() + 10 * DAY);

type Row = { id: string; tenantId: string; status: GrantStatus; statusReason: string | null; startsAt: Date; endsAt: Date | null };

function build(row: Partial<Row> | null) {
  const grant: Row | null = row
    ? { id: GRANT, tenantId: TENANT, status: GrantStatus.active, statusReason: null, startsAt: START, endsAt: END, ...row }
    : null;
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
    grantDurationChange: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        changes.push(data);
        return { id: 'change-1' };
      },
    },
  };
  return { tx: tx as never, grant, writes, changes };
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
    expect(done).toEqual({ changeId: 'change-1', endsAtBefore: END, endsAtAfter: after });
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
});
