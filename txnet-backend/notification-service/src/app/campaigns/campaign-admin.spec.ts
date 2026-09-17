/**
 * Drafting a campaign (F-035-c).
 *
 * What would break silently here, and nowhere else:
 *  - **the audience is a closed shape, not a query language.** `filterCriteria`
 *    is `Json`, so the column takes anything; the fan-out (F-035-d) translates
 *    only the keys `audienceFilterSchema` names. An unknown key accepted here
 *    would be stored, ignored by the worker, and widen the audience to everyone
 *    — so it is refused, as are an empty range and a float balance (C-02);
 *  - **whose campaign.** Rows are read and written on the cross-tenant pool,
 *    because `notification_campaign`'s `WITH CHECK` refuses a platform row to
 *    every tenant's connection. RLS therefore stands behind none of this: a
 *    tenant admin's `where` naming their own tenant is the whole isolation
 *    (invariant 7), and another tenant's id is `campaign_not_found`, not 403;
 *  - **only a draft is edited.** Once the fan-out has started the stored
 *    audience is what recipients were chosen by.
 */
import { CampaignStatus, NotificationChannel, TenantType, UserStatus } from '@prisma/client';

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
    executedByBotWorkerId: null,
    createdAt: new Date('2026-09-17T10:00:00Z'),
    ...overrides,
  };
}

function fakes(callerType: TenantType = TenantType.reseller) {
  const prisma = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ tenantType: callerType }) },
  };
  const all = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: OTHER_TENANT }) },
    notificationCampaign: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(campaignRow(data))),
      findUnique: vi.fn().mockResolvedValue(campaignRow()),
      findMany: vi.fn().mockResolvedValue([campaignRow()]),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn((arg: unknown) => Promise.all(arg as Promise<unknown>[])),
  };
  return { prisma, all, service: new CampaignAdminService(prisma as never, all as never) };
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
    const { all, service } = fakes();

    const view = await service.create(tenantAdmin, {
      channel: NotificationChannel.telegram_bot,
      messageBody: 'Hello',
      audience: { languages: ['fa'] },
    });

    expect(all.notificationCampaign.create).toHaveBeenCalledWith({
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
    const { all, service } = fakes();
    await expect(
      service.create(tenantAdmin, { channel: NotificationChannel.sms, messageBody: 'x', audience: {}, tenantId }),
    ).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(all.notificationCampaign.create).not.toHaveBeenCalled();
  });

  it('lets the platform owner draft a platform-wide campaign', async () => {
    const { all, service } = fakes(TenantType.platform_owner);
    await service.create(owner, { channel: NotificationChannel.sms, messageBody: 'x', audience: {}, tenantId: null });
    expect(all.notificationCampaign.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: null }) });
  });

  it('lists only the tenant admin\'s own tenant, whatever tenant they ask for', async () => {
    const { all, service } = fakes();
    await service.list(tenantAdmin, { tenantId: OTHER_TENANT });
    const where = { tenantId: TENANT };
    expect(all.notificationCampaign.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(all.notificationCampaign.count).toHaveBeenCalledWith({ where });
  });

  it('answers another tenant\'s campaign as not found', async () => {
    const { all, service } = fakes();
    all.notificationCampaign.findUnique.mockResolvedValue(campaignRow({ tenantId: OTHER_TENANT }));
    await expect(service.get(tenantAdmin, CAMPAIGN)).rejects.toMatchObject({ reason: 'campaign_not_found' });
    all.notificationCampaign.findUnique.mockResolvedValue(campaignRow({ tenantId: null }));
    await expect(service.get(tenantAdmin, CAMPAIGN)).rejects.toBeInstanceOf(CampaignAdminRefused);
  });

  it('edits only while the row is still a draft, checked in the write itself', async () => {
    const { all, service } = fakes();
    await service.update(tenantAdmin, CAMPAIGN, { messageBody: 'New' });
    expect(all.notificationCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN, status: CampaignStatus.draft },
      data: { messageBody: 'New' },
    });

    all.notificationCampaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.update(tenantAdmin, CAMPAIGN, { messageBody: 'Late' })).rejects.toMatchObject({
      reason: 'campaign_not_draft',
    });
  });
});
