/**
 * A reseller topping up its billing wallet with the platform (F-019-b, D-41,
 * ADR-0056).
 *
 * The payment is the platform owner's — its gateway, its vault, its callback
 * host — and only the credit is somebody else's. Every way that goes wrong is
 * silent:
 *
 *  - **the wrong wallet.** A settled top-up credited to the paying *user's*
 *    wallet is money a reseller's owner can spend on VPN configs instead of
 *    the subscription it paid for, and the ledger looks consistent;
 *  - **twice.** A retried callback or a reconciliation sweep that credits the
 *    tenant wallet again. The flip guards it, as for a user's top-up;
 *  - **the wrong pool.** The owner-bound app pool cannot see a reseller's
 *    `tenant_billing_wallet` (strict RLS), so a credit there is a version
 *    conflict on every payment — the payer charged, nothing credited;
 *  - **the wrong door.** A reseller's staff member without
 *    `tenant_billing.topup`, or the platform owner itself, starting one.
 */
import { ConfirmationSource, PaymentStatus, Prisma, TenantBillingReasonType, TenantType } from '@prisma/client';
import { TenantContext, runWithTenant } from '@txnet-backend/shared-core';

import { DepositSettlementService, PaymentRow } from '../payment/deposit/deposit-settlement';
import { TENANT_BILLING_TOPUP, TenantTopupRefused, TenantTopupService } from './tenant-topup.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const RESELLER_OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STAFF = '55555555-5555-4555-8555-555555555555';
const GATEWAY = '99999999-9999-4999-8999-999999999999';
const PAYMENT = '77777777-7777-4777-8777-777777777777';

const d = (v: string) => new Prisma.Decimal(v);

describe('settling a reseller billing top-up', () => {
  function build({ lostTheFlip = false } = {}) {
    const calls = {
      pools: [] as string[],
      userCredits: [] as unknown[],
      tenantCredits: [] as Array<Record<string, unknown>>,
      writes: [] as string[],
    };
    const tx = (pool: string) => ({
      paymentTransaction: {
        updateMany: async ({ where }: { where: { status: PaymentStatus } }) => {
          const matched = !lostTheFlip && where.status === PaymentStatus.pending;
          calls.writes.push(matched ? `flip@${pool}` : `miss@${pool}`);
          return { count: matched ? 1 : 0 };
        },
      },
      outboxEvent: { create: async () => void calls.writes.push('event') },
      gatewaySettlementEntry: { create: async () => void calls.writes.push('accrual') },
      $executeRaw: async () => 0,
    });
    const pool = (name: string) => ({
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        calls.pools.push(name);
        return fn(tx(name));
      },
    });
    const reservations = {
      confirm: async () => void calls.writes.push('confirm'),
      release: async () => void calls.writes.push('release'),
      claimExpired: async () => void calls.writes.push('claim'),
    };
    const userLedger = { credit: async (_tx: unknown, e: unknown) => void calls.userCredits.push(e) };
    const tenantLedger = {
      credit: async (_tx: unknown, e: Record<string, unknown>) => {
        calls.tenantCredits.push(e);
        return { balanceAfter: d('100.00') };
      },
    };
    const service = new DepositSettlementService(
      pool('app') as never,
      reservations as never,
      userLedger as never,
      pool('cross') as never,
      tenantLedger as never,
    );
    return { service, calls };
  }

  const payment = {
    id: PAYMENT,
    userId: RESELLER_OWNER_USER,
    status: PaymentStatus.pending,
    gatewayId: GATEWAY,
    tenantGatewayConfigId: null,
    amountCredited: d('100.00'),
    feeApplied: d('0'),
    chargedAmountMinor: BigInt(10_000),
    exchangeRateSnapshot: null,
    gatewayTrackingCode: 'A1',
    grantId: null,
    billingTenantId: RESELLER,
    gateway: { providerName: 'zarinpal' },
    tenantGatewayConfig: null,
  } as unknown as PaymentRow;

  const asOwner = <T>(fn: () => Promise<T>) => runWithTenant({ id: OWNER }, fn);

  it('credits the reseller billing wallet on the cross-tenant pool, and no user wallet', async () => {
    const { service, calls } = build();
    const credited = await asOwner(() =>
      service.creditVerified(payment, { referenceId: 'R1', cardPan: null }, ConfirmationSource.webhook_auto),
    );

    expect(credited).toBe(true);
    expect(calls.pools).toEqual(['cross']);
    expect(calls.userCredits).toEqual([]);
    expect(calls.tenantCredits).toEqual([
      { tenantId: RESELLER, amount: d('100.00'), reasonType: TenantBillingReasonType.topup_payment, referenceId: PAYMENT },
    ]);
    // No coupon was applied, no grant was used, and no user was credited to announce.
    expect(calls.writes).toEqual(['flip@cross']);
  });

  it('credits nothing on a call that lost the flip', async () => {
    const { service, calls } = build({ lostTheFlip: true });
    const credited = await asOwner(() =>
      service.creditVerified(payment, { referenceId: 'R1', cardPan: null }, ConfirmationSource.reconciliation_auto),
    );

    expect(credited).toBe(false);
    expect(calls.tenantCredits).toEqual([]);
    expect(calls.userCredits).toEqual([]);
  });

  it('leaves a user top-up on the app pool and the user ledger', async () => {
    const { service, calls } = build();
    await asOwner(() =>
      service.creditVerified(
        { ...payment, billingTenantId: null } as PaymentRow,
        { referenceId: 'R1', cardPan: null },
        ConfirmationSource.webhook_auto,
      ),
    );

    expect(calls.pools).toEqual(['app']);
    expect(calls.tenantCredits).toEqual([]);
    expect(calls.userCredits).toHaveLength(1);
  });
});

describe('starting a reseller billing top-up', () => {
  function build() {
    const tenants = new Map([
      [OWNER, { id: OWNER, tenantType: TenantType.platform_owner, ownerUserId: 'x' }],
      [RESELLER, { id: RESELLER, tenantType: TenantType.reseller, ownerUserId: RESELLER_OWNER_USER }],
    ]);
    const prisma = {
      tenant: {
        findUnique: async ({ where }: { where: { id: string } }) => tenants.get(where.id) ?? null,
        findFirst: async () => ({ id: OWNER }),
      },
    };
    const seen: Array<{ scope: string; request?: Record<string, unknown> }> = [];
    const starts = {
      start: async (request: Record<string, unknown>) => {
        seen.push({ scope: TenantContext.current().id, request });
        return { paymentId: PAYMENT, redirectUrl: 'https://bank/pay' };
      },
    };
    const deposits = {
      listGateways: async () => {
        seen.push({ scope: TenantContext.current().id });
        return [
          { id: GATEWAY, source: 'platform' },
          { id: 'owner-own', source: 'tenant' },
        ];
      },
    };
    const service = new TenantTopupService(prisma as never, deposits as never, starts as never);
    return { service, seen };
  }

  const asReseller = <T>(fn: () => Promise<T>) => runWithTenant({ id: RESELLER }, fn);
  const body = { gatewayId: GATEWAY, amount: '100.00' };

  it("starts the payment in the platform owner's scope, on a platform gateway, naming the reseller", async () => {
    const { service, seen } = build();
    await asReseller(() =>
      service.start({ userId: RESELLER_OWNER_USER, tenantId: RESELLER, permissions: [] }, body, 'https://panel.example'),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].scope).toBe(OWNER);
    expect(seen[0].request).toMatchObject({
      userId: RESELLER_OWNER_USER,
      gatewayId: GATEWAY,
      source: 'platform',
      amount: d('100.00'),
      couponCodes: [],
      canTest: false,
      billingTenantId: RESELLER,
    });
  });

  it('admits a staff member only with tenant_billing.topup', async () => {
    const { service, seen } = build();
    const staff = (permissions: string[]) => ({ userId: STAFF, tenantId: RESELLER, permissions });

    await expect(asReseller(() => service.start(staff([]), body, null))).rejects.toMatchObject({
      reason: 'not_permitted',
    });
    expect(seen).toEqual([]);

    await asReseller(() => service.start(staff([TENANT_BILLING_TOPUP]), body, null));
    expect(seen).toHaveLength(1);
  });

  it('refuses the platform owner: it has no billing wallet to top up', async () => {
    const { service, seen } = build();
    const refused = runWithTenant({ id: OWNER }, () =>
      service.start({ userId: 'x', tenantId: OWNER, permissions: ['*'] }, body, null),
    );

    await expect(refused).rejects.toBeInstanceOf(TenantTopupRefused);
    await expect(refused).rejects.toMatchObject({ reason: 'not_a_reseller' });
    expect(seen).toEqual([]);
  });

  it("lists only the platform owner's platform gateways", async () => {
    const { service, seen } = build();
    const rows = await asReseller(() =>
      service.gateways({ userId: RESELLER_OWNER_USER, tenantId: RESELLER, permissions: [] }),
    );

    expect(rows.map((r) => r.id)).toEqual([GATEWAY]);
    expect(seen[0].scope).toBe(OWNER);
  });
});
