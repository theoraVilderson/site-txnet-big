import { Injectable } from '@nestjs/common';
import { CampaignStatus, NotificationChannel, Prisma, TenantType } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AudienceFilter } from './campaign-admin.schema';

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;

/** From the gate: who is asking, and for which tenant. */
export type CampaignActor = { adminId: string; tenantId: string };

export type CreateCampaignInput = {
  channel: NotificationChannel;
  messageBody: string;
  audience: AudienceFilter;
  /** Absent = the caller's tenant; `null` = platform-wide; another id = the platform owner's alone. */
  tenantId?: string | null;
};

export type UpdateCampaignInput = {
  channel?: NotificationChannel;
  messageBody?: string;
  audience?: AudienceFilter;
};

export type CampaignListFilter = {
  page?: number;
  pageSize?: number;
  status?: CampaignStatus;
  tenantId?: string;
};

export type CampaignView = {
  id: string;
  /** `null` = platform-wide. */
  tenantId: string | null;
  createdByAdminId: string;
  channel: NotificationChannel;
  audience: AudienceFilter;
  messageBody: string;
  status: CampaignStatus;
  sentCount: number;
  failedCount: number;
  createdAt: string;
};

export type CampaignAdminRejection = 'not_platform_owner' | 'tenant_not_found' | 'campaign_not_found' | 'campaign_not_draft';

export class CampaignAdminRefused extends Error {
  constructor(readonly reason: CampaignAdminRejection, detail: string) {
    super(`${reason}: ${detail}`);
  }
}

type CampaignRow = {
  id: string;
  tenantId: string | null;
  createdByAdminId: string;
  channel: NotificationChannel;
  filterCriteria: Prisma.JsonValue;
  messageBody: string;
  status: CampaignStatus;
  sentCount: number;
  failedCount: number;
  createdAt: Date;
};

/**
 * Drafting broadcast campaigns (F-035-c): create, list, read and edit
 * `notification_campaign` rows while they are `draft`. Sending them is the
 * fan-out's (F-035-d).
 *
 * **Who may touch what** — billing's coupon rule (ADR-0048 decision 8): the
 * platform owner, platform-wide campaigns and every tenant's; any other tenant,
 * its own. A campaign outside a caller's reach is `campaign_not_found`, so the
 * answer never confirms another tenant's id exists.
 *
 * **Why the cross-tenant pool, and what that costs.** `notification_campaign`
 * is RLS shape B: a tenant may read the platform's rows and `WITH CHECK` writes
 * only its own — so no tenant's connection, the owner's included, can write a
 * platform-wide row. Every campaign read and write is therefore on
 * {@link CrossTenantPrismaService}, and **this file is the boundary**: the
 * tenant filter below is the isolation, with no policy behind it (invariant 7).
 * The app pool is used for one read, the caller's own tenant type.
 */
@Injectable()
export class CampaignAdminService {
  constructor(
    /** The caller's tenant row: who is asking. */
    private readonly prisma: PrismaService,
    /** Every tenant's campaign rows, by policy. See the class comment. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  async create(actor: CampaignActor, input: CreateCampaignInput): Promise<CampaignView> {
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    const row = await this.all.notificationCampaign.create({
      data: {
        tenantId,
        createdByAdminId: actor.adminId,
        channel: input.channel,
        messageBody: input.messageBody,
        filterCriteria: input.audience as Prisma.InputJsonObject,
        status: CampaignStatus.draft,
      },
    });
    return toView(row);
  }

  async list(actor: CampaignActor, filter: CampaignListFilter) {
    const page = filter.page ?? DEFAULT_PAGE;
    const pageSize = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.NotificationCampaignWhereInput = {};

    if (await this.isOwner(actor)) {
      if (filter.tenantId !== undefined) where.tenantId = filter.tenantId === 'platform' ? null : filter.tenantId;
    } else {
      // Not the `NULL OR mine` the policy would allow: a tenant admin manages
      // their tenant's campaigns, and the platform's are not theirs to see.
      where.tenantId = actor.tenantId;
    }
    if (filter.status) where.status = filter.status;

    const [rows, total] = await this.all.$transaction([
      this.all.notificationCampaign.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.all.notificationCampaign.count({ where }),
    ]);
    return { items: rows.map(toView), page, pageSize, total };
  }

  async get(actor: CampaignActor, id: string): Promise<CampaignView> {
    return toView(await this.loadManaged(actor, id));
  }

  async update(actor: CampaignActor, id: string, patch: UpdateCampaignInput): Promise<CampaignView> {
    await this.loadManaged(actor, id);

    const data: Prisma.NotificationCampaignUpdateManyMutationInput = {};
    if (patch.channel !== undefined) data.channel = patch.channel;
    if (patch.messageBody !== undefined) data.messageBody = patch.messageBody;
    if (patch.audience !== undefined) data.filterCriteria = patch.audience as Prisma.InputJsonObject;

    // `status` is in the write's own `where`, not a check before it: a fan-out
    // starting between the read and the write must not see its audience change.
    const { count } = await this.all.notificationCampaign.updateMany({
      where: { id, status: CampaignStatus.draft },
      data,
    });
    if (count === 0) throw new CampaignAdminRefused('campaign_not_draft', id);
    return this.get(actor, id);
  }

  private async isOwner(actor: CampaignActor): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    return tenant?.tenantType === TenantType.platform_owner;
  }

  private async ownerOfNew(actor: CampaignActor, requested: string | null | undefined): Promise<string | null> {
    const tenantId = requested === undefined ? actor.tenantId : requested;
    if (tenantId === actor.tenantId) return tenantId;
    if (!(await this.isOwner(actor))) {
      throw new CampaignAdminRefused('not_platform_owner', tenantId === null ? 'a platform-wide campaign' : "another tenant's campaign");
    }
    if (tenantId !== null && !(await this.all.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      throw new CampaignAdminRefused('tenant_not_found', tenantId);
    }
    return tenantId;
  }

  private async loadManaged(actor: CampaignActor, id: string): Promise<CampaignRow> {
    const row = await this.all.notificationCampaign.findUnique({ where: { id } });
    if (!row) throw new CampaignAdminRefused('campaign_not_found', id);
    if (row.tenantId !== actor.tenantId && !(await this.isOwner(actor))) {
      throw new CampaignAdminRefused('campaign_not_found', id);
    }
    return row;
  }
}

function toView(row: CampaignRow): CampaignView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    createdByAdminId: row.createdByAdminId,
    channel: row.channel,
    // Written only through `audienceFilterSchema`; F-035-d parses it again before it trusts it.
    audience: row.filterCriteria as AudienceFilter,
    messageBody: row.messageBody,
    status: row.status,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    createdAt: row.createdAt.toISOString(),
  };
}
