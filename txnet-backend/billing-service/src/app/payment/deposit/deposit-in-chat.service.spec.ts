/**
 * In-chat settlement (F-104-k, D-32) — a messenger delivers the result, and
 * billing never holds the bot's token.
 *
 * What would break silently here, and nowhere else:
 *  - **pre-checkout approves only what `start` wrote**: this payer's own open
 *    payment, at an in-chat gateway, for exactly the charge in its currency;
 *  - **an approval starts the verify clock**: a `paid` that never arrives
 *    leaves a verifying row the retry ladder flags for a person (F-092-y), not
 *    one the expiry sweep quietly closes over money the platform took;
 *  - **`paid` settles through F-092-j's guard**, `webhook_auto`, with the
 *    platform's charge id as the reference, a receipt only when the amount
 *    differs, and nothing at all in another currency;
 *  - **an in-chat gateway is offered only in its own tenant's bot**, on the
 *    messenger it is paid in;
 *  - **a Star is priced by its USD value**, whole Stars rounded up.
 */
import { Prisma } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { TelegramStarsProvider } from '../gateway/telegram-stars.provider';
import { offeredInThisChat, priceDeposit } from './deposit-pricing';
import { DepositInChatService } from './deposit-in-chat.service';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const d = (v: string) => new Prisma.Decimal(v);

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    userId: USER,
    status: 'pending',
    gatewayId: null,
    tenantGatewayConfigId: GATEWAY,
    amountCredited: d('10.00'),
    feeApplied: d('0.00'),
    chargedAmountMinor: BigInt(770),
    exchangeRateSnapshot: d('76.923076923076923077'),
    gatewayTrackingCode: null,
    authorityCandidates: [],
    gatewayReferenceId: null,
    grantId: null,
    verifyAttempts: 0,
    nextVerifyAt: null,
    expiresAt: new Date(Date.now() + 600_000),
    channel: 'bot',
    gateway: null,
    tenantGatewayConfig: { providerName: 'telegram_stars' },
    ...overrides,
  };
}

function build(row: ReturnType<typeof paymentRow> | null = paymentRow(), opts: { creditWins?: boolean } = {}) {
  const { creditWins = true } = opts;
  const calls = {
    reads: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    credited: [] as Array<{ referenceId: string; source: string; received?: unknown }>,
  };
  let current = row;
  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        calls.reads.push(where);
        return current && where['id'] === current.id && where['userId'] === current.userId ? current : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updates.push({ where, data });
        return { count: current && current.status === where['status'] ? 1 : 0 };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const stars = new TelegramStarsProvider();
  const zarinpal = { name: 'zarinpal', settlement: 'return', chargeCurrency: 'IRR', chargeDecimals: 0 };
  const registry = {
    has: () => true,
    get: (name: string) => (name === 'telegram_stars' ? stars : zarinpal),
  };
  const settlement = {
    creditVerified: async (_p: unknown, verified: { referenceId: string; received?: unknown }, source: string) => {
      calls.credited.push({ referenceId: verified.referenceId, source, ...(verified.received ? { received: verified.received } : {}) });
      if (creditWins && current) current = { ...current, status: 'success' };
      return creditWins;
    },
  };
  const service = new DepositInChatService(prisma as never, registry as never, settlement as never);
  return { service, calls, setRow: (r: typeof row) => (current = r) };
}

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const ref = (overrides: Partial<{ currency: string; totalAmount: bigint; userId: string }> = {}) => ({
  userId: USER,
  paymentId: PAYMENT,
  currency: 'XTR',
  totalAmount: BigInt(770),
  ...overrides,
});

describe('DepositInChatService.preCheckout', () => {
  it('approves the open payment, takes the payment id as its authority and starts the verify clock', async () => {
    const { service, calls } = build();
    await expect(asTenant(() => service.preCheckout(ref()))).resolves.toEqual({ approved: true });

    expect(calls.reads[0]).toEqual({ id: PAYMENT, userId: USER });
    const [authority, clock] = calls.updates;
    expect(authority.where).toMatchObject({ id: PAYMENT, status: 'pending' });
    expect(authority.data).toEqual({ gatewayTrackingCode: PAYMENT });
    expect(clock.data).toMatchObject({ verifyAttempts: 1 });
    expect(clock.data['nextVerifyAt']).toBeInstanceOf(Date);
  });

  it('approves a second query for an approved payment without climbing the clock again', async () => {
    const { service, calls } = build(
      paymentRow({ gatewayTrackingCode: PAYMENT, nextVerifyAt: new Date(), verifyAttempts: 1, expiresAt: new Date(0) }),
    );
    await expect(asTenant(() => service.preCheckout(ref()))).resolves.toEqual({ approved: true });
    expect(calls.updates).toHaveLength(1);
  });

  it('refuses another amount, another currency, a closed or timed-out payment, and another payer', async () => {
    const cases: Array<[ReturnType<typeof paymentRow> | null, ReturnType<typeof ref>, string]> = [
      [paymentRow(), ref({ totalAmount: BigInt(769) }), 'amount_mismatch'],
      [paymentRow(), ref({ currency: 'USD' }), 'amount_mismatch'],
      [paymentRow({ status: 'success' }), ref(), 'not_payable'],
      [paymentRow({ status: 'expired' }), ref(), 'not_payable'],
      [paymentRow({ expiresAt: new Date(Date.now() - 1000) }), ref(), 'not_payable'],
      [paymentRow(), ref({ userId: '99999999-9999-4999-8999-999999999999' }), 'not_found'],
    ];
    for (const [row, r, reason] of cases) {
      const { service, calls } = build(row);
      await expect(asTenant(() => service.preCheckout(r))).resolves.toEqual({ approved: false, reason });
      expect(calls.updates).toEqual([]);
    }
  });

  it('refuses a payment at a gateway that does not settle in chat', async () => {
    const { service } = build(paymentRow({ tenantGatewayConfig: { providerName: 'zarinpal' } }));
    await expect(asTenant(() => service.preCheckout(ref()))).resolves.toEqual({ approved: false, reason: 'not_found' });
  });
});

describe('DepositInChatService.paid', () => {
  const paid = (overrides: Parameters<typeof ref>[0] = {}) => ({ ...ref(overrides), chargeId: 'tg-charge-1' });

  it('credits through the guarded settlement with the platform charge id', async () => {
    const { service, calls } = build(paymentRow({ gatewayTrackingCode: PAYMENT }));
    await expect(asTenant(() => service.paid(paid()))).resolves.toEqual({ status: 'credited', credited: '10.00' });
    expect(calls.credited).toEqual([{ referenceId: 'tg-charge-1', source: 'webhook_auto' }]);
  });

  it('reports what arrived only when it differs from the charge', async () => {
    const { service, calls } = build();
    await asTenant(() => service.paid(paid({ totalAmount: BigInt(700) })));
    expect(calls.credited[0].received).toEqual({ amountMinor: BigInt(700), currency: 'XTR', decimals: 0 });
  });

  it('answers a repeat as already settled, and settles nothing in another currency', async () => {
    const repeat = build(paymentRow({ status: 'success' }), { creditWins: false });
    await expect(asTenant(() => repeat.service.paid(paid()))).resolves.toEqual({
      status: 'already_settled',
      credited: '10.00',
    });

    const other = build();
    await expect(asTenant(() => other.service.paid(paid({ currency: 'USD' })))).resolves.toEqual({
      status: 'unsettled',
      credited: null,
    });
    expect(other.calls.credited).toEqual([]);
  });

  it('answers not_found for a payment that is not this payer’s', async () => {
    const { service, calls } = build();
    await expect(
      asTenant(() => service.paid(paid({ userId: '99999999-9999-4999-8999-999999999999' }))),
    ).resolves.toEqual({ status: 'not_found', credited: null });
    expect(calls.credited).toEqual([]);
  });
});

describe('offeredInThisChat', () => {
  const stars = new TelegramStarsProvider();
  const zarinpal = { settlement: 'return' } as never;

  it('offers an in-chat gateway only in its own tenant’s bot on its messenger', () => {
    expect(offeredInThisChat(stars, { grantId: null }, 'telegram')).toBe(true);
    expect(offeredInThisChat(stars, { grantId: null }, 'bale')).toBe(false);
    expect(offeredInThisChat(stars, { grantId: null }, null)).toBe(false);
    expect(offeredInThisChat(stars, { grantId: 'grant-1' }, 'telegram')).toBe(false);
  });

  it('leaves every other gateway where it was', () => {
    expect(offeredInThisChat(zarinpal, { grantId: 'grant-1' }, null)).toBe(true);
  });
});

describe('a Telegram Stars price', () => {
  it('charges whole Stars, rounded up, at the gateway’s USD value per Star', async () => {
    const stars = new TelegramStarsProvider();
    const fx = { current: vi.fn() };
    const { provider, price } = await priceDeposit(
      { providers: { get: () => stars } as never, merchant: { requireConfigured: async () => undefined } as never, fx: fx as never },
      {
        gateway: {
          useLiveRate: true,
          staticRate: d('0.013'),
          feeCalculationMode: 'manual',
          feeType: 'fixed',
          feeValue: d('0'),
          feeFloor: null,
          feeCeiling: null,
          percentageModifier: d('0'),
          fixedAmountModifier: d('0'),
          minRate: null,
          maxRate: null,
          roundingStep: null,
          roundingMode: 'nearest',
          minAcceptAmount: null,
          maxAcceptAmount: null,
        } as never,
        ref: {} as never,
        amount: d('10.00'),
        discount: d('0'),
        actorId: USER,
      },
    );
    expect(provider.chargeCurrency).toBe('XTR');
    // 10 USD / 0.013 USD per Star = 769.23… Stars.
    expect(price.chargedAmountMinor).toBe(BigInt(770));
    // A Star has no live rate, whatever the row says.
    expect(fx.current).not.toHaveBeenCalled();
  });
});
