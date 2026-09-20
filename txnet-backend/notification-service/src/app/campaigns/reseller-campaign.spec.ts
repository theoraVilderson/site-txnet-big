/**
 * A reseller's own campaigns (F-313-d, spec F-313): `notification-service`'s
 * campaign routes reached for the reseller the **path** names, so a reseller
 * can draft, size and start a broadcast to its own users.
 *
 * There is one rule, and every case below is a way it breaks silently:
 * **the reseller is the path's, and the scope is the whole filter.**
 * `ResellerAccess` (tenant invariant 21) says whether this caller may act for
 * that reseller, opens its tenant scope, and only then is anything asked or
 * written. `notificationCampaign` and `user` are both in `TENANT_SCOPED_MODELS`,
 * so inside that scope a query that names no tenant is already the reseller's.
 * The ways it goes wrong are all quiet:
 *
 *  - **a refusal reads and writes nothing.** `admit` throws before the work
 *    starts, so a stranger never reaches a campaign row or a user count;
 *  - **the reseller is never the session's tenant.** Its owner signs in to the
 *    *platform owner's* tenant (ADR-0059 (6), F-061-i), so a campaign drafted
 *    from the ambient `X-Tenant-Id` would go to the platform's own users —
 *    every user of every tenant — under the reseller's name. This is the whole
 *    reason the row exists and `campaign-admin.service.ts` could not serve it;
 *  - **the count is the fan-out's own query, not a second one.** The number a
 *    reseller confirms and the number `audienceWhere` then writes rows for must
 *    come from one function, or the confirmation is of a different audience;
 *  - **a suspended reseller reads and does not write.** Listing is `read` and
 *    drafting and sending are `staffWrite`, so the status matrix decides, not
 *    this surface;
 *  - **the admin door is not reused with the session's actor.** The delegated
 *    actor names the reseller, which is what makes the campaign, its audit row
 *    and its pool the reseller's.
 */
import { CampaignStatus, NotificationChannel } from '@prisma/client';
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { audienceWhere } from './campaign-fan-out.service';
import { ResellerCampaignRefused, ResellerCampaignService } from './reseller-campaign.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';

/** The reseller's owner, signed in to the platform owner's tenant — ADR-0059 (6). */
const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };

const AUDIENCE = { languages: ['fa'] as never, minBalance: '10.00' };

/** What a call saw: its arguments, and the tenant in scope when it ran. */
type Seen = { what: string; args: any[]; scope: string | undefined };

function build(options: { status?: string; userCount?: number } = {}) {
  const seen: Seen[] = [];
  const record =
    (what: string, answer: unknown) =>
    async (...args: unknown[]) => {
      seen.push({ what, args, scope: TenantContext.currentOrNull()?.id });
      return answer;
    };

  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: options.status ?? 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);

  const prisma = {
    user: { count: record('user.count', options.userCount ?? 0) },
  };

  /** The admin service, as this surface uses it: one call, one delegated actor. */
  const admin = {
    create: record('admin.create', { id: 'c1', tenantId: RESELLER, status: CampaignStatus.draft }),
    list: record('admin.list', { items: [], page: 1, pageSize: 20, total: 0 }),
    get: record('admin.get', { id: 'c1', tenantId: RESELLER, status: CampaignStatus.draft }),
    send: record('admin.send', { id: 'c1', tenantId: RESELLER, status: CampaignStatus.sending }),
  };

  const service = new ResellerCampaignService(prisma as never, access, admin as never);
  return { service, seen, admin };
}

describe('a reseller acts on its own campaigns (F-313-d)', () => {
  it('refuses a stranger before anything is read or written', async () => {
    const { service, seen } = build();
    await expect(service.list(stranger, RESELLER, {})).rejects.toBeInstanceOf(ResellerCampaignRefused);
    await expect(
      service.create(stranger, RESELLER, { channel: NotificationChannel.telegram_bot, messageBody: 'hi', audience: {} } as never),
    ).rejects.toBeInstanceOf(ResellerCampaignRefused);
    await expect(service.audienceCount(stranger, RESELLER, {})).rejects.toBeInstanceOf(ResellerCampaignRefused);
    expect(seen).toEqual([]);
  });

  it('drafts for the reseller the path names, in its scope — never the session tenant', async () => {
    const { service, seen } = build();
    await service.create(owner, RESELLER, {
      channel: NotificationChannel.telegram_bot,
      messageBody: 'hi',
      audience: AUDIENCE,
    } as never);

    const call = seen.find((s) => s.what === 'admin.create');
    expect(call?.scope).toBe(RESELLER);
    // The delegated actor: the reseller, not `owner.tenantId` (the platform's).
    expect(call?.args[0]).toEqual({ adminId: OWNER_USER, tenantId: RESELLER });
    expect(owner.tenantId).toBe(PLATFORM);
    // The scope is fixed by the path, so no body ever names it.
    expect(call?.args[1].tenantId).toBeUndefined();
  });

  it('counts the audience with the fan-out\'s own query, in the reseller\'s scope', async () => {
    const { service, seen } = build({ userCount: 42 });
    const at = new Date('2026-09-20T00:00:00.000Z');

    expect(await service.audienceCount(owner, RESELLER, AUDIENCE as never, at)).toEqual({ count: 42 });

    const call = seen.find((s) => s.what === 'user.count');
    expect(call?.scope).toBe(RESELLER);
    // The same function the fan-out writes rows with (F-035-d), so the number
    // the reseller confirms is the number that will be sent to.
    expect(call?.args[0].where).toEqual(audienceWhere({ tenantId: RESELLER, sendStartedAt: at }, AUDIENCE as never));
  });

  it('lists and sends through the admin door, each in the reseller\'s scope', async () => {
    const { service, seen } = build();
    await service.list(owner, RESELLER, { status: CampaignStatus.sending });
    await service.send(owner, RESELLER, 'c1', '10.0.0.1');

    for (const what of ['admin.list', 'admin.send']) {
      const call = seen.find((s) => s.what === what);
      expect(call?.scope).toBe(RESELLER);
      expect(call?.args[0]).toEqual({ adminId: OWNER_USER, tenantId: RESELLER });
    }
  });

  it('lets a suspended reseller read its campaigns and refuses the writes', async () => {
    const { service, seen } = build({ status: 'suspended' });

    await service.list(owner, RESELLER, {});
    expect(await service.audienceCount(owner, RESELLER, {})).toEqual({ count: 0 });

    await expect(
      service.create(owner, RESELLER, { channel: NotificationChannel.telegram_bot, messageBody: 'hi', audience: {} } as never),
    ).rejects.toMatchObject({ reason: 'reseller_suspended' });
    await expect(service.send(owner, RESELLER, 'c1', '10.0.0.1')).rejects.toMatchObject({ reason: 'reseller_suspended' });

    expect(seen.map((s) => s.what)).toEqual(['admin.list', 'user.count']);
  });

  it('closes a terminated reseller to its owner entirely', async () => {
    const { service, seen } = build({ status: 'terminated' });
    await expect(service.list(owner, RESELLER, {})).rejects.toMatchObject({ reason: 'reseller_terminated' });
    expect(seen).toEqual([]);
  });
});
