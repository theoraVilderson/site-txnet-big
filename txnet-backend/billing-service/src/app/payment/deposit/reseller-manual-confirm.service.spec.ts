/**
 * A named reseller's payments to confirm (F-093-v): `ManualConfirmService`'s
 * queue for the reseller the **path** names, as F-066-w3 does for gateways.
 *
 * The reseller's owner is a user of the platform owner's tenant and holds no
 * `payment.confirm_manual`, so the ambient route shows them nothing of their
 * own shop. Here `ResellerAccess` admits them (or a seat holding the key),
 * opens the reseller's scope, and hands the service the reseller as the
 * actor's tenant — so its scope rule (a tenant's own users, on its own gateway
 * configs) applies unchanged. A refusal does no work.
 */
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';
import { TenantType } from '@prisma/client';

import type { ManualActor } from './manual-confirm.service';
import { ResellerManualConfirmRefused } from './manual-confirm.refusals';
import { ResellerManualConfirmService } from './reseller-manual-confirm.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '66666666-6666-4666-8666-666666666666';
const SEAT = '77777777-7777-4777-8777-777777777777';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[], ip: '10.0.0.9' };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[], ip: '10.0.0.9' };
const seat = (...permissions: string[]) => ({ userId: SEAT, tenantId: RESELLER, permissions, ip: '10.0.0.9' });

type Seen = { actor: ManualActor; scope: string | undefined; args: unknown[] };

function build() {
  const seen: Seen[] = [];
  const record =
    (answer: unknown) =>
    async (actor: ManualActor, ...args: unknown[]) => {
      seen.push({ actor, scope: TenantContext.currentOrNull()?.id, args });
      return answer;
    };
  const row = (id: string, tenantType: TenantType, ownerUserId: string | null) => ({
    id,
    slug: id.slice(0, 4),
    tenantType,
    ownerUserId,
    status: 'active',
    graceEndsAt: null,
    deletedAt: null,
  });
  const tenants: Record<string, ReturnType<typeof row>> = {
    [PLATFORM]: row(PLATFORM, TenantType.platform_owner, null),
    [RESELLER]: row(RESELLER, TenantType.reseller, OWNER_USER),
    [OTHER]: row(OTHER, TenantType.reseller, STRANGER),
  };
  const appPrisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  };
  const manual = {
    list: record([{ id: PAYMENT }]),
    inquire: record({ outcome: 'unsettled' }),
    confirm: record({ outcome: 'confirmed_manually' }),
    attachAuthority: record({ outcome: 'unsettled' }),
    reject: record({ outcome: 'rejected_manually' }),
  };
  return { seen, service: new ResellerManualConfirmService(new ResellerAccess(appPrisma as never), manual as never) };
}

describe("a named reseller's payments to confirm (F-093-v)", () => {
  it("runs every call as the reseller the path names, in that reseller's scope", async () => {
    const { service, seen } = build();

    await service.list(owner, RESELLER);
    await service.inquire(owner, RESELLER, PAYMENT);
    await service.confirm(owner, RESELLER, PAYMENT, { referenceId: 'ref-1', reason: 'seen in the bank' });
    await service.attachAuthority(owner, RESELLER, PAYMENT, 'A0001');
    await service.reject(owner, RESELLER, PAYMENT, { reason: 'never arrived', resubmit: false });

    expect(seen).toHaveLength(5);
    for (const call of seen) {
      // The reseller is the scope of the work; the caller is only its author.
      expect(call.actor).toEqual({ adminId: OWNER_USER, tenantId: RESELLER, ip: '10.0.0.9' });
      expect(call.scope).toBe(RESELLER);
    }
    expect(seen[1].args).toEqual([PAYMENT]);
  });

  it('admits a seat of that reseller holding the key, and refuses one without it', async () => {
    const { service, seen } = build();
    await service.list(seat('payment.confirm_manual'), RESELLER);
    expect(seen[0].actor.tenantId).toBe(RESELLER);
    await expect(service.list(seat('gateway.manage'), RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });
  });

  it('refuses a caller who may not act for that reseller, before any work', async () => {
    const { service, seen } = build();
    await expect(service.list(stranger, RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });
    await expect(service.confirm(stranger, RESELLER, PAYMENT, { referenceId: 'r', reason: 'xxxxx' })).rejects.toMatchObject({ reason: 'not_allowed' });
    // Its owner is not the owner of another reseller.
    await expect(service.list(owner, OTHER)).rejects.toMatchObject({ reason: 'not_allowed' });
    expect(seen).toHaveLength(0);
  });

  it('names a door refusal with its own type, so the controller can give it a status', async () => {
    const { service } = build();
    const refusal = await service.list(stranger, RESELLER).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ResellerManualConfirmRefused);
  });
});
