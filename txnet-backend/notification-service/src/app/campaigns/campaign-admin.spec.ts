/**
 * Drafting a campaign (F-035-c).
 *
 * What would break silently here, and nowhere else:
 *  - **the audience is a closed shape, not a query language.** `filterCriteria`
 *    is `Json`, so the column takes anything; the fan-out (F-035-d) translates
 *    only the keys `audienceFilterSchema` names. An unknown key accepted here
 *    would be stored, ignored by the worker, and widen the audience to everyone
 *    — so it is refused, as are an empty range and a float balance (C-02);
 *  - **which pool serves the caller (ADR-0053).** A tenant admin is served on
 *    the app pool, where `withTenant` and RLS both hold them to their tenant;
 *    only the platform owner reaches the cross-tenant pool. A reseller's request
 *    that touched that pool would lose the database's half of the isolation
 *    with every other test here still green — so each reseller case asserts the
 *    pool was never touched (invariant 7). Another tenant's id is
 *    `campaign_not_found`, not 403;
 *  - **only a draft is edited.** Once the fan-out has started the stored
 *    audience is what recipients were chosen by.
 */
import { CampaignStatus, NotificationChannel, TenantType, UserStatus } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { audienceFilterSchema } from './campaign-admin.schema';
import { CampaignAdminRefused, CampaignAdminService } from './campaign-admin.service';

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN,
    tenantId: TENANT,
    createdByAdminId: ADMIN,
    channel: NotificationChannel.telegram_bot,
    filterCriteria: {},
    messageBody: 'Hello',
    status: CampaignStatus.draft,
    sentCount: 0,
    failedCount: 0,
    createdAt: new Date('2026-09-17T10:00:00Z'),
    ...overrides,
  };
}

function campaignDelegate() {
  return {
    create: vi.fn().mockImplementation(({ data }) => Promise.resolve(campaignRow(data))),
    findUnique: vi.fn().mockResolvedValue(campaignRow()),
    findMany: vi.fn().mockResolvedValue([campaignRow()]),
    count: vi.fn().mockResolvedValue(1),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
}

/** A `$transaction` that runs a batch or an interactive body the way Prisma does, minus the database. */
function transactionOf(client: Record<string, unknown>) {
  return vi.fn((arg: unknown) =>
    typeof arg === 'function' ? arg({ ...client, $executeRaw: vi.fn() }) : Promise.all(arg as Promise<unknown>[]),
  );
}

function fakes(callerType: TenantType = TenantType.reseller) {
  const prisma: Record<string, unknown> & { notificationCampaign: ReturnType<typeof campaignDelegate>; adminAuditLog: { create: ReturnType<typeof vi.fn> } } = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ tenantType: callerType }) },
    notificationCampaign: campaignDelegate(),
    adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  prisma['$transaction'] = transactionOf(prisma);
  const all: Record<string, unknown> & { notificationCampaign: ReturnType<typeof campaignDelegate>; adminAuditLog: { create: ReturnType<typeof vi.fn> } } = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: OTHER_TENANT }) },
    notificationCampaign: campaignDelegate(),
    adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  all['$transaction'] = transactionOf(all);
  return { prisma, all, service: new CampaignAdminService(prisma as never, all as never) };
}

/** Every call as a request makes it: inside the tenant scope `IdentityMiddleware` opens. */
const as = <T>(tenantId: string, run: () => Promise<T>) => runWithTenant({ id: tenantId }, run);

function expectPoolUntouched(pool: { notificationCampaign: ReturnType<typeof campaignDelegate> }) {
  for (const fn of Object.values(pool.notificationCampaign)) expect(fn).not.toHaveBeenCalled();
}

const tenantAdmin = { adminId: ADMIN, tenantId: TENANT };
const owner = { adminId: ADMIN, tenantId: OWNER_TENANT };

describe('audienceFilterSchema', () => {
  it('accepts the fixed keys and an empty filter', () => {
    expect(audienceFilterSchema.safeParse({}).success).toBe(true);
    const parsed = audienceFilterSchema.safeParse({
      statuses: [UserStatus.active],
      languages: ['fa'],
      registeredFrom: '2026-01-01T00:00:00Z',
      registeredTo: '2026-06-01T00:00:00Z',
      minBalance: '0',
      maxBalance: '150000.50',
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['an unknown key, which the worker would ignore and so widen the audience', { lastConfigDays: { gt: 30 } }],
    ['a raw query operator', { minBalance: { gt: '0' } }],
    ['a float balance (C-02)', { minBalance: 10.5 }],
    ['more than two decimals', { minBalance: '1.005' }],
    ['a negative balance', { minBalance: '-1' }],
    ['min above max', { minBalance: '20', maxBalance: '10' }],
    ['from after to', { registeredFrom: '2026-06-01T00:00:00Z', registeredTo: '2026-01-01T00:00:00Z' }],
    ['a status outside the enum', { statuses: ['deleted'] }],
    ['an empty list, which would read as "nobody" or "everybody"', { languages: [] }],
    ['a repeated value', { statuses: ['active', 'active'] }],
  ])('refuses %s', (_why, filter) => {
    expect(audienceFilterSchema.safeParse(filter).success).toBe(false);
  });
});

describe('CampaignAdminService', () => {
  it('drafts a tenant admin\'s campaign in their own tenant, with the parsed audience and no counts', async () => {
    const { prisma, all, service } = fakes();

    const view = await as(TENANT, () =>
      service.create(tenantAdmin, {
        channel: NotificationChannel.telegram_bot,
        messageBody: 'Hello',
        audience: { languages: ['fa'] },
      }),
    );

    expectPoolUntouched(all);
    expect(prisma.notificationCampaign.create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        createdByAdminId: ADMIN,
        channel: NotificationChannel.telegram_bot,
        messageBody: 'Hello',
        filterCriteria: { languages: ['fa'] },
        status: CampaignStatus.draft,
      },
    });
    expect(view).toMatchObject({ id: CAMPAIGN, tenantId: TENANT, status: 'draft', audience: { languages: ['fa'] } });
  });

  it.each([
    ['a platform-wide campaign', null],
    ['another tenant\'s campaign', OTHER_TENANT],
  ])('refuses a tenant admin %s', async (_why, tenantId) => {
    const { prisma, all, service } = fakes();
    await expect(
      as(TENANT, () => service.create(tenantAdmin, { channel: NotificationChannel.sms, messageBody: 'x', audience: {}, tenantId })),
    ).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(prisma.notificationCampaign.create).not.toHaveBeenCalled();
    expectPoolUntouched(all);
  });

  it('serves the platform owner on the cross-tenant pool, where a platform-wide row can be written', async () => {
    const { prisma, all, service } = fakes(TenantType.platform_owner);
    await as(OWNER_TENANT, () =>
      service.create(owner, { channel: NotificationChannel.sms, messageBody: 'x', audience: {}, tenantId: null }),
    );
    expect(all.notificationCampaign.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: null }) });
    expectPoolUntouched(prisma);
  });

  it('lists only the tenant admin\'s own tenant, whatever tenant they ask for', async () => {
    const { prisma, all, service } = fakes();
    await as(TENANT, () => service.list(tenantAdmin, { tenantId: OTHER_TENANT }));
    const where = { tenantId: TENANT };
    expect(prisma.notificationCampaign.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(prisma.notificationCampaign.count).toHaveBeenCalledWith({ where });
    expectPoolUntouched(all);
  });

  it('answers another tenant\'s campaign as not found', async () => {
    const { prisma, all, service } = fakes();
    // On the app pool `withTenant` adds the tenant to the `where`, so another
    // tenant's row is no row; the service's own check is the second answer.
    prisma.notificationCampaign.findUnique.mockResolvedValue(null);
    await expect(as(TENANT, () => service.get(tenantAdmin, CAMPAIGN))).rejects.toMatchObject({ reason: 'campaign_not_found' });
    prisma.notificationCampaign.findUnique.mockResolvedValue(campaignRow({ tenantId: null }));
    await expect(as(TENANT, () => service.get(tenantAdmin, CAMPAIGN))).rejects.toBeInstanceOf(CampaignAdminRefused);
    expectPoolUntouched(all);
  });

  it('edits only while the row is still a draft, checked in the write itself', async () => {
    const { prisma, all, service } = fakes();
    await as(TENANT, () => service.update(tenantAdmin, CAMPAIGN, { messageBody: 'New' }));
    expect(prisma.notificationCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN, status: CampaignStatus.draft },
      data: { messageBody: 'New' },
    });

    prisma.notificationCampaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(as(TENANT, () => service.update(tenantAdmin, CAMPAIGN, { messageBody: 'Late' }))).rejects.toMatchObject({
      reason: 'campaign_not_draft',
    });
    expectPoolUntouched(all);
  });

  it('starts a send once: draft -> sending in the write\'s own where, audited in the same transaction (F-035-d)', async () => {
    const { prisma, all, service } = fakes();
    await as(TENANT, () => service.send(tenantAdmin, CAMPAIGN, '10.0.0.1'));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.notificationCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN, status: CampaignStatus.draft },
      data: { status: CampaignStatus.sending, sendStartedAt: expect.any(Date) },
    });
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        adminId: ADMIN,
        action: 'campaign_send',
        targetEntityType: 'notification_campaign',
        targetEntityId: CAMPAIGN,
        adminIpAddress: '10.0.0.1',
      }),
    });
    expectPoolUntouched(all);

    prisma.notificationCampaign.updateMany.mockResolvedValue({ count: 0 });
    prisma.adminAuditLog.create.mockClear();
    await expect(as(TENANT, () => service.send(tenantAdmin, CAMPAIGN, '10.0.0.1'))).rejects.toMatchObject({
      reason: 'campaign_not_draft',
    });
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('never lets a tenant admin send the platform\'s campaign', async () => {
    const { prisma, all, service } = fakes();
    prisma.notificationCampaign.findUnique.mockResolvedValue(campaignRow({ tenantId: null }));
    await expect(as(TENANT, () => service.send(tenantAdmin, CAMPAIGN, '10.0.0.1'))).rejects.toMatchObject({
      reason: 'campaign_not_found',
    });
    expect(prisma.notificationCampaign.updateMany).not.toHaveBeenCalled();
    expectPoolUntouched(all);
  });
});
