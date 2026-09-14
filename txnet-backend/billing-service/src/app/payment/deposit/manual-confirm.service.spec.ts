/**
 * A person confirming a verifying payment (F-092-z, ADR-0044 decision 6).
 *
 * What would break silently here, and nowhere else:
 *  - **scope**: the platform owner may confirm any payment; any other tenant
 *    only a payment its own user made on its own `tenant_gateway_config` — never
 *    a platform gateway's, another tenant's, or one taken under a grant. Every
 *    other case is the same `payment_not_found`, so a refusal confirms nothing;
 *  - **the gateway is asked first, every time**. Only an unsettled answer
 *    (`in_bank`, silence) lets a person credit; a gateway that confirmed,
 *    refused or reported a different amount decides it, and the person does not;
 *  - the manual credit is `admin_manual` with the person's id, the gateway's
 *    reference and the reason, through the one guarded settlement path, and its
 *    `payment_manual_confirm` audit row is written **in that transaction**;
 *  - only a `pending` payment that is verifying or flagged is eligible.
 */
import { ConfirmationSource, PaymentStatus, Prisma, TenantType } from '@prisma/client';
import { TenantContext } from '@txnet-backend/shared-core';

import type { AskAnswer } from './deposit-reconciliation.service';
import { ManualConfirmRefused, ManualConfirmService } from './manual-confirm.service';

const OWNER = '00000000-0000-4000-8000-000000000001';
const RESELLER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const CONFIG = '99999999-9999-4999-8999-999999999999';
const PAYMENT = '77777777-7777-4777-8777-777777777777';

const d = (v: string) => new Prisma.Decimal(v);

function scopeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT,
    tenantId: RESELLER,
    status: PaymentStatus.pending,
    nextVerifyAt: new Date(),
    verifyFlaggedAt: null,
    gatewayId: null,
    tenantGatewayConfigId: CONFIG,
    grantId: null,
    tenantGatewayConfig: { tenantId: RESELLER },
    ...overrides,
  };
}

function paymentRow() {
  return {
    id: PAYMENT,
    userId: USER,
    status: PaymentStatus.pending,
    gatewayId: null,
    tenantGatewayConfigId: CONFIG,
    amountCredited: d('19.80'),
    feeApplied: d('0.20'),
    chargedAmountMinor: BigInt(19_800_000),
    gatewayTrackingCode: 'A1',
    gatewayReferenceId: null,
    grantId: null,
    verifyAttempts: 4,
    nextVerifyAt: new Date(),
    tenantGatewayConfig: { providerName: 'zarinpal' },
    gateway: null,
  };
}

type Setup = {
  callerTenant?: string;
  row?: ReturnType<typeof scopeRow> | null;
  ask?: AskAnswer;
  lostTheFlip?: boolean;
  /** How many rows the guarded authority write matches; a throw is the unique index refusing it. */
  attach?: number | Error;
};

function build(setup: Setup = {}) {
  const { callerTenant = RESELLER, row = scopeRow(), ask = { kind: 'unanswered', gatewayStatus: null, referenceId: null }, lostTheFlip = false, attach = 1 } = setup;
  const calls = {
    asked: [] as Array<{ paymentId: string; tenantInScope: string | null }>,
    credits: [] as Array<{ source: string; verified: unknown; manual: Record<string, unknown> | undefined; tenantInScope: string | null }>,
    listed: [] as Array<Record<string, unknown>>,
    attached: [] as Array<Record<string, unknown>>,
  };

  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        tenantType: where.id === OWNER ? TenantType.platform_owner : TenantType.reseller,
      }),
    },
    $transaction: (fn: (t: unknown) => unknown) =>
      fn({
        $executeRaw: async () => 0,
        paymentTransaction: {
          findFirst: async () => paymentRow(),
          updateMany: async (args: Record<string, unknown>) => {
            calls.attached.push({ ...args, tenantInScope: TenantContext.currentOrNull()?.id ?? null });
            if (attach instanceof Error) throw attach;
            return { count: attach };
          },
        },
      }),
  };
  const crossTenant = {
    paymentTransaction: {
      findUnique: async () => row,
      findMany: async (args: Record<string, unknown>) => {
        calls.listed.push(args);
        return [];
      },
    },
  };
  const reconciliation = {
    askOnce: async (paymentId: string) => {
      calls.asked.push({ paymentId, tenantInScope: TenantContext.currentOrNull()?.id ?? null });
      return ask;
    },
  };
  const settlement = {
    creditVerified: async (_p: unknown, verified: unknown, source: string, manual?: Record<string, unknown>) => {
      calls.credits.push({ source, verified, manual, tenantInScope: TenantContext.currentOrNull()?.id ?? null });
      return !lostTheFlip;
    },
  };

  const config = { get: (key: string) => (key === 'RECONCILIATION_LOOKBACK_SEC' ? 7 * 86_400 : undefined) };
  const service = new ManualConfirmService(
    prisma as never,
    crossTenant as never,
    reconciliation as never,
    settlement as never,
    config as never,
  );
  const actor = { adminId: ADMIN, tenantId: callerTenant, ip: '10.0.0.9' };
  return { service, calls, actor };
}

const BODY = { referenceId: '900900900', reason: 'Checked the Zarinpal panel: paid at 10:02' };

describe('ManualConfirmService scope', () => {
  it('lets a tenant act on its own user’s payment on its own gateway config', async () => {
    const { service, calls, actor } = build();
    await service.inquire(actor, PAYMENT);
    expect(calls.asked).toEqual([{ paymentId: PAYMENT, tenantInScope: RESELLER }]);
  });

  it.each([
    ['a platform gateway', scopeRow({ gatewayId: CONFIG, tenantGatewayConfigId: null, tenantGatewayConfig: null })],
    ['another tenant’s payment', scopeRow({ tenantId: OTHER, tenantGatewayConfig: { tenantId: OTHER } })],
    ['a payment taken under a grant', scopeRow({ grantId: CONFIG })],
    ['a gateway config it does not own', scopeRow({ tenantGatewayConfig: { tenantId: OTHER } })],
    ['no such payment', null],
  ])('refuses a tenant %s as not found', async (_what, row) => {
    const { service, calls, actor } = build({ row });
    await expect(service.confirm(actor, PAYMENT, BODY)).rejects.toMatchObject({ reason: 'payment_not_found' });
    expect(calls.asked).toEqual([]);
  });

  it('lets the platform owner act on any tenant’s payment, inside that tenant’s scope', async () => {
    const { service, calls, actor } = build({
      callerTenant: OWNER,
      row: scopeRow({ tenantId: OTHER, grantId: CONFIG, tenantGatewayConfig: { tenantId: OTHER } }),
    });
    await service.inquire(actor, PAYMENT);
    expect(calls.asked[0].tenantInScope).toBe(OTHER);
  });

  it('confines a tenant’s list to its own users on its own gateway configs', async () => {
    const { service, calls, actor } = build();
    await service.list(actor);
    expect(calls.listed[0]['where']).toMatchObject({
      tenantId: RESELLER,
      grantId: null,
      tenantGatewayConfig: { tenantId: RESELLER },
    });
  });

  // F-092-af (ADR-0046 decision 7): a payer in a hurry messages the operator;
  // the operator must be able to act on the payment whatever the jobs have
  // or have not got round to — not only once it is verifying.
  it('lists every open payment inside the lookback: pending or expired, verifying or not, with or without an authority', async () => {
    const { service, calls, actor } = build({ callerTenant: OWNER });
    const before = Date.now();
    await service.list(actor);
    const where = calls.listed[0]['where'] as Record<string, { in?: string[]; gte?: Date }>;
    expect(where['status']).toEqual({ in: [PaymentStatus.pending, PaymentStatus.expired] });
    expect(before - where['createdAt'].gte!.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000 - 1_000);
    expect(where).not.toHaveProperty('OR');
    expect(where).not.toHaveProperty('gatewayTrackingCode');
  });

  it.each([
    ['a pending payment not yet verifying', scopeRow({ nextVerifyAt: null })],
    ['an expired payment', scopeRow({ status: PaymentStatus.expired, nextVerifyAt: null })],
    ['a flagged payment whose clock was cleared', scopeRow({ nextVerifyAt: null, verifyFlaggedAt: new Date() })],
  ])('accepts %s', async (_what, row) => {
    const { service, calls, actor } = build({ row });
    await service.inquire(actor, PAYMENT);
    expect(calls.asked).toHaveLength(1);
  });

  it.each([PaymentStatus.success, PaymentStatus.failed])('refuses a %s payment as not open', async (status) => {
    const { service, calls, actor } = build({ row: scopeRow({ status }) });
    await expect(service.confirm(actor, PAYMENT, BODY)).rejects.toBeInstanceOf(ManualConfirmRefused);
    await expect(service.confirm(actor, PAYMENT, BODY)).rejects.toMatchObject({ reason: 'not_open' });
    expect(calls.asked).toEqual([]);
  });
});

describe('ManualConfirmService.confirm', () => {
  it('credits admin_manual with the reference, the person and the reason when the gateway stays silent', async () => {
    const { service, calls, actor } = build();

    const result = await service.confirm(actor, PAYMENT, BODY);

    expect(calls.asked).toHaveLength(1);
    expect(calls.credits).toEqual([
      {
        source: ConfirmationSource.admin_manual,
        verified: { referenceId: '900900900', cardPan: null },
        manual: { adminId: ADMIN, reason: BODY.reason, ip: '10.0.0.9' },
        tenantInScope: RESELLER,
      },
    ]);
    expect(result).toEqual({ paymentId: PAYMENT, outcome: 'confirmed_manually', gatewayStatus: null, referenceId: '900900900' });
  });

  it('credits manually on in_bank too — that is not a settled answer', async () => {
    const { service, calls, actor } = build({ ask: { kind: 'in_bank', gatewayStatus: 'in_bank', referenceId: null } });
    await service.confirm(actor, PAYMENT, BODY);
    expect(calls.credits).toHaveLength(1);
  });

  it.each<[AskAnswer['kind'], string]>([
    ['credited', 'credited'],
    ['already_settled', 'already_settled'],
    ['refused', 'refused'],
    ['mismatch', 'mismatch'],
  ])('lets a settled gateway answer (%s) decide, and credits nothing by hand', async (kind, outcome) => {
    const { service, calls, actor } = build({ ask: { kind, gatewayStatus: 'paid', referenceId: 'R' } });

    const result = await service.confirm(actor, PAYMENT, BODY);

    expect(calls.credits).toEqual([]);
    expect(result.outcome).toBe(outcome);
  });

  it('answers already_settled when another path won the flip between the ask and the credit', async () => {
    const { service, actor } = build({ lostTheFlip: true });
    expect((await service.confirm(actor, PAYMENT, BODY)).outcome).toBe('already_settled');
  });
});

describe('ManualConfirmService.attachAuthority (F-092-ad, F-092-af)', () => {
  const AUTH = 'A00000000000000000000000000000000077';

  it('writes the authority only where the payment has none, inside its tenant, then asks the gateway', async () => {
    const { service, calls, actor } = build({
      row: scopeRow({ nextVerifyAt: null, gatewayTrackingCode: null }),
      ask: { kind: 'credited', gatewayStatus: 'paid', referenceId: 'R-9' },
    });

    const result = await service.attachAuthority(actor, PAYMENT, AUTH);

    expect(calls.attached).toEqual([
      { where: { id: PAYMENT, gatewayTrackingCode: null }, data: { gatewayTrackingCode: AUTH }, tenantInScope: RESELLER },
    ]);
    expect(calls.asked).toEqual([{ paymentId: PAYMENT, tenantInScope: RESELLER }]);
    expect(result).toEqual({ paymentId: PAYMENT, outcome: 'credited', gatewayStatus: 'paid', referenceId: 'R-9' });
  });

  it('refuses a payment that already carries an authority, and asks nothing', async () => {
    const { service, calls, actor } = build({ row: scopeRow({ gatewayTrackingCode: 'A1' }) });

    await expect(service.attachAuthority(actor, PAYMENT, AUTH)).rejects.toMatchObject({ reason: 'authority_present' });
    expect(calls.attached).toEqual([]);
    expect(calls.asked).toEqual([]);
  });

  it('refuses an authority another payment already holds', async () => {
    const taken = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
    const { service, calls, actor } = build({ row: scopeRow({ gatewayTrackingCode: null }), attach: taken });

    await expect(service.attachAuthority(actor, PAYMENT, AUTH)).rejects.toMatchObject({ reason: 'authority_taken' });
    expect(calls.asked).toEqual([]);
  });

  it('refuses when an authority arrived between the read and the write', async () => {
    const { service, actor } = build({ row: scopeRow({ gatewayTrackingCode: null }), attach: 0 });

    await expect(service.attachAuthority(actor, PAYMENT, AUTH)).rejects.toMatchObject({ reason: 'authority_present' });
  });
});

