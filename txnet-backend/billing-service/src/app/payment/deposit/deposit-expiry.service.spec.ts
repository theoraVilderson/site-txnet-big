/**
 * Expiring a pending top-up (F-092-k).
 *
 * What would break silently here, and nowhere else:
 *  - the flip is guarded by the row's own status, exactly as the callback's is
 *    (ADR-0028, invariant 7). A payment the bank confirmed between this job's
 *    scan and its write is `success` by the time the `updateMany` runs, and
 *    releasing its holds would give back capacity a confirmed use is holding —
 *    so the release hangs off the flip's `count`, never off the scan;
 *  - the scan is cross-tenant and the writes are not. Sweeping on the
 *    application pool would see nothing at all (RLS shows a connection with no
 *    `app.tenant_id` zero rows), and sweeping every tenant inside one tenant's
 *    scope would be the wrong rows or none;
 *  - a hold is released `expired` and not `cancelled`. Nothing here failed;
 *    the clock ran out, and `close()` in the callback owns the other word;
 *  - a payment with no tenant cannot be written by the application pool at all,
 *    so it is counted and logged rather than passed over in silence.
 *
 * The holds themselves are `coupon-reservation.int.spec.ts`'s; what a duplicate
 * does under a real row lock is `payment-schema.int.spec.ts`'s.
 */
import { PaymentStatus, RedemptionStatus } from '@prisma/client';
import { TenantContext } from '@txnet-backend/shared-core';

import { DepositExpiryService } from './deposit-expiry.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PAYMENT_1 = '77777777-7777-4777-8777-777777777771';
const PAYMENT_2 = '77777777-7777-4777-8777-777777777772';
const PAYMENT_3 = '77777777-7777-4777-8777-777777777773';

type Due = { id: string; tenantId: string | null };

type Calls = {
  scans: Array<Record<string, unknown>>;
  updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown>; tenantInScope: string | null }>;
  released: Array<{ orderReferenceId: string; outcome: string; tenantInScope: string | null }>;
};

type Setup = {
  due?: Due[];
  /** Payment ids whose guarded flip matches nothing — something settled them first. */
  lost?: string[];
  batchSize?: number;
};

function build(setup: Setup = {}) {
  const { due = [], lost = [], batchSize = 200 } = setup;
  const calls: Calls = { scans: [], updated: [], released: [] };

  const scoped = () => TenantContext.currentOrNull()?.id ?? null;

  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updated.push({ where, data, tenantInScope: scoped() });
        return { count: lost.includes(where['id'] as string) ? 0 : 1 };
      },
    },
  };

  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };

  const crossTenant = {
    paymentTransaction: {
      findMany: async (args: Record<string, unknown>) => {
        calls.scans.push({ ...args, tenantInScope: scoped() });
        return due;
      },
    },
  };

  const reservations = {
    release: async (_tx: unknown, orderReferenceId: string, outcome: RedemptionStatus) => {
      calls.released.push({ orderReferenceId, outcome, tenantInScope: scoped() });
      return 1;
    },
  };

  const config = { get: () => batchSize };

  const service = new DepositExpiryService(
    prisma as never,
    crossTenant as never,
    reservations as never,
    config as never,
  );
  return { service, calls };
}

describe('DepositExpiryService', () => {
  it('expires a due payment and gives its coupon holds back as expired', async () => {
    const { service, calls } = build({ due: [{ id: PAYMENT_1, tenantId: TENANT_A }] });

    const result = await service.expirePending();

    expect(result).toEqual({ scanned: 1, expired: 1, unattributed: 0 });
    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0].data).toMatchObject({ status: PaymentStatus.expired });
    expect(calls.released).toEqual([
      { orderReferenceId: PAYMENT_1, outcome: RedemptionStatus.expired, tenantInScope: TENANT_A },
    ]);
  });

  it('guards the flip on the row still being pending, and on its clock', async () => {
    const { service, calls } = build({ due: [{ id: PAYMENT_1, tenantId: TENANT_A }] });

    await service.expirePending();

    expect(calls.updated[0].where).toMatchObject({ id: PAYMENT_1, status: PaymentStatus.pending });
    expect(calls.updated[0].where['expiresAt']).toBeDefined();
  });

  it('releases nothing when the flip matched nothing — a callback settled it first', async () => {
    const { service, calls } = build({
      due: [{ id: PAYMENT_1, tenantId: TENANT_A }],
      lost: [PAYMENT_1],
    });

    const result = await service.expirePending();

    expect(result).toMatchObject({ scanned: 1, expired: 0 });
    expect(calls.released).toEqual([]);
  });

  it('keeps the row that ran out of time readable: `expiresAt` is not cleared', async () => {
    const { service, calls } = build({ due: [{ id: PAYMENT_1, tenantId: TENANT_A }] });

    await service.expirePending();

    expect(calls.updated[0].data).not.toHaveProperty('expiresAt');
  });

  it('scans across every tenant and writes inside each one', async () => {
    const { service, calls } = build({
      due: [
        { id: PAYMENT_1, tenantId: TENANT_A },
        { id: PAYMENT_2, tenantId: TENANT_B },
        { id: PAYMENT_3, tenantId: TENANT_A },
      ],
    });

    const result = await service.expirePending();

    expect(result).toMatchObject({ scanned: 3, expired: 3 });
    // The scan itself runs under no tenant: the answer is what produces one.
    expect(calls.scans[0]['tenantInScope']).toBeNull();
    expect(calls.updated.map((u) => [u.where['id'], u.tenantInScope])).toEqual([
      [PAYMENT_1, TENANT_A],
      [PAYMENT_3, TENANT_A],
      [PAYMENT_2, TENANT_B],
    ]);
  });

  it('counts a payment with no tenant instead of trying to write it', async () => {
    const { service, calls } = build({
      due: [
        { id: PAYMENT_1, tenantId: null },
        { id: PAYMENT_2, tenantId: TENANT_A },
      ],
    });

    const result = await service.expirePending();

    expect(result).toEqual({ scanned: 2, expired: 1, unattributed: 1 });
    expect(calls.updated.map((u) => u.where['id'])).toEqual([PAYMENT_2]);
  });

  it('takes only one batch, so a backlog costs one bounded transaction per tenant', async () => {
    const { service, calls } = build({ due: [], batchSize: 50 });

    await service.expirePending();

    expect(calls.scans[0]['take']).toBe(50);
    expect(calls.scans[0]['where']).toMatchObject({ status: PaymentStatus.pending });
  });
});
