/**
 * The webhook door (F-104-b, ADR-0051) — a provider's server settling a payment.
 *
 * What would break silently here, and nowhere else:
 *  - **nothing is read past the gateway row before the signature holds**: no
 *    payment lookup, no flip. A forged post is a 401 that cost one vault read;
 *  - **no secret is a 401, not a pass**: a gateway with no stored webhook
 *    secret is a closed door (ADR-0051 decision 6);
 *  - **the payment settles in its own tenant**, not the gateway owner's: a
 *    platform gateway serves many tenants' users (decision 3);
 *  - **a signed event we cannot act on is `accepted`** — an unknown code, an
 *    ignored type, a settled row — so the provider stops retrying (decision 4);
 *  - the credit goes through F-092-j's guarded settlement, `webhook_auto`.
 */
import { Prisma } from '@prisma/client';
import { TenantContext, runWithTenant } from '@txnet-backend/shared-core';

import type { MerchantGatewayRef } from '../gateway/gateway-merchant';
import { WebhookEvent, WebhookSignatureInvalid } from '../gateway/payment-provider';
import { DepositSettlementService } from './deposit-settlement';
import { DepositWebhookService } from './deposit-webhook.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PAYER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const SESSION = 'cs_test_0001';

const gateway: MerchantGatewayRef = { tenantId: OWNER, source: 'platform', gatewayId: GATEWAY, providerName: 'stripe' };

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    userId: USER,
    status: 'pending',
    gatewayId: GATEWAY,
    tenantGatewayConfigId: null,
    amountCredited: new Prisma.Decimal('10.00'),
    feeApplied: new Prisma.Decimal('0.00'),
    chargedAmountMinor: BigInt(1000),
    gatewayTrackingCode: SESSION,
    authorityCandidates: [],
    gatewayReferenceId: null,
    grantId: null,
    verifyAttempts: 0,
    nextVerifyAt: null,
    gateway: { providerName: 'stripe' },
    tenantGatewayConfig: null,
    ...overrides,
  };
}

type Setup = {
  event?: WebhookEvent;
  signatureBad?: boolean;
  secret?: string | null;
  /** The payment the cross-tenant read finds, or null. */
  found?: { id: string; tenantId: string | null } | null;
  row?: ReturnType<typeof paymentRow>;
  settlementMode?: 'return' | 'webhook' | 'in_chat';
};

function build(setup: Setup = {}) {
  const {
    event = { kind: 'paid', authority: SESSION, referenceId: 'pi_0001' },
    signatureBad = false,
    secret = 'whsec_test',
    found = { id: PAYMENT, tenantId: PAYER_TENANT },
    row = paymentRow(),
    settlementMode = 'webhook',
  } = setup;
  const calls = {
    verifiedWith: [] as Array<{ secret: string; body: string }>,
    crossTenantReads: [] as Array<Record<string, unknown>>,
    scopedTenants: [] as string[],
    credited: [] as Array<{ id: string; referenceId: string; source: string; tenant: string; received?: unknown }>,
    closed: [] as Array<{ id: string; tenant: string }>,
    reversed: [] as Array<{ id: string; tenant: string }>,
  };

  const crossTenant = {
    paymentTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        calls.crossTenantReads.push(where);
        return found;
      },
    },
  };
  const tx = {
    $executeRaw: async () => 0,
    paymentTransaction: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        calls.scopedTenants.push(TenantContext.current('spec').id);
        return where['id'] === row.id ? row : null;
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };

  const driver = {
    name: 'stripe',
    chargeCurrency: 'USD',
    chargeDecimals: 2,
    settlement: settlementMode,
    verifyWebhook: ({ rawBody, secret: s }: { rawBody: Buffer; secret: string }) => {
      calls.verifiedWith.push({ secret: s, body: rawBody.toString('utf8') });
      if (signatureBad) throw new WebhookSignatureInvalid('stripe', 'no matching v1 signature');
      return event;
    },
  };
  const registry = { has: () => true, get: () => driver };
  const secrets = { secretFor: async () => secret };

  const settlement = {
    creditVerified: async (p: { id: string }, verified: { referenceId: string; received?: unknown }, source: string) => {
      calls.credited.push({
        id: p.id,
        referenceId: verified.referenceId,
        source,
        tenant: TenantContext.current('spec').id,
        ...(verified.received ? { received: verified.received } : {}),
      });
      return true;
    },
    closeReversed: async (_tx: unknown, p: { id: string }) => {
      calls.reversed.push({ id: p.id, tenant: TenantContext.current('spec').id });
      return true;
    },
    closeFailed: async (_tx: unknown, p: { id: string }) => {
      calls.closed.push({ id: p.id, tenant: TenantContext.current('spec').id });
      return true;
    },
  } as unknown as DepositSettlementService;

  const service = new DepositWebhookService(
    crossTenant as never,
    prisma as never,
    registry as never,
    secrets as never,
    settlement,
  );
  const post = (body = '{"id":"evt_1"}', ref: MerchantGatewayRef = gateway) =>
    runWithTenant({ id: OWNER }, () =>
      service.handle(ref, { rawBody: Buffer.from(body), headers: { 'stripe-signature': 't=1,v1=abc' } }),
    );
  return { post, calls };
}

describe('DepositWebhookService.handle — before the signature', () => {
  it('refuses a bad signature and reads no payment', async () => {
    const { post, calls } = build({ signatureBad: true });

    expect(await post()).toBe('unauthorized');
    expect(calls.crossTenantReads).toEqual([]);
    expect(calls.credited).toEqual([]);
  });

  it('refuses every post while the gateway has no webhook secret (F-104-c not yet)', async () => {
    const { post, calls } = build({ secret: null });

    expect(await post()).toBe('unauthorized');
    expect(calls.verifiedWith).toEqual([]);
    expect(calls.crossTenantReads).toEqual([]);
  });

  it('hands the driver the raw bytes and the secret, untouched', async () => {
    const { post, calls } = build();

    await post('{"a": 1,  "b":2}');

    expect(calls.verifiedWith).toEqual([{ secret: 'whsec_test', body: '{"a": 1,  "b":2}' }]);
  });

  it('is not a door for a gateway whose driver does not settle by webhook', async () => {
    const { post, calls } = build({ settlementMode: 'return' });

    expect(await post()).toBe('not_found');
    expect(calls.verifiedWith).toEqual([]);
  });
});

describe('DepositWebhookService.handle — a signed event (ADR-0051)', () => {
  it('finds the payment by this gateway column and code, and credits it in the payment’s own tenant', async () => {
    const { post, calls } = build();

    expect(await post()).toBe('accepted');

    expect(calls.crossTenantReads).toEqual([{ gatewayId: GATEWAY, gatewayTrackingCode: SESSION }]);
    expect(calls.scopedTenants).toEqual([PAYER_TENANT]);
    expect(calls.credited).toEqual([
      { id: PAYMENT, referenceId: 'pi_0001', source: 'webhook_auto', tenant: PAYER_TENANT },
    ]);
  });

  it('looks on the reseller column for a tenant gateway', async () => {
    const { post, calls } = build({ row: paymentRow({ gatewayId: null, tenantGatewayConfigId: GATEWAY }) });

    await post(undefined, { ...gateway, source: 'tenant' });

    expect(calls.crossTenantReads).toEqual([{ tenantGatewayConfigId: GATEWAY, gatewayTrackingCode: SESSION }]);
  });

  it('closes a payment the provider says failed, in the payment’s tenant', async () => {
    const { post, calls } = build({ event: { kind: 'failed', authority: SESSION } });

    expect(await post()).toBe('accepted');
    expect(calls.closed).toEqual([{ id: PAYMENT, tenant: PAYER_TENANT }]);
    expect(calls.credited).toEqual([]);
  });

  it('closes a payment the provider refunded as reversed, not failed (F-092-ae, F-104-h)', async () => {
    const { post, calls } = build({ event: { kind: 'reversed', authority: SESSION } });

    expect(await post()).toBe('accepted');
    expect(calls.reversed).toEqual([{ id: PAYMENT, tenant: PAYER_TENANT }]);
    expect(calls.closed).toEqual([]);
  });

  it('hands settlement what arrived, in the gateway currency’s own minor unit (F-104-d)', async () => {
    const { post, calls } = build({
      event: { kind: 'paid', authority: SESSION, referenceId: 'pi_0001', received: { amountMinor: BigInt(700), currency: 'USD' } },
    });

    expect(await post()).toBe('accepted');
    expect(calls.credited).toEqual([
      expect.objectContaining({ received: { amountMinor: BigInt(700), currency: 'USD', decimals: 2 } }),
    ]);
  });

  it('settles nothing on a receipt in another currency than the gateway charges — it cannot be valued (F-104-d)', async () => {
    const { post, calls } = build({
      event: { kind: 'paid', authority: SESSION, referenceId: 'pi_0001', received: { amountMinor: BigInt(700), currency: 'BTC' } },
    });

    expect(await post()).toBe('accepted');
    expect(calls.credited).toEqual([]);
    expect(calls.closed).toEqual([]);
  });

  it.each([
    ['an event type the driver ignores', { event: { kind: 'ignored', type: 'customer.created' } as WebhookEvent }],
    ['a still-pending payment', { event: { kind: 'pending', authority: SESSION } as WebhookEvent }],
    ['a code no payment on this gateway carries', { found: null }],
    ['a payment with no tenant', { found: { id: PAYMENT, tenantId: null } }],
    ['a payment already credited', { row: paymentRow({ status: 'success' }) }],
    ['a payment already refused', { row: paymentRow({ status: 'failed' }) }],
  ])('accepts %s and changes nothing', async (_label, setup) => {
    const { post, calls } = build(setup as Setup);

    expect(await post()).toBe('accepted');
    expect(calls.credited).toEqual([]);
    expect(calls.closed).toEqual([]);
  });
});
