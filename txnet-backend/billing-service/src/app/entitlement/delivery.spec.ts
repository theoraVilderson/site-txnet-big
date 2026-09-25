/**
 * Delivery of a paid Grant — spec §5.8 step 3 (F-111-d).
 *
 * Money moved and the Grant was issued `pending` at step 2 (F-111-b). What
 * would break silently here, and nowhere else:
 *
 *  - **the handler is chosen by the product's fulfilment kind**, and a kind
 *    with no handler is refunded at the first check — never held for an hour
 *    of retries that cannot succeed (the user's call, 2026-09-25);
 *  - **the clock doubles**: checked at once, then retried after 1, 2, 4, 8,
 *    16 and 32 minutes; the check after the last retry that still finds it
 *    undelivered cancels it;
 *  - **a refund is the whole `total`, once**: the cancel is conditional on
 *    `pending`, so a Grant delivered meanwhile is never refunded, and the
 *    invoice moves `paid -> refunded` under its own row lock beside the credit;
 *  - **a cancelled Grant leaves nothing on a panel**: every config it was given
 *    while it waited is retired, or the refund would come with free service;
 *  - **both ends tell the user**: `entitlement.grant.delivered` or
 *    `entitlement.grant.refunded` in the outbox, in the same transaction.
 *
 * What the database holds rather than this file: `grant_status_one_way` is
 * `entitlement-schema.int.spec.ts`'s.
 */
import { FulfilmentKind, GrantSource, GrantStatus, InvoiceStatus, Prisma, WalletReasonType } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { deliveryRouteOf, GrantDeliveryService, nextDeliveryAt } from './delivery';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const INVOICE = '88888888-8888-4888-8888-888888888881';
const VARIANT = '77777777-7777-4777-8777-777777777771';
const GROUP = '66666666-6666-4666-8666-666666666661';

const POLICY = { retries: 6, firstRetryMs: 60_000 };
const NOW = new Date('2026-09-25T10:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

type GrantFacts = {
  status: GrantStatus;
  kind: FulfilmentKind;
  panelGroupId: string | null;
  deliveryAttempts: number;
};

function build(facts: Partial<GrantFacts> = {}, opts: { invoice?: { status: InvoiceStatus; total: string }; activated?: boolean; configs?: string[] } = {}) {
  const grant = {
    status: GrantStatus.pending,
    kind: FulfilmentKind.feature_access,
    panelGroupId: null,
    deliveryAttempts: 0,
    ...facts,
  };
  const invoice = opts.invoice ?? { status: InvoiceStatus.paid, total: '12.50' };
  const seen = {
    grantWrites: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    invoiceWrites: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    outbox: [] as Array<{ type: string; payload: Record<string, unknown> }>,
    credits: [] as Array<{ userId: string; amount: Prisma.Decimal; reasonType: WalletReasonType; referenceId?: string }>,
    retired: [] as string[],
    fulfilled: [] as string[],
  };

  const tx = {
    grant: {
      findUnique: async () => ({
        id: GRANT,
        tenantId: TENANT,
        userId: USER,
        variantId: VARIANT,
        source: GrantSource.purchase,
        sourceReferenceId: INVOICE,
        status: grant.status,
        deliveryAttempts: grant.deliveryAttempts,
        variant: { panelGroupId: grant.panelGroupId, product: { fulfilmentKind: grant.kind } },
      }),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        seen.grantWrites.push({ where, data });
        // Conditional on the status read: moved only while still `pending`.
        const matches = where['status'] === undefined || where['status'] === grant.status;
        if (matches && typeof data['status'] === 'string') grant.status = data['status'] as GrantStatus;
        return { count: matches ? 1 : 0 };
      },
    },
    config: {
      findMany: async () => (opts.configs ?? []).map((id) => ({ id })),
    },
    // The invoice's row lock.
    $queryRaw: async () => [{ id: INVOICE, userId: USER, total: new Prisma.Decimal(invoice.total), status: invoice.status }],
    invoice: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        seen.invoiceWrites.push({ where, data });
        return { count: where['status'] === invoice.status ? 1 : 0 };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
        seen.outbox.push({ type: data.type, payload: data.payload });
        return { id: 'e1' };
      },
    },
  };

  const groups = {
    fulfil: async (_tx: unknown, grantId: string) => {
      seen.fulfilled.push(grantId);
      if (opts.activated) grant.status = GrantStatus.active;
      return { placed: 0, waiting: [], activated: opts.activated ?? false };
    },
  };
  const actions = { retire: async (_tx: unknown, input: { configId: string }) => void seen.retired.push(input.configId) };
  const credits = {
    credit: async (_tx: unknown, entry: (typeof seen.credits)[number]) => {
      seen.credits.push(entry);
      return { id: 'wt1' };
    },
  };
  const config = { get: (k: string) => (k === 'GRANT_DELIVERY_RETRIES' ? POLICY.retries : k === 'GRANT_DELIVERY_FIRST_RETRY_MS' ? POLICY.firstRetryMs : 200) };

  const service = new GrantDeliveryService(
    {} as never,
    {} as never,
    groups as never,
    actions as never,
    credits as never,
    config as never,
  );
  return { service, tx: tx as never as Prisma.TransactionClient, seen, grant };
}

describe('the handler is the fulfilment kind (F-111-d)', () => {
  it('delivers a feature, and a network service through its panel group', () => {
    expect(deliveryRouteOf(FulfilmentKind.feature_access, null)).toBe('activate');
    expect(deliveryRouteOf(FulfilmentKind.network_access, GROUP)).toBe('panel_group');
  });

  it('has no handler for an external order, a wallet top-up, or a network service with no group', () => {
    expect(deliveryRouteOf(FulfilmentKind.external_order, null)).toBeNull();
    expect(deliveryRouteOf(FulfilmentKind.wallet_topup, null)).toBeNull();
    expect(deliveryRouteOf(FulfilmentKind.network_access, null)).toBeNull();
  });
});

describe('the clock doubles, then gives up (the user, 2026-09-25)', () => {
  it('retries after 1, 2, 4, 8, 16 and 32 minutes, and gives up at the seventh failed check', () => {
    const waits = [1, 2, 3, 4, 5, 6].map((attempts) => (nextDeliveryAt(attempts, NOW, POLICY)!.getTime() - NOW.getTime()) / 60_000);
    expect(waits).toEqual([1, 2, 4, 8, 16, 32]);
    expect(nextDeliveryAt(7, NOW, POLICY)).toBeNull();
  });

  it('gives up at once when no retry is configured', () => {
    expect(nextDeliveryAt(1, NOW, { retries: 0, firstRetryMs: 60_000 })).toBeNull();
  });
});

describe('GrantDeliveryService.deliver', () => {
  it('activates a feature Grant at once and tells the user', async () => {
    const { service, tx, seen, grant } = build();

    await expect(service.deliver(tx, GRANT, NOW)).resolves.toBe('delivered');

    expect(grant.status).toBe(GrantStatus.active);
    expect(seen.grantWrites[0]!.where).toMatchObject({ id: GRANT, status: GrantStatus.pending });
    expect(seen.outbox).toEqual([
      { type: OutboxEventType.GRANT_DELIVERED, payload: expect.objectContaining({ tenantId: TENANT, userId: USER, grantId: GRANT, invoiceId: INVOICE }) },
    ]);
    expect(seen.credits).toEqual([]);
  });

  it('counts a network Grant the panels have not confirmed yet, and pushes the next check out', async () => {
    const { service, tx, seen, grant } = build({ kind: FulfilmentKind.network_access, panelGroupId: GROUP, deliveryAttempts: 2 });

    await expect(service.deliver(tx, GRANT, NOW)).resolves.toBe('waiting');

    expect(seen.fulfilled).toEqual([GRANT]);
    expect(grant.status).toBe(GrantStatus.pending);
    expect(seen.grantWrites).toEqual([
      { where: { id: GRANT, status: GrantStatus.pending }, data: { deliveryAttempts: 3, nextDeliveryAt: minutes(4) } },
    ]);
    expect(seen.outbox).toEqual([]);
  });

  it('answers delivered when group fulfilment activated it (the event is fulfilment\'s own write)', async () => {
    const { service, tx, seen } = build({ kind: FulfilmentKind.network_access, panelGroupId: GROUP }, { activated: true });

    await expect(service.deliver(tx, GRANT, NOW)).resolves.toBe('delivered');
    expect(seen.credits).toEqual([]);
  });

  it('refunds the whole invoice, retires its configs and tells the user after the last retry', async () => {
    const { service, tx, seen, grant } = build(
      { kind: FulfilmentKind.network_access, panelGroupId: GROUP, deliveryAttempts: 6 },
      { configs: ['c1', 'c2'] },
    );

    await expect(service.deliver(tx, GRANT, NOW)).resolves.toBe('refunded');

    expect(grant.status).toBe(GrantStatus.cancelled);
    expect(seen.grantWrites[0]).toEqual({
      where: { id: GRANT, status: GrantStatus.pending },
      data: { status: GrantStatus.cancelled, statusReason: 'delivery_timed_out', deliveryAttempts: 7, nextDeliveryAt: null },
    });
    expect(seen.retired).toEqual(['c1', 'c2']);
    expect(seen.invoiceWrites).toEqual([{ where: { id: INVOICE, status: InvoiceStatus.paid }, data: { status: InvoiceStatus.refunded } }]);
    expect(seen.credits).toHaveLength(1);
    expect(seen.credits[0]).toMatchObject({ userId: USER, reasonType: WalletReasonType.product_refund, referenceId: INVOICE });
    expect(seen.credits[0]!.amount.toFixed(2)).toBe('12.50');
    expect(seen.outbox).toEqual([
      {
        type: OutboxEventType.GRANT_REFUNDED,
        payload: expect.objectContaining({ tenantId: TENANT, userId: USER, grantId: GRANT, invoiceId: INVOICE, amount: '12.50', reason: 'delivery_timed_out' }),
      },
    ]);
  });

  it('refunds a kind with no handler at the first check, without waiting out the retries', async () => {
    const { service, tx, seen, grant } = build({ kind: FulfilmentKind.external_order });

    await expect(service.deliver(tx, GRANT, NOW)).resolves.toBe('refunded');

    expect(grant.status).toBe(GrantStatus.cancelled);
    expect(seen.grantWrites[0]!.data).toMatchObject({ statusReason: 'no_delivery_route' });
    expect(seen.credits).toHaveLength(1);
  });

  it('writes no ledger row for a free invoice, and still refunds it', async () => {
    const { service, tx, seen } = build({ kind: FulfilmentKind.wallet_topup }, { invoice: { status: InvoiceStatus.paid, total: '0.00' } });

    await expect(service.deliver(tx, GRANT, NOW)).resolves.toBe('refunded');
    expect(seen.credits).toEqual([]);
    expect(seen.invoiceWrites).toHaveLength(1);
  });

  it('leaves a Grant that is no longer pending alone — an admin cancel or a delivery meanwhile stands', async () => {
    const { service, tx, seen } = build({ status: GrantStatus.active, kind: FulfilmentKind.external_order });

    await expect(service.deliver(tx, GRANT, NOW)).resolves.toBe('skipped');
    expect(seen.grantWrites).toEqual([]);
    expect(seen.credits).toEqual([]);
  });

  it('refunds nothing when the cancel lost to a delivery in between', async () => {
    const { service, tx, seen, grant } = build({ kind: FulfilmentKind.external_order });
    const original = (tx as never as { grant: { updateMany: (a: unknown) => Promise<{ count: number }> } }).grant;
    original.updateMany = async () => {
      grant.status = GrantStatus.active;
      return { count: 0 };
    };

    await expect(service.deliver(tx, GRANT, NOW)).resolves.toBe('skipped');
    expect(seen.credits).toEqual([]);
    expect(seen.invoiceWrites).toEqual([]);
    expect(seen.outbox).toEqual([]);
  });
});
