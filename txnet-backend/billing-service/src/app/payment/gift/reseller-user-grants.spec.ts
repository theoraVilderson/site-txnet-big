/**
 * An admin reads one user's services (F-311-f, spec F-311): the user's Grants,
 * one Grant's configs, its 30-day usage and its `/sub` link — for the reseller
 * the **path** names, and only for that reseller's own users (C-15).
 *
 * The four reads are the owner's own (F-502-r, F-027-ac, F-307-b, F-114-e-b),
 * unchanged; what this surface adds is the door and the scope, and each case
 * below is a way that breaks quietly:
 *
 *  - **a refusal reads nothing.** `ResellerAccess` throws before any read, so
 *    a stranger never learns whether a user or a Grant exists;
 *  - **the reseller is the path's, never the session's.** Its owner signs in to
 *    the platform's tenant (ADR-0059); every read runs in the reseller's scope;
 *  - **the user must be the reseller's.** A user of another tenant is
 *    `user_not_found` — decided in the reseller's scope, where RLS and
 *    `TENANT_SCOPED_MODELS` hide every other tenant's user — before any Grant
 *    is read for them;
 *  - **the owner reads are asked as that user.** Their own ownership check
 *    (`grantId` + `userId`) is what keeps a Grant of another user of the same
 *    reseller out, so the path's user is passed, never the caller.
 */
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const FOREIGN_CUSTOMER = '77777777-7777-4777-8777-777777777777';
const GRANT = '88888888-8888-4888-8888-888888888888';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };

/** What a read saw: which one, the user and Grant it was asked for, and the tenant in scope. */
type Seen = { what: string; userId: string; grantId?: string; scope: string | undefined };

function build() {
  const seen: Seen[] = [];
  const scope = () => TenantContext.currentOrNull()?.id;

  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
    [OTHER]: { id: OTHER, slug: 'other', tenantType: 'reseller', ownerUserId: STRANGER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);

  // Whose user each id is. The fake answers as RLS does: a user is found only
  // in its own tenant's scope, so an unscoped or wrongly-scoped read misses.
  const userTenant: Record<string, string> = { [CUSTOMER]: RESELLER, [FOREIGN_CUSTOMER]: OTHER };
  const tx = {
    $executeRaw: async () => 1,
    user: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        seen.push({ what: 'user', userId: where.id, scope: scope() });
        return userTenant[where.id] === scope() ? { id: where.id } : null;
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };

  const grants = {
    listForUser: async (userId: string, query: unknown) => {
      seen.push({ what: 'grants', userId, scope: scope() });
      return { total: 0, page: 1, pageSize: 20, hidden: 0, rows: [], query };
    },
  };
  const configs = {
    listForGrant: async (userId: string, grantId: string) => {
      seen.push({ what: 'configs', userId, grantId, scope: scope() });
      return [];
    },
  };
  const usage = {
    dailyForGrant: async (userId: string, grantId: string) => {
      seen.push({ what: 'usage', userId, grantId, scope: scope() });
      return { from: '2026-08-28', to: '2026-09-26', days: [] };
    },
  };
  const links = {
    linkFor: async (grantId: string, userId: string) => {
      seen.push({ what: 'link', userId, grantId, scope: scope() });
      return `https://sub.acme.example/sub/token`;
    },
  };

  const service = new ResellerUserGrantsService(prisma as never, access, grants as never, configs as never, usage as never, links as never, {} as never);
  return { seen, service };
}

describe('ResellerUserGrantsService', () => {
  it('reads each of the four as the path\'s user, inside the reseller\'s scope, after checking the user is its own', async () => {
    const { seen, service } = build();

    await service.grants(owner, RESELLER, CUSTOMER, { scope: 'all' });
    await service.configs(owner, RESELLER, CUSTOMER, GRANT);
    await service.usage(owner, RESELLER, CUSTOMER, GRANT);
    const link = await service.subscriptionLink(owner, RESELLER, CUSTOMER, GRANT);

    expect(link).toBe('https://sub.acme.example/sub/token');
    expect(seen.map((s) => s.what)).toEqual(['user', 'grants', 'user', 'configs', 'user', 'usage', 'user', 'link']);
    for (const call of seen) {
      // Never the caller: the owner reads' own ownership check is the user's.
      expect(call.userId).toBe(CUSTOMER);
      // Never the session's platform tenant.
      expect(call.scope).toBe(RESELLER);
    }
    expect(seen.filter((s) => s.grantId).every((s) => s.grantId === GRANT)).toBe(true);
  });

  it('passes the list query through untouched — paging and scope are the owner list\'s to decide', async () => {
    const { service } = build();
    const page = await service.grants(owner, RESELLER, CUSTOMER, { page: 2, pageSize: 10, scope: 'current', q: 'de' });
    expect((page as unknown as { query: unknown }).query).toEqual({ page: 2, pageSize: 10, scope: 'current', q: 'de' });
  });

  it('refuses a user of another tenant as user_not_found, and reads no Grant for them', async () => {
    const { seen, service } = build();

    for (const read of [
      () => service.grants(owner, RESELLER, FOREIGN_CUSTOMER, {}),
      () => service.configs(owner, RESELLER, FOREIGN_CUSTOMER, GRANT),
      () => service.usage(owner, RESELLER, FOREIGN_CUSTOMER, GRANT),
      () => service.subscriptionLink(owner, RESELLER, FOREIGN_CUSTOMER, GRANT),
    ]) {
      await expect(read()).rejects.toMatchObject({ reason: 'user_not_found' });
    }
    expect(seen.map((s) => s.what)).toEqual(['user', 'user', 'user', 'user']);
  });

  it('refuses a caller the door refuses, before any read — not even whether the user exists', async () => {
    const { seen, service } = build();

    const refused = service.configs(stranger, RESELLER, CUSTOMER, GRANT);
    await expect(refused).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    await expect(service.grants(stranger, RESELLER, CUSTOMER, {})).rejects.toMatchObject({ reason: 'not_allowed' });
    expect(seen).toEqual([]);
  });

  it('reads the reseller the path names, not the one the caller owns', async () => {
    const { seen, service } = build();
    // STRANGER owns OTHER; naming RESELLER in the path does not make its users theirs.
    await expect(service.usage(stranger, RESELLER, CUSTOMER, GRANT)).rejects.toMatchObject({ reason: 'not_allowed' });
    // And their own reseller does not hold RESELLER's user.
    await expect(service.usage(stranger, OTHER, CUSTOMER, GRANT)).rejects.toMatchObject({ reason: 'user_not_found' });
    expect(seen).toEqual([{ what: 'user', userId: CUSTOMER, scope: OTHER }]);
  });
});
