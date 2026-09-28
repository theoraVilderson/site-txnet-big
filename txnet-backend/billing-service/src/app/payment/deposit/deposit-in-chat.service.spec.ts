/**
 * In-chat settlement (F-104-k, D-32) — a messenger delivers the result, and
 * billing never holds the bot's token.
 *
 * What would break silently here, and nowhere else:
 *  - **an event is the payment's, not the chat session's (F-104-ab)**: billing
 *    admits it only from the messenger id `start` recorded as the payer's, on
 *    that messenger, through the payment tenant's own bot — a mismatch is
 *    refused at pre-checkout and never credited at paid;
 *  - **a suspended tenant's payment is not approved** (D-42 (1)): the relay
 *    carries no tenant for `TenantStatusGuard`, so the service asks itself;
 *  - **pre-checkout approves only what `start` wrote**: the open payment, at an
 *    in-chat gateway, for exactly the charge in its currency;
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
import { serializeTenantStatusState, TenantContext } from '@txnet-backend/shared-core';

import { TelegramStarsProvider } from '../gateway/telegram-stars.provider';
import { offeredInThisChat, priceDeposit } from './deposit-pricing';
import { DepositInChatService } from './deposit-in-chat.service';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const RESELLER = '33333333-3333-4333-8333-333333333333';
const d = (v: string) => new Prisma.Decimal(v);

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    tenantId: TENANT,
    userId: USER,
    payerChatPlatform: 'telegram' as string | null,
    payerChatId: '42' as string | null,
    status: 'pending',
    gatewayId: null,
    tenantGatewayConfigId: GATEWAY,
    amountCredited: d('10.00'),
    currencyCode: 'USD',
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

function build(
  row: ReturnType<typeof paymentRow> | null = paymentRow(),
  opts: { creditWins?: boolean; tenantStatus?: string } = {},
) {
  const { creditWins = true, tenantStatus } = opts;
  const calls = {
    reads: [] as Array<Record<string, unknown>>,
    tenants: [] as Array<string | undefined>,
    updates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    credited: [] as Array<{ referenceId: string; source: string; received?: unknown }>,
  };
  let current = row;
  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        calls.reads.push(where);
        calls.tenants.push(TenantContext.currentOrNull()?.id);
        return current && where['id'] === current.id ? current : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updates.push({ where, data });
        return { count: current && current.status === where['status'] ? 1 : 0 };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  // Outside every tenant: the relay arrives with none, and the row names its own.
  const crossTenant = {
    paymentTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        current && where['id'] === current.id
          ? { id: current.id, tenantId: current.tenantId, payerChatPlatform: current.payerChatPlatform, payerChatId: current.payerChatId }
          : null,
    },
  };
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
  const service = new DepositInChatService(prisma as never, crossTenant as never, registry as never, settlement as never, {
    get: async () => (tenantStatus ? serializeTenantStatusState({ status: tenantStatus as never, graceEndsAt: null }) : null),
  });
  return { service, calls, setRow: (r: typeof row) => (current = r) };
}

type Sender = { platform: string; senderId: string; botTenantId: string };
const ref = (overrides: Partial<{ currency: string; totalAmount: bigint; paymentId: string } & Sender> = {}) => {
  const { platform = 'telegram', senderId = '42', botTenantId = TENANT, ...rest } = overrides;
  return {
    paymentId: PAYMENT,
    currency: 'XTR',
    totalAmount: BigInt(770),
    ...rest,
    sender: { platform, senderId, botTenantId },
  };
};
/** Everything the payer's messenger identity can get wrong (F-104-ab). */
const NOT_THE_PAYER: Array<[string, ReturnType<typeof paymentRow>, ReturnType<typeof ref>]> = [
  ['another sender', paymentRow(), ref({ senderId: '43' })],
  ['another messenger', paymentRow(), ref({ platform: 'bale' })],
  ["another tenant's bot", paymentRow(), ref({ botTenantId: RESELLER })],
  ['a payment that recorded no payer', paymentRow({ payerChatPlatform: null, payerChatId: null }), ref()],
];

describe('DepositInChatService.preCheckout', () => {
  it('approves the open payment, takes the payment id as its authority and starts the verify clock', async () => {
    const { service, calls } = build();
    await expect(service.preCheckout(ref())).resolves.toEqual({ approved: true });

    // Read inside the payment's own tenant, which the relay never named.
    expect(calls.reads[0]).toEqual({ id: PAYMENT });
    expect(calls.tenants[0]).toBe(TENANT);
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
    await expect(service.preCheckout(ref())).resolves.toEqual({ approved: true });
    expect(calls.updates).toHaveLength(1);
  });

  it('refuses another amount, another currency, and a closed or timed-out payment', async () => {
    const cases: Array<[ReturnType<typeof paymentRow> | null, ReturnType<typeof ref>, string]> = [
      [paymentRow(), ref({ totalAmount: BigInt(769) }), 'amount_mismatch'],
      [paymentRow(), ref({ currency: 'USD' }), 'amount_mismatch'],
      [paymentRow({ status: 'success' }), ref(), 'not_payable'],
      [paymentRow({ status: 'expired' }), ref(), 'not_payable'],
      [paymentRow({ expiresAt: new Date(Date.now() - 1000) }), ref(), 'not_payable'],
      [paymentRow(), ref({ paymentId: '99999999-9999-4999-8999-999999999999' }), 'not_found'],
    ];
    for (const [row, r, reason] of cases) {
      const { service, calls } = build(row);
      await expect(service.preCheckout(r)).resolves.toEqual({ approved: false, reason });
      expect(calls.updates).toEqual([]);
    }
  });

  it.each(NOT_THE_PAYER)('refuses %s as not_found, and approves nothing', async (_name, row, r) => {
    const { service, calls } = build(row);
    await expect(service.preCheckout(r)).resolves.toEqual({ approved: false, reason: 'not_found' });
    expect(calls.updates).toEqual([]);
  });

  it('refuses a suspended or terminated tenant’s payment, but still settles one already approved', async () => {
    for (const status of ['suspended', 'terminated']) {
      const { service, calls } = build(paymentRow(), { tenantStatus: status });
      await expect(service.preCheckout(ref())).resolves.toEqual({ approved: false, reason: 'not_payable' });
      expect(calls.updates).toEqual([]);
    }
    const settled = build(paymentRow({ gatewayTrackingCode: PAYMENT }), { tenantStatus: 'suspended' });
    await expect(settled.service.paid({ ...ref(), chargeId: 'tg-charge-1' })).resolves.toMatchObject({ status: 'credited' });
  });

  it('refuses a payment at a gateway that does not settle in chat', async () => {
    const { service } = build(paymentRow({ tenantGatewayConfig: { providerName: 'zarinpal' } }));
    await expect(service.preCheckout(ref())).resolves.toEqual({ approved: false, reason: 'not_found' });
  });
});

describe('DepositInChatService.paid', () => {
  const paid = (overrides: Parameters<typeof ref>[0] = {}) => ({ ...ref(overrides), chargeId: 'tg-charge-1' });

  it('credits through the guarded settlement with the platform charge id', async () => {
    const { service, calls } = build(paymentRow({ gatewayTrackingCode: PAYMENT }));
    await expect(service.paid(paid())).resolves.toEqual({ status: 'credited', credited: '10.00', currencyCode: 'USD' });
    expect(calls.credited).toEqual([{ referenceId: 'tg-charge-1', source: 'webhook_auto' }]);
  });

  it('reports what arrived only when it differs from the charge', async () => {
    const { service, calls } = build();
    await service.paid(paid({ totalAmount: BigInt(700) }));
    expect(calls.credited[0].received).toEqual({ amountMinor: BigInt(700), currency: 'XTR', decimals: 0 });
  });

  it('answers a repeat as already settled, and settles nothing in another currency', async () => {
    const repeat = build(paymentRow({ status: 'success' }), { creditWins: false });
    await expect(repeat.service.paid(paid())).resolves.toEqual({
      status: 'already_settled',
      credited: '10.00',
      currencyCode: 'USD',
    });

    const other = build();
    await expect(other.service.paid(paid({ currency: 'USD' }))).resolves.toEqual({
      status: 'unsettled',
      credited: null,
      currencyCode: null,
    });
    expect(other.calls.credited).toEqual([]);
  });

  it('answers not_found for a payment nobody here has', async () => {
    const { service, calls } = build();
    await expect(service.paid(paid({ paymentId: '99999999-9999-4999-8999-999999999999' }))).resolves.toEqual({
      status: 'not_found',
      credited: null,
      currencyCode: null,
    });
    expect(calls.credited).toEqual([]);
  });

  it.each(NOT_THE_PAYER)('credits nothing for %s: the row stays verifying for a person', async (_name, row, r) => {
    const { service, calls } = build(row);
    await expect(service.paid({ ...r, chargeId: 'tg-charge-1' })).resolves.toEqual({ status: 'unsettled', credited: null, currencyCode: null });
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
    const fx = { pair: vi.fn() };
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
          currencyCode: 'USD',
        } as never,
        ref: {} as never,
        amount: d('10.00'),
        currencyCode: 'USD',
        discount: d('0'),
        actorId: USER,
        defaultTaxRatePercent: null,
        ratesTenantId: null,
      },
    );
    expect(provider.chargeCurrency).toBe('XTR');
    // 10 USD / 0.013 USD per Star = 769.23… Stars.
    expect(price.chargedAmountMinor).toBe(BigInt(770));
    // A Star has no live rate, whatever the row says.
    expect(fx.pair).not.toHaveBeenCalled();
  });
});
