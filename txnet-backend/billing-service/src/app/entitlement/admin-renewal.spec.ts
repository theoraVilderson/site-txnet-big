/**
 * An admin renews a user's Grant (F-311-d, spec F-311): `renewGrant` on the
 * same Grant, `source = admin_grant`, no invoice, no money.
 *
 * Each case below is a way it breaks quietly:
 *
 *  - **one period of the plan the user bought** when the admin names no
 *    amount (user, 2026-09-28): the Grant's own copied bag and `periodDays`,
 *    never the variant's today — a catalog edit after the sale would renew
 *    with a plan the user never held;
 *  - **or what the admin types** (`bytes`, `days`), the same renewal —
 *    debt forgiven, usage period opened, lapsed Grant revived — by `renewGrant`;
 *  - **a metered or unlimited Grant renews by days alone**: its plan period
 *    carries no bytes, and bytes typed are `renewGrant`'s refusal;
 *  - **one request, one renewal.** A double click carries the same
 *    `requestId` and answers the first renewal (`renewed: false`) — a period
 *    given twice is money given away; the id on another Grant is refused;
 *  - **written down**: one `grant_renewal` row (actor, amount, before, after,
 *    what was forgiven), since days alone leave no `quota_adjustment` row.
 */
import { GrantSource, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { renewGrantByAdmin } from './admin-renewal';
import { EntitlementRefused } from './grant';
import { renewGrant } from './renewal';

vi.mock('./renewal', () => ({ renewGrant: vi.fn() }));

const GRANT = '11111111-1111-4111-8111-111111111111';
const OTHER_GRANT = '33333333-3333-4333-8333-333333333333';
const TENANT = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = new Date('2026-09-28T10:00:00Z');
const END = new Date('2026-09-20T10:00:00Z');
const GIB = BigInt(1024 ** 3);

type GrantOver = { billingMode?: VariantBillingMode; trafficUnlimited?: boolean; quotas?: unknown; periodDays?: number | null; endsAt?: Date | null };

const grantRow = (over: GrantOver = {}) => ({
  id: GRANT,
  tenantId: TENANT,
  status: GrantStatus.suspended,
  billingMode: over.billingMode ?? VariantBillingMode.prepaid,
  trafficUnlimited: over.trafficUnlimited ?? false,
  quotas: over.quotas ?? { traffic_bytes: { limit: Number(BigInt(50) * GIB), resetPolicy: 'none' } },
  periodDays: over.periodDays === undefined ? 30 : over.periodDays,
  purchasedBytes: BigInt(50) * GIB,
  endsAt: over.endsAt === undefined ? END : over.endsAt,
});

function fakeTx(grant: ReturnType<typeof grantRow> | null, prior: Record<string, unknown> | null = null) {
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    grant: { findUnique: vi.fn(async () => grant) },
    grantRenewal: {
      findUnique: vi.fn(async () => prior),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'renewal-1', createdAt: AT, ...data };
        rows.push(row);
        return row;
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, rows, raw: tx };
}

const renewed = (over: Partial<{ purchasedBytes: bigint; endsAt: Date | null; forgivenBytes: bigint; debtBytes: bigint; revived: boolean }> = {}) => ({
  grantId: GRANT,
  debtBytes: over.debtBytes ?? BigInt(0),
  forgivenBytes: over.forgivenBytes ?? BigInt(0),
  raiseBytes: BigInt(0),
  purchasedBytes: over.purchasedBytes ?? BigInt(100) * GIB,
  endsAt: over.endsAt === undefined ? new Date(AT.getTime() + 30 * 86_400_000) : over.endsAt,
  revived: over.revived ?? true,
});

const input = (over: Partial<Parameters<typeof renewGrantByAdmin>[1]> = {}) => ({
  grantId: GRANT,
  requestId: REQUEST,
  actorUserId: ADMIN,
  at: AT,
  reason: null,
  ...over,
});

beforeEach(() => vi.mocked(renewGrant).mockReset());

describe('renewGrantByAdmin — one period of the plan the user bought, by default', () => {
  it('renews the Grant’s own bag and period days, as admin_grant, with the admin on it', async () => {
    vi.mocked(renewGrant).mockResolvedValue(renewed());
    const { tx } = fakeTx(grantRow());

    const out = await renewGrantByAdmin(tx, input({ reason: 'paid cash' }));

    expect(renewGrant).toHaveBeenCalledWith(tx, {
      grantId: GRANT,
      bytes: BigInt(50) * GIB,
      days: 30,
      source: GrantSource.admin_grant,
      at: AT,
      reason: 'paid cash',
      createdByAdminId: ADMIN,
    });
    expect(out).toMatchObject({ plan: true, bytes: BigInt(50) * GIB, days: 30, renewed: true, revived: true });
  });

  it('reads the period from the Grant, never from the variant today', async () => {
    vi.mocked(renewGrant).mockResolvedValue(renewed());
    const { tx, raw } = fakeTx(grantRow({ periodDays: 90 }));

    await renewGrantByAdmin(tx, input());

    expect(vi.mocked(renewGrant).mock.calls[0][1]).toMatchObject({ days: 90 });
    expect(raw).not.toHaveProperty('productVariant');
  });

  it('renews a metered Grant by its days alone', async () => {
    vi.mocked(renewGrant).mockResolvedValue(renewed());
    const { tx } = fakeTx(grantRow({ billingMode: VariantBillingMode.metered, quotas: {} }));

    await renewGrantByAdmin(tx, input());

    expect(vi.mocked(renewGrant).mock.calls[0][1]).toMatchObject({ bytes: BigInt(0), days: 30 });
  });

  it('renews an unlimited Grant by its days alone', async () => {
    vi.mocked(renewGrant).mockResolvedValue(renewed());
    const { tx } = fakeTx(grantRow({ trafficUnlimited: true, quotas: { traffic_bytes: { limit: 0, resetPolicy: 'none' } } }));

    await renewGrantByAdmin(tx, input());

    expect(vi.mocked(renewGrant).mock.calls[0][1]).toMatchObject({ bytes: BigInt(0), days: 30 });
  });

  it('refuses a dated Grant whose period it never copied: the admin types the amount', async () => {
    const { tx } = fakeTx(grantRow({ periodDays: null }));

    await expect(renewGrantByAdmin(tx, input())).rejects.toMatchObject({ reason: 'plan_period_unknown' });
    expect(renewGrant).not.toHaveBeenCalled();
  });
});

describe('renewGrantByAdmin — or what the admin types', () => {
  it('renews by the typed bytes and days, whatever the plan', async () => {
    vi.mocked(renewGrant).mockResolvedValue(renewed());
    const { tx } = fakeTx(grantRow({ periodDays: null }));

    const out = await renewGrantByAdmin(tx, input({ amount: { bytes: BigInt(10) * GIB, days: 7 } }));

    expect(vi.mocked(renewGrant).mock.calls[0][1]).toMatchObject({ bytes: BigInt(10) * GIB, days: 7 });
    expect(out).toMatchObject({ plan: false, bytes: BigInt(10) * GIB, days: 7 });
  });

  it('leaves the refusals to renewGrant: bytes on a metered Grant are its traffic_not_renewable', async () => {
    vi.mocked(renewGrant).mockRejectedValueOnce(new EntitlementRefused('traffic_not_renewable', GRANT));
    const { tx, rows } = fakeTx(grantRow({ billingMode: VariantBillingMode.metered }));

    await expect(renewGrantByAdmin(tx, input({ amount: { bytes: GIB, days: 0 } }))).rejects.toMatchObject({ reason: 'traffic_not_renewable' });
    expect(rows).toHaveLength(0);
  });
});

describe('renewGrantByAdmin — written down, once per request', () => {
  it('writes one grant_renewal row: actor, amount, before, after, what was forgiven', async () => {
    const after = new Date(AT.getTime() + 30 * 86_400_000);
    vi.mocked(renewGrant).mockResolvedValue(renewed({ endsAt: after, purchasedBytes: BigInt(101) * GIB, forgivenBytes: GIB, debtBytes: GIB }));
    const { tx, rows } = fakeTx(grantRow());

    const out = await renewGrantByAdmin(tx, input({ reason: 'paid cash' }));

    expect(rows).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        grantId: GRANT,
        requestId: REQUEST,
        actorUserId: ADMIN,
        plan: true,
        bytes: BigInt(50) * GIB,
        days: 30,
        forgivenBytes: GIB,
        purchasedBytesBefore: BigInt(50) * GIB,
        purchasedBytesAfter: BigInt(101) * GIB,
        endsAtBefore: END,
        endsAtAfter: after,
        reason: 'paid cash',
      }),
    ]);
    expect(out.renewalId).toBe('renewal-1');
  });

  it('answers a repeat of the request with the first renewal, and renews nothing', async () => {
    const prior = {
      id: 'renewal-0',
      grantId: GRANT,
      plan: true,
      bytes: BigInt(50) * GIB,
      days: 30,
      forgivenBytes: BigInt(0),
      purchasedBytesBefore: BigInt(50) * GIB,
      purchasedBytesAfter: BigInt(100) * GIB,
      endsAtBefore: END,
      endsAtAfter: new Date(AT.getTime() + 30 * 86_400_000),
    };
    const { tx, rows } = fakeTx(grantRow(), prior);

    const out = await renewGrantByAdmin(tx, input());

    expect(renewGrant).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
    expect(out).toMatchObject({ renewalId: 'renewal-0', renewed: false, revived: false, days: 30 });
  });

  it('refuses the same request id on another Grant', async () => {
    const { tx } = fakeTx(grantRow(), { id: 'renewal-0', grantId: OTHER_GRANT });

    await expect(renewGrantByAdmin(tx, input())).rejects.toMatchObject({ reason: 'request_reused' });
    expect(renewGrant).not.toHaveBeenCalled();
  });

  it('turns a concurrent repeat, caught by the unique request id, into already_renewed', async () => {
    vi.mocked(renewGrant).mockResolvedValue(renewed());
    const { tx, raw } = fakeTx(grantRow());
    raw.grantRenewal.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }));

    await expect(renewGrantByAdmin(tx, input())).rejects.toMatchObject({ reason: 'already_renewed' });
  });

  it('refuses an unknown Grant', async () => {
    const { tx } = fakeTx(null);

    await expect(renewGrantByAdmin(tx, input())).rejects.toMatchObject({ reason: 'grant_not_found' });
  });
});
