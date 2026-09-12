/**
 * The one crossing of the tenant-bound vault connection (ADR-0041 §3, F-096-c).
 *
 * This is a boundary, so what matters is not that it opens but **what it
 * refuses**, and each case below is a way a borrower could otherwise reach a
 * credential it was never lent:
 *
 *  - a grant id that belongs to somebody else. The read runs on the
 *    application pool inside the borrower's own scope, so RLS is what answers
 *    nothing — the spec stands in for the policy by scoping the fake the same
 *    way, and `gateway-merchant.int.spec.ts` proves the policy itself;
 *  - a withdrawn grant, which is the same refusal a moment later;
 *  - a **live grant of a different gateway**: without that check one grant
 *    would be a key to every gateway the lender owns, which is the widest of
 *    the mistakes available here;
 *  - the owner named by the caller. It is never read: the owner is re-derived
 *    from the grant, so a ref carrying somebody else's tenant id changes
 *    nothing.
 *
 * And one positive: the override is open for the duration of the call and shut
 * the moment it returns, including when the call throws — a leaked override is
 * a later, unrelated vault read served from the wrong tenant.
 */
import { TenantContext, runWithTenant } from '@txnet-backend/shared-core';

import { GrantNotUsable, GrantedVaultAccess, vaultTenantOverride } from './granted-vault-access';

const BORROWER = '11111111-1111-4111-8111-111111111111';
const LENDER = '22222222-2222-4222-8222-222222222222';
const PLATFORM_OWNER = '33333333-3333-4333-8333-333333333333';
const GATEWAY = '99999999-9999-4999-8999-999999999999';
const OTHER_GATEWAY = '99999999-9999-4999-8999-999999999998';
const GRANT = 'aaaaaaaa-0000-4000-8000-000000000001';

type Setup = {
  /** The grant row, as the borrower's own scope would answer it. `null` = no such grant for this tenant. */
  grant?: { gatewayId: string | null; tenantGatewayConfigId: string | null } | null;
  /** Whether a platform-owner tenant row exists. */
  platformOwner?: boolean;
  /** The lender the cross-tenant read finds for the gateway, if any. */
  configOwner?: string | null;
};

function build(setup: Setup = {}) {
  const {
    grant = { gatewayId: null, tenantGatewayConfigId: GATEWAY },
    platformOwner = true,
    configOwner = LENDER,
  } = setup;

  const reads: Array<Record<string, unknown>> = [];

  const tx = {
    $executeRaw: async () => 0,
    paymentGatewayGrant: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        reads.push(where);
        // The policy, stood in for: a grant is answered only inside the scope
        // it was made to.
        return where['tenantId'] === TenantContext.current('spec').id ? grant : null;
      },
    },
    tenant: {
      findFirst: async () => (platformOwner ? { id: PLATFORM_OWNER } : null),
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const crossTenant = {
    tenantGatewayConfig: {
      findUnique: async () => (configOwner ? { tenantId: configOwner } : null),
    },
  };

  return { access: new GrantedVaultAccess(prisma as never, crossTenant as never), reads };
}

const asBorrower = <T>(fn: () => Promise<T>) => runWithTenant({ id: BORROWER }, fn);

describe('GrantedVaultAccess', () => {
  it('opens the lender\'s vault along a live grant of that gateway', async () => {
    const { access } = build();

    const seen = await asBorrower(() =>
      access.along({ grantId: GRANT, source: 'tenant', gatewayId: GATEWAY }, async (owner) => ({
        owner,
        override: vaultTenantOverride(),
      })),
    );

    expect(seen.owner).toBe(LENDER);
    expect(seen.override).toEqual({ tenantId: LENDER, grantId: GRANT });
  });

  it('re-derives the owner and never takes one from the caller', async () => {
    const { access } = build({ configOwner: LENDER });

    // The caller has no way to say who the owner is: `along` takes the grant,
    // the source and the gateway, and nothing else.
    const owner = await asBorrower(() =>
      access.along({ grantId: GRANT, source: 'tenant', gatewayId: GATEWAY }, async (o) => o),
    );

    expect(owner).toBe(LENDER);
  });

  it('resolves a platform gateway to the platform owner tenant', async () => {
    const { access } = build({ grant: { gatewayId: GATEWAY, tenantGatewayConfigId: null } });

    const owner = await asBorrower(() =>
      access.along({ grantId: GRANT, source: 'platform', gatewayId: GATEWAY }, async (o) => o),
    );

    expect(owner).toBe(PLATFORM_OWNER);
  });

  it('refuses a grant this tenant does not hold', async () => {
    const { access, reads } = build({ grant: null });

    await expect(
      asBorrower(() => access.along({ grantId: GRANT, source: 'tenant', gatewayId: GATEWAY }, async () => 1)),
    ).rejects.toBeInstanceOf(GrantNotUsable);
    // Scoped to the caller and to a live grant, which is what makes the policy
    // the thing that refuses.
    expect(reads[0]).toMatchObject({ id: GRANT, tenantId: BORROWER, isActive: true });
  });

  it('refuses a live grant of a different gateway', async () => {
    const { access } = build({ grant: { gatewayId: null, tenantGatewayConfigId: OTHER_GATEWAY } });

    await expect(
      asBorrower(() => access.along({ grantId: GRANT, source: 'tenant', gatewayId: GATEWAY }, async () => 1)),
    ).rejects.toMatchObject({ reason: 'wrong_gateway' });
  });

  it('refuses a platform grant read as a tenant one, and the other way round', async () => {
    const platform = build({ grant: { gatewayId: GATEWAY, tenantGatewayConfigId: null } });
    await expect(
      asBorrower(() =>
        platform.access.along({ grantId: GRANT, source: 'tenant', gatewayId: GATEWAY }, async () => 1),
      ),
    ).rejects.toMatchObject({ reason: 'wrong_gateway' });

    const tenant = build();
    await expect(
      asBorrower(() =>
        tenant.access.along({ grantId: GRANT, source: 'platform', gatewayId: GATEWAY }, async () => 1),
      ),
    ).rejects.toMatchObject({ reason: 'wrong_gateway' });
  });

  it('refuses when the gateway has no owner to charge', async () => {
    const { access } = build({ configOwner: null });

    await expect(
      asBorrower(() => access.along({ grantId: GRANT, source: 'tenant', gatewayId: GATEWAY }, async () => 1)),
    ).rejects.toMatchObject({ reason: 'no_owner' });
  });

  it('shuts the override again, including when the call throws', async () => {
    const { access } = build();

    await expect(
      asBorrower(() =>
        access.along({ grantId: GRANT, source: 'tenant', gatewayId: GATEWAY }, async () => {
          throw new Error('the bank said no');
        }),
      ),
    ).rejects.toThrow('the bank said no');

    expect(vaultTenantOverride()).toBeNull();
  });

  it('leaves an ordinary read alone: nothing is open outside a grant', async () => {
    expect(vaultTenantOverride()).toBeNull();
  });
});
