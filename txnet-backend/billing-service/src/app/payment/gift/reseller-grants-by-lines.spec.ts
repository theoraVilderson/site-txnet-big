/**
 * An admin finds a service by a pasted config line or `/sub` link across the
 * reseller's own users (F-311-t, spec F-307): support is handed a link, not a
 * phone number, so the user is not known yet — the paste is what names them.
 *
 * The matcher is the owner's (F-307-p, F-307-r), unchanged; what this adds is
 * the scope, and each case below is a way that breaks quietly:
 *
 *  - **the reseller's users, not one user.** The Grants and the configs a line
 *    is compared with are fenced by the reseller's `tenantId`, written into the
 *    query — never by a user, and never by RLS alone;
 *  - **each row says whose it is.** The admin opens the user from the answer,
 *    so a row carries its `userId` — and still never the token or its hash;
 *  - **a refusal reads nothing.** The door throws before any Grant is read,
 *    and the query runs in the path's reseller, never the session's platform;
 *  - **a POST body, the paste's bucket.** A line is a credential.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigStatus, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions, ResellerAccess, TenantContext, runWithTenant } from '@txnet-backend/shared-core';

import { GrantService, hashSubscriptionToken } from '../../entitlement/grant';
import { ResellerGrantsByLinesController } from './reseller-grants-by-lines.controller';
import { ResellerUserGrantsService } from './reseller-user-grants.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const GRANT = '88888888-8888-4888-8888-888888888888';
const CONFIG = '99999999-9999-4999-8999-999999999999';
const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };

const row = {
  id: GRANT,
  userId: CUSTOMER,
  status: GrantStatus.active,
  startsAt: new Date('2026-09-14T10:00:00Z'),
  endsAt: new Date('2026-10-14T10:00:00Z'),
  featureKeys: ['vpn.access'],
  variant: null,
  billingMode: VariantBillingMode.metered,
  consumedBytes: BigInt(0),
  purchasedBytes: BigInt(0),
  trafficUnlimited: false,
  quotas: {},
  suspendedAt: null,
  statusReason: null,
  frozenUntil: null,
  purgeAfterDays: null,
  usagePushedAt: null,
};

function build(stored: { id: string; uuid: string; linksUuid: string | null; linkLines: string[] }[] = []) {
  const asked: { where?: Prisma.GrantWhereInput; select?: unknown; configReads: Prisma.ConfigWhereInput[]; scopes: (string | undefined)[] } = {
    configReads: [],
    scopes: [],
  };
  const tx = {
    $executeRaw: async () => 1,
    config: {
      findMany: async (args: { where: Prisma.ConfigWhereInput }) => {
        asked.configReads.push(args.where);
        return stored;
      },
    },
    grant: {
      findMany: async (args: { where: Prisma.GrantWhereInput; select: unknown }) => {
        asked.where = args.where;
        asked.select = args.select;
        asked.scopes.push(TenantContext.currentOrNull()?.id);
        return [row];
      },
      count: async () => 1,
    },
    quotaAdjustment: { groupBy: async () => [] },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const grants = new GrantService(prisma as never);

  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);
  const service = new ResellerUserGrantsService(prisma as never, access, grants, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { asked, grants, service };
}

describe('GrantService.listByLinesInScope (F-311-t)', () => {
  it('fences a pasted uuid by the scope’s tenant, never by a user, and says whose each Grant is', async () => {
    const { asked, grants } = build();

    const page = await runWithTenant({ id: RESELLER }, () => grants.listByLinesInScope({ lines: [`vless://${UUID}@de1.example.com:443#Ali`] }));

    expect(asked.where?.tenantId).toBe(RESELLER);
    expect(asked.where?.userId).toBeUndefined();
    expect(asked.where?.configs).toEqual({ some: { status: { not: ConfigStatus.retired }, OR: [{ uuid: { in: [UUID], mode: 'insensitive' } }] } });
    expect(asked.where?.status).toEqual({ notIn: [GrantStatus.cancelled, GrantStatus.exhausted] });
    expect(page.rows.map((r) => [r.id, r.userId])).toEqual([[GRANT, CUSTOMER]]);
  });

  it('compares a line with no uuid against the tenant’s live configs, not one user’s', async () => {
    const line = 'ss://YWVzLTI1Ni1nY206cGFzcw@de1.example.com:8388';
    const { asked, grants } = build([{ id: CONFIG, uuid: UUID, linksUuid: UUID, linkLines: [`${line}#panel`] }]);

    await runWithTenant({ id: RESELLER }, () => grants.listByLinesInScope({ lines: [`${line}#Ali`], scope: 'all' }));

    expect(asked.configReads).toEqual([{ tenantId: RESELLER, status: { not: ConfigStatus.retired } }]);
    expect(asked.where).toEqual({ tenantId: RESELLER, configs: { some: { status: { not: ConfigStatus.retired }, OR: [{ id: { in: [CONFIG] } }] } } });
  });

  it('finds a subscription link by its token’s hash inside the tenant, and never answers the token or its hash', async () => {
    const token = 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6';
    const { asked, grants } = build();

    const page = await runWithTenant({ id: RESELLER }, () => grants.listByLinesInScope({ lines: [`https://sub.acme.example/sub/${token}`] }));

    expect(asked.where?.tenantId).toBe(RESELLER);
    expect(asked.where?.OR).toEqual([{ subscriptionTokenHash: { in: [hashSubscriptionToken(token)] } }]);
    expect(JSON.stringify(asked.select)).not.toContain('subscriptionToken');
    expect(JSON.stringify(page)).not.toContain('subscriptionToken');
  });
});

describe('ResellerUserGrantsService.findByLines (F-311-t)', () => {
  it('searches inside the reseller the path names, after the door admits the caller', async () => {
    const { asked, service } = build();

    const page = await service.findByLines(owner, RESELLER, { lines: [`trojan://${UUID}@h:443`] });

    expect(asked.scopes).toEqual([RESELLER]);
    expect(asked.where?.tenantId).toBe(RESELLER);
    expect(page.rows[0].userId).toBe(CUSTOMER);
  });

  it('refuses a caller the door refuses before any Grant is read', async () => {
    const { asked, service } = build();

    await expect(service.findByLines(stranger, RESELLER, { lines: [`trojan://${UUID}@h:443`] })).rejects.toMatchObject({ reason: 'not_allowed' });
    expect(asked.where).toBeUndefined();
    expect(asked.configReads).toEqual([]);
  });
});

describe('ResellerGrantsByLinesController', () => {
  it('is a POST under the reseller’s grants path, on the paste’s per-caller bucket', async () => {
    const handler = ResellerGrantsByLinesController.prototype.byLines;
    expect(Reflect.getMetadata(PATH_METADATA, ResellerGrantsByLinesController)).toBe('billing/tenants/:tenantId/grants');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('by-lines');
    const limit = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions;
    expect(limit.configKey).toBe('GRANTS_BY_LINES_RATE_LIMIT');
    const req = { identity: { userId: OWNER_USER, tenantId: PLATFORM, roleId: 'r', sessionId: 's', permissions: [] } };
    expect(limit.key(req as never)).toBe(`${RateLimitBucket.GRANTS_BY_LINES}:${OWNER_USER}`);

    const service = { findByLines: vi.fn(async () => ({ total: 0, page: 1, pageSize: 20, hidden: 0, rows: [] })) };
    await new ResellerGrantsByLinesController(service as never).byLines(RESELLER, { lines: ['ss://a@h:1'] }, req as never);
    expect(service.findByLines).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER_USER }), RESELLER, { lines: ['ss://a@h:1'] });
  });
});
