/**
 * Stopping a reseller's sending campaigns after its suspension, and resuming one
 * (F-018-q, F-018-x).
 *
 * What would break silently here, and nowhere else:
 *  - **a stop is a status, never a row.** Recipients stay `queued` and nothing
 *    is failed or deleted: the delivery run claims rows only of `sending`
 *    campaigns, so the status alone halts it at the next run's boundary. A stop
 *    that touched a recipient row would lose who was never reached;
 *  - **only that tenant's `sending` campaigns stop.** A draft, a completed
 *    campaign or another tenant's is left as it is, and a replay stops nothing;
 *  - **resume is `stopped -> sending` only, and not while the campaign's tenant
 *    is closed** — otherwise the platform owner reopens with one click the send
 *    it just stopped with the suspension;
 *  - **the heads-up is the platform owner's**, as the status change is;
 *  - **the owner's stop is the only way in** since F-018-w retired the outbox
 *    path: on the cross-tenant pool, refused to anyone else and for a tenant
 *    that does not exist, and audited only when it stopped something — a
 *    repeated click changes nothing.
 */
import { AdminAction, AuditTargetType, CampaignStatus, DeliveryStatus, NotificationChannel, TenantStatus, TenantType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { CampaignAdminService } from './campaign-admin.service';

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN,
    tenantId: TENANT,
    createdByAdminId: ADMIN,
    channel: NotificationChannel.sms,
    filterCriteria: {},
    messageBody: 'Hello',
    subject: null,
    sourceLang: null,
    status: CampaignStatus.stopped,
    sentCount: 660,
    failedCount: 0,
    createdAt: new Date('2026-09-17T10:00:00Z'),
    ...overrides,
  };
}

function pool(callerType: TenantType, campaignTenantStatus: TenantStatus = TenantStatus.active) {
  const client: Record<string, any> = {
    tenant: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === TENANT ? { tenantType: TenantType.reseller, status: campaignTenantStatus } : { tenantType: callerType, status: TenantStatus.active }),
      ),
    },
    notificationCampaign: {
      findUnique: vi.fn().mockResolvedValue(campaignRow()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(2),
    },
    notificationCampaignRecipient: {
      count: vi.fn().mockResolvedValue(340),
      updateMany: vi.fn(),
    },
    adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  client['$transaction'] = vi.fn((body: (tx: unknown) => unknown) => body({ ...client, $executeRaw: vi.fn() }));
  return client;
}

function adminService(callerType: TenantType, campaignTenantStatus?: TenantStatus) {
  const prisma = pool(callerType, campaignTenantStatus);
  const all = pool(callerType, campaignTenantStatus);
  return { prisma, all, service: new CampaignAdminService(prisma as never, all as never, {} as never) };
}

const owner = { adminId: ADMIN, tenantId: OWNER_TENANT };
const reseller = { adminId: ADMIN, tenantId: TENANT };

describe('CampaignAdminService.resume', () => {
  it('moves a stopped campaign back to sending, audited, and settles one with nothing left queued', async () => {
    const { all, prisma, service } = adminService(TenantType.platform_owner);
    all.notificationCampaign.findUnique.mockResolvedValueOnce(campaignRow()).mockResolvedValueOnce(campaignRow({ status: CampaignStatus.sending }));

    const view = await runWithTenant({ id: OWNER_TENANT }, () => service.resume(owner, CAMPAIGN, '10.0.0.1'));

    expect(all.notificationCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN, status: CampaignStatus.stopped },
      data: { status: CampaignStatus.sending, stoppedAt: null },
    });
    expect(all.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: AdminAction.campaign_resume, targetEntityId: CAMPAIGN, oldValue: { status: CampaignStatus.stopped } }),
    });
    expect(all.notificationCampaignRecipient.count).toHaveBeenCalledWith({ where: { campaignId: CAMPAIGN, deliveryStatus: DeliveryStatus.queued } });
    expect(view.status).toBe(CampaignStatus.sending);
    expect(prisma.notificationCampaign.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a campaign that is not stopped', async () => {
    const { all, service } = adminService(TenantType.platform_owner);
    all.notificationCampaign.findUnique.mockResolvedValue(campaignRow({ status: CampaignStatus.completed }));
    await expect(runWithTenant({ id: OWNER_TENANT }, () => service.resume(owner, CAMPAIGN, 'ip'))).rejects.toMatchObject({ reason: 'campaign_not_stopped' });
    expect(all.notificationCampaign.updateMany).not.toHaveBeenCalled();
    expect(all.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it.each([TenantStatus.suspended, TenantStatus.terminated])('refuses while the campaign tenant is %s', async (status) => {
    const { all, service } = adminService(TenantType.platform_owner, status);
    await expect(runWithTenant({ id: OWNER_TENANT }, () => service.resume(owner, CAMPAIGN, 'ip'))).rejects.toMatchObject({ reason: 'tenant_not_open' });
    expect(all.notificationCampaign.updateMany).not.toHaveBeenCalled();
  });
});

describe('CampaignAdminService.sendingSummary', () => {
  it("counts a reseller's sending campaigns, the rows still queued and the fan-outs not finished", async () => {
    const { all, service } = adminService(TenantType.platform_owner);
    all.notificationCampaign.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    await expect(runWithTenant({ id: OWNER_TENANT }, () => service.sendingSummary(owner, TENANT))).resolves.toEqual({
      tenantId: TENANT,
      campaigns: 2,
      recipientsQueued: 340,
      campaignsStillFanningOut: 1,
    });
    expect(all.notificationCampaignRecipient.count).toHaveBeenCalledWith({
      where: { deliveryStatus: DeliveryStatus.queued, campaign: { tenantId: TENANT, status: CampaignStatus.sending } },
    });
  });

  it('is the platform owner\'s alone', async () => {
    const { all, prisma, service } = adminService(TenantType.reseller);
    await expect(runWithTenant({ id: TENANT }, () => service.sendingSummary(reseller, TENANT))).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(all.notificationCampaign.count).not.toHaveBeenCalled();
    expect(prisma.notificationCampaign.count).not.toHaveBeenCalled();
  });
});

describe('CampaignAdminService.stopTenant', () => {
  it("stops that tenant's sending campaigns on the cross-tenant pool, audited against the tenant", async () => {
    const { all, prisma, service } = adminService(TenantType.platform_owner);
    all.notificationCampaign.updateMany.mockResolvedValue({ count: 2 });

    await expect(runWithTenant({ id: OWNER_TENANT }, () => service.stopTenant(owner, TENANT, '10.0.0.1'))).resolves.toEqual({ stopped: 2 });

    expect(all.notificationCampaign.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, status: CampaignStatus.sending },
      data: { status: CampaignStatus.stopped, stoppedAt: expect.any(Date) },
    });
    expect(all.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        adminId: ADMIN,
        action: AdminAction.campaign_stop,
        targetEntityType: AuditTargetType.tenant,
        targetEntityId: TENANT,
        newValue: { stopped: 2 },
        adminIpAddress: '10.0.0.1',
      }),
    });
    expect(all.notificationCampaignRecipient.updateMany).not.toHaveBeenCalled();
    expect(prisma.notificationCampaign.updateMany).not.toHaveBeenCalled();
  });

  it('writes no audit row when nothing was sending', async () => {
    const { all, service } = adminService(TenantType.platform_owner);
    all.notificationCampaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(runWithTenant({ id: OWNER_TENANT }, () => service.stopTenant(owner, TENANT, 'ip'))).resolves.toEqual({ stopped: 0 });
    expect(all.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it("is the platform owner's alone", async () => {
    const { all, prisma, service } = adminService(TenantType.reseller);
    await expect(runWithTenant({ id: TENANT }, () => service.stopTenant(reseller, TENANT, 'ip'))).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(all.notificationCampaign.updateMany).not.toHaveBeenCalled();
    expect(prisma.notificationCampaign.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a tenant that does not exist', async () => {
    const { all, service } = adminService(TenantType.platform_owner);
    const missing = '66666666-6666-4666-8666-666666666666';
    all.tenant.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === missing ? null : { tenantType: TenantType.platform_owner, status: TenantStatus.active }),
    );
    await expect(runWithTenant({ id: OWNER_TENANT }, () => service.stopTenant(owner, missing, 'ip'))).rejects.toMatchObject({ reason: 'tenant_not_found' });
    expect(all.notificationCampaign.updateMany).not.toHaveBeenCalled();
  });
});
