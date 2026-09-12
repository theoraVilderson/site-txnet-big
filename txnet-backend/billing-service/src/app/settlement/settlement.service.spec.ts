/**
 * The operator surface over granted gateways (F-096-e, ADR-0041 §5/§6).
 *
 * This class is the only thing on the platform that reads and writes the
 * settlement ledger across tenants, on a connection whose RLS policy is
 * `USING (true)`. So the invariant it turns on is not any one of its
 * operations: it is that **no operation runs for a caller who is not the
 * platform owner**, and that is asserted over every public method by
 * construction rather than one test per route, because the way it breaks is a
 * method added later that forgets the call.
 *
 * The rest is what cannot be seen from the routes:
 *
 *  - a grant of a gateway to the tenant that already owns it. Postgres would
 *    take it happily; `deposit-pricing.ts` would then list the gateway twice on
 *    the top-up screen, and a payment through it would accrue a debt from a
 *    tenant to itself — money the platform never held;
 *  - a second live grant of the same gateway to the same tenant. Nothing
 *    downstream picks between two, so withdrawing one leaves the gateway
 *    working with no visible reason why;
 *  - a withdrawal that lost its race. Two operators on one screen, one grant
 *    stopped, two audit rows each claiming to be the one that stopped it;
 *  - the arithmetic of what is owed, including the tenant with a payout and no
 *    accrual — the one row an operator most needs to see;
 *  - a payout larger than the outstanding balance, which is a typo far more
 *    often than a transfer, and which no later recording can undo.
 *
 * Every write is asserted to land **inside** the transaction and after the row
 * it describes, for the reason F-096-d asserts the same thing about the
 * accrual: an audit row that commits separately from the act it records is a
 * grant with nobody's name on it the first time a transaction rolls back.
 */
import { Prisma, TenantType } from '@prisma/client';

import { SettlementRefused, SettlementService } from './settlement.service';

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const BORROWER = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PLATFORM_GATEWAY = '55555555-5555-4555-8555-555555555555';
const RESELLER_GATEWAY = '66666666-6666-4666-8666-666666666666';
const GRANT = '77777777-7777-4777-8777-777777777777';

const d = (v: string) => new Prisma.Decimal(v);

const operator = (tenantId = OWNER_TENANT) => ({ adminId: ADMIN, tenantId, ip: '10.0.0.9' });

type Seed = {
  /** Tenant id -> its type. Anything absent does not exist. */
  tenants?: Record<string, TenantType>;
  /** Live + withdrawn grants the fake store already holds. */
  grants?: Array<Record<string, unknown>>;
  /** Per-tenant accrual and payout sums, as the two ledgers would answer them. */
  accrued?: Record<string, string>;
  paidOut?: Record<string, string>;
  /** `tenant_gateway_config` rows, by id -> owning tenant. */
  configs?: Record<string, string>;
  /** `payment_gateway` rows that exist. */
  gateways?: string[];
  /**
   * Another operator withdraws the grant between this call's read and its
   * update — the race `updateMany`'s `isActive` filter exists for.
   */
  withdrawnBehindTheRead?: boolean;
};

type Calls = {
  /** Everything written, in order, so "inside the transaction" is checkable. */
  writes: string[];
  audit: Array<Record<string, unknown>>;
  grants: Array<Record<string, unknown>>;
  payouts: Array<Record<string, unknown>>;
  committed: boolean;
};

function build(seed: Seed = {}) {
  const tenants = seed.tenants ?? { [OWNER_TENANT]: TenantType.platform_owner };
  const grants = seed.grants ?? [];
  const configs = seed.configs ?? { [RESELLER_GATEWAY]: OTHER_TENANT };
  const gateways = new Set(seed.gateways ?? [PLATFORM_GATEWAY]);
  const accrued = seed.accrued ?? {};
  const paidOut = seed.paidOut ?? {};

  const calls: Calls = { writes: [], audit: [], grants: [], payouts: [], committed: false };

  const sums = (of: Record<string, string>) =>
    Object.entries(of).map(([tenantId, amount]) => ({ tenantId, _sum: { amount: d(amount) } }));

  const tx = {
    paymentGatewayGrant: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.writes.push('grant');
        calls.grants.push(data);
        return { ...data, id: GRANT, isActive: true, grantedAt: new Date('2026-09-12T00:00:00Z') };
      },
      updateMany: async ({ where }: { where: Record<string, unknown> }) => {
        calls.writes.push('withdraw');
        // The whole `where` is honoured, not just the id: the `isActive: true`
        // guard is the thing the race test is about, so a fake that assumed it
        // would pass whether the code had it or not.
        const row = grants.find(
          (g) =>
            g['id'] === where['id'] &&
            (where['isActive'] === undefined || g['isActive'] === where['isActive']),
        );
        if (row) row['isActive'] = false;
        return { count: row ? 1 : 0 };
      },
    },
    gatewaySettlementPayout: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.writes.push('payout');
        calls.payouts.push(data);
        return { ...data, id: 'payout-1', paidAt: new Date('2026-09-12T00:00:00Z') };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.writes.push('audit');
        calls.audit.push(data);
        return { id: 'audit-1' };
      },
    },
  };

  /** The caller's own pool. One read only: who is asking. */
  const app = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        tenants[where.id] ? { tenantType: tenants[where.id] } : null,
    },
  };

  const all = {
    ...tx,
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        tenants[where.id] ? { id: where.id, tenantType: tenants[where.id] } : null,
      findFirst: async () => {
        const owner = Object.entries(tenants).find(([, t]) => t === TenantType.platform_owner);
        return owner ? { id: owner[0] } : null;
      },
    },
    paymentGateway: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        gateways.has(where.id) ? { id: where.id } : null,
    },
    tenantGatewayConfig: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        configs[where.id] ? { tenantId: configs[where.id] } : null,
    },
    paymentGatewayGrant: {
      ...tx.paymentGatewayGrant,
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        grants.find(
          (g) =>
            g['tenantId'] === where['tenantId'] &&
            g['isActive'] === true &&
            (g['gatewayId'] ?? null) === (where['gatewayId'] ?? null) &&
            (g['tenantGatewayConfigId'] ?? null) === (where['tenantGatewayConfigId'] ?? null),
        ) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = grants.find((g) => g['id'] === where.id) ?? null;
        if (row && seed.withdrawnBehindTheRead) {
          // Answer the read with the row as it was, then let the other
          // operator's transaction land before ours reaches `updateMany`.
          const asRead = { ...row };
          row['isActive'] = false;
          return asRead;
        }
        return row;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        grants.filter((g) => !where['tenantId'] || g['tenantId'] === where['tenantId']),
    },
    gatewaySettlementEntry: {
      groupBy: async () => sums(accrued),
      aggregate: async ({ where }: { where: { tenantId: string } }) => ({
        _sum: { amount: accrued[where.tenantId] ? d(accrued[where.tenantId]) : null },
      }),
    },
    gatewaySettlementPayout: {
      ...tx.gatewaySettlementPayout,
      groupBy: async () => sums(paidOut),
      aggregate: async ({ where }: { where: { tenantId: string } }) => ({
        _sum: { amount: paidOut[where.tenantId] ? d(paidOut[where.tenantId]) : null },
      }),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      const out = await fn(tx);
      calls.committed = true;
      return out;
    },
  };

  const service = new SettlementService(
    app as never,
    all as never,
  );
  return { service, calls };
}

/** Every public operation, named once, so a method added later is covered here. */
const EVERY_OPERATION: Array<[string, (s: SettlementService, who: ReturnType<typeof operator>) => Promise<unknown>]> = [
  ['listGrants', (s, who) => s.listGrants(who)],
  ['owed', (s, who) => s.owed(who)],
  [
    'createGrant',
    (s, who) => s.createGrant({ tenantId: BORROWER, gatewayId: PLATFORM_GATEWAY }, who),
  ],
  ['withdrawGrant', (s, who) => s.withdrawGrant(GRANT, who)],
  ['recordPayout', (s, who) => s.recordPayout({ tenantId: BORROWER, amount: d('1.00') }, who)],
];

describe('the settlement operator surface', () => {
  describe('the door', () => {
    it.each(EVERY_OPERATION)(
      '%s refuses a caller whose tenant is not the platform owner, and writes nothing',
      async (_name, run) => {
        const { service, calls } = build({
          tenants: {
            [OWNER_TENANT]: TenantType.platform_owner,
            [BORROWER]: TenantType.reseller,
          },
        });

        // A reseller's own admin can hold `settlement.manage` — its tenant
        // administers its own roles — so the permission guard is not what
        // stops this. Reaching the cross-tenant pool at all would let it grant
        // itself the platform's gateway.
        await expect(run(service, operator(BORROWER))).rejects.toMatchObject({
          reason: 'not_platform_owner',
        });
        expect(calls.writes).toEqual([]);
      },
    );

    it('refuses a caller whose tenant does not exist at all', async () => {
      const { service } = build();
      await expect(service.owed(operator(OTHER_TENANT))).rejects.toBeInstanceOf(SettlementRefused);
    });
  });

  describe('granting', () => {
    it('writes the grant and its audit row in one transaction, the audit second', async () => {
      const { service, calls } = build({
        tenants: { [OWNER_TENANT]: TenantType.platform_owner, [BORROWER]: TenantType.reseller },
      });

      await service.createGrant(
        { tenantId: BORROWER, gatewayId: PLATFORM_GATEWAY, note: 'part of the gold plan' },
        operator(),
      );

      expect(calls.writes).toEqual(['grant', 'audit']);
      expect(calls.committed).toBe(true);
      expect(calls.grants[0]).toMatchObject({
        tenantId: BORROWER,
        gatewayId: PLATFORM_GATEWAY,
        tenantGatewayConfigId: null,
        grantedByAdminId: ADMIN,
        note: 'part of the gold plan',
      });
      expect(calls.audit[0]).toMatchObject({
        adminId: ADMIN,
        action: 'gateway_grant_create',
        targetEntityType: 'gateway_grant',
        targetEntityId: GRANT,
        adminIpAddress: '10.0.0.9',
      });
      // The owner is re-derived, never taken from the caller — the same rule
      // `granted-vault-access.ts` follows at charge time.
      expect(calls.audit[0]['newValue']).toMatchObject({ ownerTenantId: OWNER_TENANT });
    });

    it('refuses granting a gateway to the tenant that already owns it', async () => {
      const { service, calls } = build({
        tenants: {
          [OWNER_TENANT]: TenantType.platform_owner,
          [OTHER_TENANT]: TenantType.reseller,
        },
      });

      await expect(
        service.createGrant({ tenantId: OTHER_TENANT, tenantGatewayConfigId: RESELLER_GATEWAY }, operator()),
      ).rejects.toMatchObject({ reason: 'grant_to_owner' });
      expect(calls.writes).toEqual([]);
    });

    it('refuses the platform owner granting a platform gateway to itself', async () => {
      const { service } = build();
      await expect(
        service.createGrant({ tenantId: OWNER_TENANT, gatewayId: PLATFORM_GATEWAY }, operator()),
      ).rejects.toMatchObject({ reason: 'grant_to_owner' });
    });

    it('refuses a second live grant of the same gateway to the same tenant', async () => {
      const { service, calls } = build({
        tenants: { [OWNER_TENANT]: TenantType.platform_owner, [BORROWER]: TenantType.reseller },
        grants: [
          { id: GRANT, tenantId: BORROWER, gatewayId: PLATFORM_GATEWAY, tenantGatewayConfigId: null, isActive: true },
        ],
      });

      await expect(
        service.createGrant({ tenantId: BORROWER, gatewayId: PLATFORM_GATEWAY }, operator()),
      ).rejects.toMatchObject({ reason: 'already_granted' });
      expect(calls.writes).toEqual([]);
    });

    it('allows the same gateway again once the first grant is withdrawn', async () => {
      const { service, calls } = build({
        tenants: { [OWNER_TENANT]: TenantType.platform_owner, [BORROWER]: TenantType.reseller },
        grants: [
          { id: GRANT, tenantId: BORROWER, gatewayId: PLATFORM_GATEWAY, tenantGatewayConfigId: null, isActive: false },
        ],
      });

      await service.createGrant({ tenantId: BORROWER, gatewayId: PLATFORM_GATEWAY }, operator());
      expect(calls.writes).toEqual(['grant', 'audit']);
    });

    it('refuses a grant that names neither a gateway nor a tenant config', async () => {
      const { service } = build();
      await expect(service.createGrant({ tenantId: BORROWER }, operator())).rejects.toBeInstanceOf(
        SettlementRefused,
      );
    });

    it('refuses a grant to a tenant that does not exist', async () => {
      const { service } = build();
      await expect(
        service.createGrant({ tenantId: OTHER_TENANT, gatewayId: PLATFORM_GATEWAY }, operator()),
      ).rejects.toMatchObject({ reason: 'tenant_not_found' });
    });
  });

  describe('withdrawing', () => {
    const live = () => ({
      tenants: { [OWNER_TENANT]: TenantType.platform_owner, [BORROWER]: TenantType.reseller },
      grants: [
        { id: GRANT, tenantId: BORROWER, gatewayId: PLATFORM_GATEWAY, tenantGatewayConfigId: null, isActive: true },
      ],
    });

    it('stops the grant and audits who stopped it, in one transaction', async () => {
      const { service, calls } = build(live());

      const result = await service.withdrawGrant(GRANT, operator());

      expect(result.isActive).toBe(false);
      expect(calls.writes).toEqual(['withdraw', 'audit']);
      expect(calls.committed).toBe(true);
      expect(calls.audit[0]).toMatchObject({
        tenantId: BORROWER,
        adminId: ADMIN,
        action: 'gateway_grant_withdraw',
        targetEntityType: 'gateway_grant',
        targetEntityId: GRANT,
      });
      expect(calls.audit[0]['oldValue']).toEqual({ isActive: true });
    });

    it('refuses a grant that is already withdrawn, rather than auditing it twice', async () => {
      const seed = live();
      seed.grants[0]['isActive'] = false;
      const { service, calls } = build(seed);

      await expect(service.withdrawGrant(GRANT, operator())).rejects.toMatchObject({
        reason: 'already_withdrawn',
      });
      expect(calls.writes).toEqual([]);
    });

    it('refuses a grant that does not exist', async () => {
      const { service } = build();
      await expect(service.withdrawGrant(GRANT, operator())).rejects.toMatchObject({
        reason: 'grant_not_found',
      });
    });

    it('writes no audit row when the update loses the race', async () => {
      // Two operators on one screen. The grant is live when this call reads it
      // and withdrawn by the time the update runs, so `updateMany`'s
      // `isActive: true` filter matches nothing. Without that filter both calls
      // would succeed and both audit rows would claim to be the one that
      // stopped the grant — which is why the guard is in the `where` and not in
      // the `if` above it.
      const { service, calls } = build({ ...live(), withdrawnBehindTheRead: true });

      await expect(service.withdrawGrant(GRANT, operator())).rejects.toMatchObject({
        reason: 'already_withdrawn',
      });
      expect(calls.writes).toEqual(['withdraw']);
      expect(calls.audit).toEqual([]);
    });
  });

  describe('what is owed', () => {
    it('is every accrual minus every payout, most owed first', async () => {
      const { service } = build({
        accrued: { [BORROWER]: '100.00', [OTHER_TENANT]: '250.50' },
        paidOut: { [BORROWER]: '40.00', [OTHER_TENANT]: '250.50' },
      });

      const rows = await service.owed(operator());

      expect(rows.map((r) => [r.tenantId, r.outstanding.toFixed(2)])).toEqual([
        [BORROWER, '60.00'],
        [OTHER_TENANT, '0.00'],
      ]);
    });

    it('shows a tenant with a payout and no accrual, rather than hiding it', async () => {
      const { service } = build({ accrued: {}, paidOut: { [BORROWER]: '10.00' } });

      const rows = await service.owed(operator());

      expect(rows).toHaveLength(1);
      expect(rows[0].accrued.toFixed(2)).toBe('0.00');
      expect(rows[0].outstanding.toFixed(2)).toBe('-10.00');
    });
  });

  describe('recording a payout', () => {
    const owing = { accrued: { [BORROWER]: '100.00' }, paidOut: { [BORROWER]: '40.00' } };

    it('writes the payout and its audit row in one transaction, the audit second', async () => {
      const { service, calls } = build(owing);

      await service.recordPayout(
        {
          tenantId: BORROWER,
          amount: d('60.00'),
          method: 'sheba',
          reference: 'IR12',
          proofAttachmentKey: 'operator/typed/this.pdf',
          notes: 'end of month',
        },
        operator(),
      );

      expect(calls.writes).toEqual(['payout', 'audit']);
      expect(calls.committed).toBe(true);
      expect(calls.payouts[0]).toMatchObject({
        tenantId: BORROWER,
        recordedByAdminId: ADMIN,
        method: 'sheba',
        reference: 'IR12',
        // Stored verbatim: nothing resolves or serves it until F-033 (D-8's port).
        proofAttachmentKey: 'operator/typed/this.pdf',
      });
      expect(calls.audit[0]).toMatchObject({
        action: 'gateway_settlement_payout',
        targetEntityType: 'settlement_payout',
        adminId: ADMIN,
      });
      // The balance before and after, so the trail is readable without
      // re-summing the ledger at the time it is read.
      expect(calls.audit[0]['oldValue']).toEqual({ outstanding: '60.00' });
      expect(calls.audit[0]['newValue']).toMatchObject({ amount: '60.00', outstanding: '0.00' });
    });

    it('records a payout with no proof key at all', async () => {
      const { service, calls } = build(owing);
      await service.recordPayout({ tenantId: BORROWER, amount: d('1.00') }, operator());
      expect(calls.payouts[0]).toMatchObject({ proofAttachmentKey: null });
    });

    it('refuses more than is outstanding, which is a typo far more often than a transfer', async () => {
      const { service, calls } = build(owing);

      await expect(
        service.recordPayout({ tenantId: BORROWER, amount: d('60.01') }, operator()),
      ).rejects.toMatchObject({ reason: 'exceeds_outstanding' });
      expect(calls.writes).toEqual([]);
    });

    it('refuses zero and refuses a negative, which would be an invoice wearing a payout', async () => {
      const { service } = build(owing);
      for (const amount of ['0', '0.00', '-5.00']) {
        await expect(
          service.recordPayout({ tenantId: BORROWER, amount: d(amount) }, operator()),
        ).rejects.toMatchObject({ reason: 'amount_not_positive' });
      }
    });

    it('refuses any payout to a tenant that is owed nothing', async () => {
      const { service } = build();
      await expect(
        service.recordPayout({ tenantId: BORROWER, amount: d('1.00') }, operator()),
      ).rejects.toMatchObject({ reason: 'exceeds_outstanding' });
    });
  });
});
