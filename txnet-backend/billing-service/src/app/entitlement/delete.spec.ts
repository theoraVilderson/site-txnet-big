/**
 * An admin deletes a user's service (F-311-m, spec F-311). What would break
 * quietly here, and nowhere else:
 *
 *  - **the seat is released now**, not after `purgeAfterDays`: every config
 *    still `present` goes to `desiredRemote = absent` in the same transaction
 *    that cancels the Grant — desired state, the loop deletes the client;
 *  - **our rows are kept** (invariant 13): the Grant is `cancelled` with
 *    `statusReason = admin_deleted`, no row is deleted, `remoteId` untouched;
 *  - **the remainder is the admin's call** (user, 2026-09-26): with `refund`
 *    the metered remainder goes back through F-027-r in the same transaction;
 *    without it (fraud) nothing is credited — and either way the choice, the
 *    reason and what was credited are one `grant_deletion` row;
 *  - **a block bought in between rolls the delete back** (`grant_moved`),
 *    never a Grant cancelled with its money half-settled;
 *  - **only an open Grant is deleted**: a closed one is already off, and a
 *    `pending` one is the delivery's to deliver or refund (invariant 14).
 */
import { DesiredRemote, EnforcementState, GrantStatus, Prisma } from '@prisma/client';

import { ADMIN_DELETED, deleteGrant, RemainderSettler } from './delete';
import { EntitlementRefused } from './grant';
import { ADMIN_FROZEN, QUOTA_EXHAUSTED } from './suspension';
import { RemainderCreditRefused } from '../traffic/remainder-credit';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GRANT = '99999999-9999-4999-8999-999999999991';
const ADMIN = '77777777-7777-4777-8777-777777777777';
const WALLET_ROW = '55555555-5555-4555-8555-555555555555';

type Row = { id: string; tenantId: string; status: GrantStatus; statusReason: string | null; frozenUntil: Date | null };
type Write = { where: Record<string, unknown>; data: Record<string, unknown> };

function build(row: Partial<Row> | null, opts: { moved?: boolean } = {}) {
  const grant: Row | null = row ? { id: GRANT, tenantId: TENANT, status: GrantStatus.active, statusReason: null, frozenUntil: null, ...row } : null;
  const grants: Write[] = [];
  const configs: Write[] = [];
  const deletions: Record<string, unknown>[] = [];
  const tx = {
    grant: {
      findFirst: async ({ where }: { where: { id: string } }) => (grant && where.id === grant.id ? { ...grant } : null),
      updateMany: async ({ where, data }: Write) => {
        grants.push({ where, data });
        if (opts.moved || !grant || !Object.entries(where).every(([k, v]) => (grant as Record<string, unknown>)[k] === v)) return { count: 0 };
        Object.assign(grant, data);
        return { count: 1 };
      },
    },
    config: {
      updateMany: async ({ where, data }: Write) => {
        configs.push({ where, data });
        return { count: 3 };
      },
    },
    grantDeletion: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        deletions.push(data);
        return { id: 'deletion-1' };
      },
    },
  };
  return { tx: tx as never, grant, grants, configs, deletions };
}

/** F-027-r's credit, as the caller hands it in: sees the Grant already cancelled. */
function settler(outcome: 'credited' | RemainderCreditRefused['reason']) {
  const calls: string[] = [];
  const settle: RemainderSettler = async (_tx, grantId) => {
    calls.push(grantId);
    if (outcome !== 'credited') throw new RemainderCreditRefused(outcome);
    return { amount: new Prisma.Decimal('1.25'), walletTransactionId: WALLET_ROW };
  };
  return { settle, calls };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EntitlementRefused);
  return (e as EntitlementRefused).reason;
};

const at = new Date('2026-09-28T10:00:00Z');
const input = (refund: boolean) => ({ at, actorUserId: ADMIN, reason: 'fraud report #12', refund });

describe('deleteGrant', () => {
  it('cancels an active Grant as admin_deleted and releases every present config now', async () => {
    const { tx, grant, grants, configs } = build({});

    const result = await deleteGrant(tx, GRANT, input(false), settler('credited').settle);

    expect(grant).toMatchObject({ status: GrantStatus.cancelled, statusReason: ADMIN_DELETED, frozenUntil: null });
    // Conditional on the status and reason read: a Grant that moved on is `grant_moved`.
    expect(grants[0].where).toEqual({ id: GRANT, status: GrantStatus.active, statusReason: null });
    // Desired state only, the rows kept: the loop deletes the client and clears `remoteId`.
    expect(configs).toEqual([
      {
        where: { grantId: GRANT, desiredRemote: DesiredRemote.present },
        data: { desiredRemote: DesiredRemote.absent, desiredEnabled: false, enforcementState: EnforcementState.pending },
      },
    ]);
    expect(result).toMatchObject({ deletionId: 'deletion-1', statusBefore: GrantStatus.active, configsReleased: 3, refund: false, refundedAmount: null });
  });

  it('with no refund credits nothing and writes the choice down with the reason', async () => {
    const { tx, deletions } = build({});
    const { settle, calls } = settler('credited');

    await deleteGrant(tx, GRANT, input(false), settle);

    expect(calls).toHaveLength(0);
    expect(deletions).toEqual([
      {
        tenantId: TENANT,
        grantId: GRANT,
        actorUserId: ADMIN,
        reason: 'fraud report #12',
        statusBefore: GrantStatus.active,
        refundRemainder: false,
        refundedAmount: null,
        walletTransactionId: null,
        refundSkipped: null,
      },
    ]);
  });

  it('with a refund gives the metered remainder back after the cancel, in the same transaction, and records it', async () => {
    const { tx, deletions } = build({});

    const result = await deleteGrant(tx, GRANT, input(true), settler('credited').settle);

    expect(result).toMatchObject({ refund: true, refundedAmount: '1.25', walletTransactionId: WALLET_ROW, refundSkipped: null });
    expect(deletions[0]).toMatchObject({ refundRemainder: true, refundedAmount: new Prisma.Decimal('1.25'), walletTransactionId: WALLET_ROW, refundSkipped: null });
  });

  it('a refund with nothing to give back (prepaid, or all served) still deletes, and says why nothing was credited', async () => {
    for (const why of ['grant_not_metered', 'nothing_to_credit', 'rate_not_priceable'] as const) {
      const { tx, grant, deletions } = build({});
      const result = await deleteGrant(tx, GRANT, input(true), settler(why).settle);
      expect(grant?.status).toBe(GrantStatus.cancelled);
      expect(result).toMatchObject({ refund: true, refundedAmount: null, refundSkipped: why });
      expect(deletions[0]).toMatchObject({ refundRemainder: true, refundedAmount: null, walletTransactionId: null, refundSkipped: why });
    }
  });

  it('a block bought between the read and the credit rolls the whole delete back as grant_moved', async () => {
    const { tx, deletions } = build({});
    expect(await refusal(deleteGrant(tx, GRANT, input(true), settler('cursor_moved').settle))).toBe('grant_moved');
    expect(deletions).toHaveLength(0);
  });

  it('deletes a suspended Grant — frozen or out of quota — and clears a timed freeze', async () => {
    const frozen = build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, frozenUntil: new Date(at.getTime() + 86_400_000) });
    await deleteGrant(frozen.tx, GRANT, input(false), settler('credited').settle);
    expect(frozen.grant).toMatchObject({ status: GrantStatus.cancelled, statusReason: ADMIN_DELETED, frozenUntil: null });
    expect(frozen.deletions[0]).toMatchObject({ statusBefore: GrantStatus.suspended });

    const spent = build({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED });
    await deleteGrant(spent.tx, GRANT, input(false), settler('credited').settle);
    expect(spent.grants[0].where).toEqual({ id: GRANT, status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED });
    expect(spent.grant?.status).toBe(GrantStatus.cancelled);
  });

  it('refuses a closed Grant and a pending one, writing nothing', async () => {
    for (const status of [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled]) {
      const { tx, grants, configs } = build({ status });
      expect(await refusal(deleteGrant(tx, GRANT, input(true), settler('credited').settle))).toBe('grant_closed');
      expect([...grants, ...configs]).toHaveLength(0);
    }
    const pending = build({ status: GrantStatus.pending });
    expect(await refusal(deleteGrant(pending.tx, GRANT, input(false), settler('credited').settle))).toBe('grant_not_active');
    expect(await refusal(deleteGrant(build(null).tx, GRANT, input(false), settler('credited').settle))).toBe('grant_not_found');
  });

  it('a Grant that moved between the read and the write is grant_moved, and no config is touched', async () => {
    const { tx, configs, deletions } = build({}, { moved: true });
    expect(await refusal(deleteGrant(tx, GRANT, input(false), settler('credited').settle))).toBe('grant_moved');
    expect(configs).toHaveLength(0);
    expect(deletions).toHaveLength(0);
  });
});
