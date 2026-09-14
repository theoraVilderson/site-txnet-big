/**
 * Settling a top-up (F-092-j) — the half of a payment the bank starts.
 *
 * What would break silently here, and nowhere else:
 *  - the gateway is asked **outside** every transaction, and the credit happens
 *    inside one. Holding a connection open across a call to a bank is what
 *    turns a slow gateway into an exhausted pool;
 *  - the flip to `success` is guarded by the row's own status, so a bank that
 *    redirects twice — or retries a webhook — credits once (ADR-0028,
 *    invariant 7). The guard is the `where`, not a status read before it: two
 *    callbacks both see `pending`, and only one `updateMany` matches;
 *  - a refusal releases the holds; an *unknown* outcome does not touch the row
 *    at all, because a payment the gateway could not answer for is F-092-l's to
 *    resolve and a `failed` row is one reconciliation will never revisit;
 *  - the credit, the coupon confirm and the outbox event commit together
 *    (invariants 1-3, ADR-0021). An event written after the commit is an event
 *    that can be lost with no record that one was owed.
 *
 * What a duplicate does under a real row lock is
 * `payment-schema.int.spec.ts`'s; the breakdown that produced these numbers is
 * `deposit-start.service.spec.ts`'s.
 */
import { Prisma } from '@prisma/client';
import { CredentialUnavailable, runWithTenant } from '@txnet-backend/shared-core';

import { GatewayFailure } from '../gateway/payment-provider';
import { DepositCallbackService } from './deposit-callback.service';
import { DepositSettlementService } from './deposit-settlement';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '99999999-9999-4999-8999-999999999999';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const AUTHORITY = 'A0000000000000000000000000000001';

const d = (v: string) => new Prisma.Decimal(v);

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    userId: USER,
    status: 'pending',
    gatewayId: null,
    tenantGatewayConfigId: GATEWAY,
    amountCredited: d('19.80'),
    chargedAmountMinor: BigInt(19_800_000),
    gatewayReferenceId: null,
    verifyAttempts: 0,
    nextVerifyAt: null,
    gateway: null,
    tenantGatewayConfig: { providerName: 'zarinpal' },
    ...overrides,
  };
}

type Calls = {
  updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  settled: Array<{ orderReferenceId: string; outcome: string }>;
  credited: Array<{ amount: string; referenceId?: string; reasonType: string }>;
  verified: Array<{ authority: string; amountMinor: bigint }>;
  events: Array<Record<string, unknown>>;
};

type Setup = {
  row?: ReturnType<typeof paymentRow> | null;
  /** The gateway refuses to verify. */
  verifyFails?: Error;
  /** The row was no longer `pending` when the guarded flip ran — another callback won. */
  lostTheFlip?: boolean;
  /** The vault cannot hand out this gateway's merchant id. */
  credentialsFail?: Error;
};

function build(setup: Setup = {}) {
  const { row = paymentRow(), verifyFails, lostTheFlip = false, credentialsFail } = setup;
  const calls: Calls = { updated: [], settled: [], credited: [], verified: [], events: [] };

  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where['gatewayTrackingCode'] === AUTHORITY ? row : null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updated.push({ where, data });
        return { count: lostTheFlip ? 0 : 1 };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.events.push(data);
        return { id: 'event-1' };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };

  const zarinpal = {
    name: 'zarinpal',
    chargeCurrency: 'IRR',
    chargeDecimals: 0,
    verify: async ({ authority, amountMinor }: { authority: string; amountMinor: bigint }) => {
      calls.verified.push({ authority, amountMinor });
      if (verifyFails) throw verifyFails;
      return { referenceId: '900900900', cardPan: '6037********1234', alreadyVerified: false };
    },
  };
  const registry = { has: () => true, get: () => zarinpal };
  const merchant = {
    credentialsFor: async () => {
      if (credentialsFail) throw credentialsFail;
      return { merchantId: 'merchant' };
    },
  };
  const reservations = {
    confirm: async (_tx: unknown, orderReferenceId: string) => {
      calls.settled.push({ orderReferenceId, outcome: 'confirmed' });
      return 1;
    },
    release: async (_tx: unknown, orderReferenceId: string, outcome: string) => {
      calls.settled.push({ orderReferenceId, outcome });
      return 1;
    },
  };
  const ledger = {
    credit: async (_tx: unknown, entry: { amount: Prisma.Decimal; referenceId?: string; reasonType: string }) => {
      calls.credited.push({
        amount: entry.amount.toFixed(2),
        referenceId: entry.referenceId,
        reasonType: entry.reasonType,
      });
      return { balanceAfter: d('119.80') };
    },
  };

  // The real settlement service over the same fakes (F-092-l extracted it):
  // the flip, the credit, the confirm and the event are asserted below exactly
  // as when this file was written, and a stub here would assert nothing.
  const settlement = new DepositSettlementService(prisma as never, reservations as never, ledger as never);

  const service = new DepositCallbackService(
    prisma as never,
    reservations as never,
    registry as never,
    merchant as never,
    settlement,
  );
  return { service, calls };
}

const settle = (service: DepositCallbackService, query: { authority?: string; gatewayStatus?: string | null } = {}) =>
  runWithTenant({ id: TENANT }, () =>
    service.settle({ authority: query.authority ?? AUTHORITY, gatewayStatus: query.gatewayStatus ?? 'OK' }),
  );

describe('DepositCallbackService.settle', () => {
  it('verifies at the gateway, then credits and confirms the holds in one transaction', async () => {
    const { service, calls } = build();

    const outcome = await settle(service);

    expect(outcome).toEqual({ kind: 'success', paymentId: PAYMENT, referenceId: '900900900', alreadyPaid: false });
    // The amount asked about is the one the row was charged at, never recomputed here.
    expect(calls.verified).toEqual([{ authority: AUTHORITY, amountMinor: BigInt(19_800_000) }]);
    // The flip is guarded by the status in its own `where` (ADR-0028).
    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0].where).toMatchObject({ id: PAYMENT, status: 'pending' });
    expect(calls.updated[0].data).toMatchObject({
      status: 'success',
      gatewayReferenceId: '900900900',
      cardPanMasked: '6037********1234',
      confirmationSource: 'webhook_auto',
      expiresAt: null,
    });
    // `amountCredited`, not `amountRequested`: the adjustment gap is already in it.
    expect(calls.credited).toEqual([
      { amount: '19.80', referenceId: PAYMENT, reasonType: 'payment_gateway' },
    ]);
    expect(calls.settled).toEqual([{ orderReferenceId: PAYMENT, outcome: 'confirmed' }]);
  });

  it('writes the outbox event in the transaction that credited (ADR-0021)', async () => {
    const { service, calls } = build();

    await settle(service);

    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]).toMatchObject({
      aggregate: 'billing.payment',
      aggregateId: PAYMENT,
      type: 'billing.payment.confirmed',
    });
    // The relay reads under no tenant (automation.prisma), so the event carries its own.
    expect(calls.events[0]['payload']).toMatchObject({
      tenantId: TENANT,
      userId: USER,
      paymentId: PAYMENT,
      amountCredited: '19.80',
    });
  });

  it('credits nothing when another callback already flipped the row', async () => {
    const { service, calls } = build({ lostTheFlip: true });

    const outcome = await settle(service);

    expect(outcome).toMatchObject({ kind: 'success', alreadyPaid: true });
    expect(calls.credited).toEqual([]);
    expect(calls.settled).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it('answers a payment that is already `success` without asking the gateway at all', async () => {
    const { service, calls } = build({ row: paymentRow({ status: 'success', gatewayReferenceId: '900900900' }) });

    const outcome = await settle(service);

    expect(outcome).toEqual({ kind: 'success', paymentId: PAYMENT, referenceId: '900900900', alreadyPaid: true });
    expect(calls.verified).toEqual([]);
    expect(calls.credited).toEqual([]);
  });

  it('marks the payment failed and releases the holds when the gateway refuses it', async () => {
    const { service, calls } = build({
      verifyFails: new GatewayFailure('zarinpal', 'payment_failed', '-51', 'the payer did not complete it'),
    });

    const outcome = await settle(service);

    expect(outcome).toEqual({ kind: 'failed', code: 'VERIFICATION_FAILED' });
    expect(calls.updated[0].data).toMatchObject({ status: 'failed', failureCode: 'payment_failed' });
    expect(calls.settled).toEqual([{ orderReferenceId: PAYMENT, outcome: 'cancelled' }]);
    expect(calls.credited).toEqual([]);
  });

  /** Silence touches only the retry clock (F-092-x): never the status, never the holds. */
  const expectOnlyVerifying = (calls: Calls) => {
    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0].where).toMatchObject({ id: PAYMENT, status: 'pending', verifyAttempts: 0 });
    expect(Object.keys(calls.updated[0].data).sort()).toEqual(['nextVerifyAt', 'verifyAttempts']);
  };

  it('leaves the row pending, and verifying, when the gateway could not answer', async () => {
    const { service, calls } = build({
      verifyFails: new GatewayFailure('zarinpal', 'unavailable', null, 'timed out'),
    });

    const outcome = await settle(service);

    expect(outcome).toEqual({ kind: 'failed', code: 'GATEWAY_CONNECTION_ERROR' });
    expectOnlyVerifying(calls);
    expect(calls.settled).toEqual([]);
    expect(calls.credited).toEqual([]);
  });

  it('leaves the row pending on an amount mismatch, for a human to see (invariant 9)', async () => {
    const { service, calls } = build({
      verifyFails: new GatewayFailure('zarinpal', 'amount_mismatch', '-53', 'verified 1 rial'),
    });

    const outcome = await settle(service);

    expect(outcome).toEqual({ kind: 'failed', code: 'GATEWAY_CONNECTION_ERROR' });
    expectOnlyVerifying(calls);
    expect(calls.credited).toEqual([]);
  });

  it('leaves the row pending when the merchant id cannot be read', async () => {
    const { service, calls } = build({
      credentialsFail: new CredentialUnavailable(
        { tenantId: TENANT, kind: 'gateway_merchant_id', label: `gateway:tenant:${GATEWAY}` },
        'missing',
      ),
    });

    const outcome = await settle(service);

    expect(outcome).toEqual({ kind: 'failed', code: 'GATEWAY_CONNECTION_ERROR' });
    expectOnlyVerifying(calls);
    expect(calls.credited).toEqual([]);
  });

  it('fails the payment without asking the gateway when the bank says the payer walked away', async () => {
    const { service, calls } = build();

    const outcome = await settle(service, { gatewayStatus: 'NOK' });

    expect(outcome).toEqual({ kind: 'failed', code: 'VERIFICATION_FAILED' });
    expect(calls.verified).toEqual([]);
    expect(calls.updated[0].data).toMatchObject({ status: 'failed', failureCode: 'payment_failed' });
    expect(calls.settled).toEqual([{ orderReferenceId: PAYMENT, outcome: 'cancelled' }]);
  });

  it('does not reveal whether an unknown authority exists', async () => {
    const { service, calls } = build({ row: null });

    const outcome = await settle(service, { authority: 'A0000000000000000000000000000099' });

    expect(outcome).toEqual({ kind: 'failed', code: 'TRANSACTION_NOT_FOUND' });
    expect(calls.verified).toEqual([]);
  });

  it('refuses a callback with no authority before it reads anything', async () => {
    const { service, calls } = build();

    const outcome = await settle(service, { authority: '' });

    expect(outcome).toEqual({ kind: 'failed', code: 'INVALID_PARAMS' });
    expect(calls.verified).toEqual([]);
  });

  it('does not settle a payment the expiry job already closed', async () => {
    const { service, calls } = build({ row: paymentRow({ status: 'expired' }) });

    const outcome = await settle(service);

    expect(outcome).toEqual({ kind: 'failed', code: 'VERIFICATION_FAILED' });
    expect(calls.verified).toEqual([]);
    expect(calls.credited).toEqual([]);
  });
});

describe('DepositCallbackService.settle — the origin the payer started from', () => {
  it('hands the row’s returnOrigin to the redirect, on success and on failure', async () => {
    const { service } = build({ row: { ...paymentRow(), returnOrigin: 'https://panel.txnet.cyou' } as never });
    expect(await settle(service)).toMatchObject({ kind: 'success', returnOrigin: 'https://panel.txnet.cyou' });

    const refused = build({ row: { ...paymentRow(), returnOrigin: 'https://panel.txnet.cyou' } as never });
    expect(await settle(refused.service, { gatewayStatus: 'NOK' })).toEqual({
      kind: 'failed',
      code: 'VERIFICATION_FAILED',
      returnOrigin: 'https://panel.txnet.cyou',
    });
  });
});
