import { Injectable } from '@nestjs/common';
import { AdminAction, AuditTargetType, CampaignStatus, Language, NotificationChannel, Prisma, TenantType } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

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
  /** The email subject in `sourceLang`; absent or null = the translated default (F-035-h). */
  subject?: string | null;
  /** The language `messageBody` and `subject` are written in; absent or null = `DEFAULT_LANGUAGE`. */
  sourceLang?: Language | null;
  audience: AudienceFilter;
  /** Absent = the caller's tenant; `null` = platform-wide; another id = the platform owner's alone. */
  tenantId?: string | null;
};

export type UpdateCampaignInput = {
  channel?: NotificationChannel;
  messageBody?: string;
  subject?: string | null;
  sourceLang?: Language | null;
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
  subject: string | null;
  sourceLang: Language | null;
  status: CampaignStatus;
  sentCount: number;
  failedCount: number;
  createdAt: string;
};

export type CampaignAdminRejection =
  | 'not_platform_owner'
  | 'tenant_not_found'
  | 'campaign_not_found'
  | 'campaign_not_draft'
  | 'sms_not_available'
  | 'email_not_available'
  | 'text_is_source'
  | 'text_not_found';

export class CampaignAdminRefused extends Error {
  constructor(readonly reason: CampaignAdminRejection, detail: string) {
    super(`${reason}: ${detail}`);
  }
}

/** Either pool, as far as campaign rows and their texts go. */
export type CampaignDb = Pick<PrismaService, 'notificationCampaign' | 'notificationCampaignText'>;

type CampaignRow = {
  id: string;
  tenantId: string | null;
  createdByAdminId: string;
  channel: NotificationChannel;
  filterCriteria: Prisma.JsonValue;
  messageBody: string;
  subject: string | null;
  sourceLang: Language | null;
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
 * **The pool follows the caller (ADR-0053).** `notification_campaign` is RLS
 * shape B: a tenant's connection writes only its own rows, so a platform-wide
 * row — or the owner's draft for another tenant — cannot be written on it.
 * - a **tenant admin** is served on the app pool. `withTenant` adds their
 *   tenant to every query and RLS binds it, so the tenant filters below are the
 *   second guard, not the only one;
 * - the **platform owner** is served on {@link CrossTenantPrismaService}. The
 *   owner may manage every campaign, so the policy had nothing to withhold.
 *
 * {@link access} is the one place that decides, from the caller's own tenant
 * row, read on the app pool. `this.all` is otherwise named only on paths that
 * already hold `owner === true`.
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
    const { owner, db } = await this.access(actor);
    const tenantId = await this.ownerOfNew(actor, owner, input.tenantId);
    this.assertPlatformLine(input.channel, actor, owner, tenantId);
    const row = await db.notificationCampaign.create({
      data: {
        tenantId,
        createdByAdminId: actor.adminId,
        channel: input.channel,
        messageBody: input.messageBody,
        subject: input.subject ?? null,
        sourceLang: input.sourceLang ?? null,
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
    const { owner, db } = await this.access(actor);

    if (owner) {
      if (filter.tenantId !== undefined) where.tenantId = filter.tenantId === 'platform' ? null : filter.tenantId;
    } else {
      // Not the `NULL OR mine` the policy would allow: a tenant admin manages
      // their tenant's campaigns, and the platform's are not theirs to see.
      where.tenantId = actor.tenantId;
    }
    if (filter.status) where.status = filter.status;

    const read = (client: Pick<PrismaService, 'notificationCampaign'>) =>
      Promise.all([
        client.notificationCampaign.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        client.notificationCampaign.count({ where }),
      ]);
    // The page and its total in one snapshot. On the app pool that transaction
    // must bind the tenant first, which is what `tenantTransaction` is for.
    const [rows, total] = owner
      ? await this.all.$transaction((tx) => read(tx))
      : await tenantTransaction(this.prisma, (tx) => read(tx));
    return { items: rows.map(toView), page, pageSize, total };
  }

  async get(actor: CampaignActor, id: string): Promise<CampaignView> {
    const { owner, db } = await this.access(actor);
    return toView(await this.loadManaged(actor, owner, db, id));
  }

  async update(actor: CampaignActor, id: string, patch: UpdateCampaignInput): Promise<CampaignView> {
    const { owner, db } = await this.access(actor);
    const current = await this.loadManaged(actor, owner, db, id);
    if (patch.channel !== undefined) this.assertPlatformLine(patch.channel, actor, owner, current.tenantId);

    const data: Prisma.NotificationCampaignUpdateManyMutationInput = {};
    if (patch.channel !== undefined) data.channel = patch.channel;
    if (patch.messageBody !== undefined) data.messageBody = patch.messageBody;
    if (patch.subject !== undefined) data.subject = patch.subject;
    if (patch.sourceLang !== undefined) data.sourceLang = patch.sourceLang;
    if (patch.audience !== undefined) data.filterCriteria = patch.audience as Prisma.InputJsonObject;
    const sourceChanged = patch.messageBody !== undefined || patch.subject !== undefined || patch.sourceLang !== undefined;

    const write = async (tx: CampaignDb) => {
      // `status` is in the write's own `where`, not a check before it: a fan-out
      // starting between the read and the write must not see its audience change.
      const { count } = await tx.notificationCampaign.updateMany({
        where: { id, status: CampaignStatus.draft },
        data,
      });
      if (count === 0) throw new CampaignAdminRefused('campaign_not_draft', id);
      // F-035-h: a translation of the old source must not go out beside the new
      // one. Same transaction, so a send cannot start between the two writes.
      if (sourceChanged) await tx.notificationCampaignText.deleteMany({ where: { campaignId: id } });
    };
    if (!sourceChanged) await write(db);
    else if (owner) await this.all.$transaction((tx) => write(tx));
    else await tenantTransaction(this.prisma, (tx) => write(tx));
    return toView(await this.loadManaged(actor, owner, db, id));
  }

  /**
   * A campaign the caller manages, with the pool that serves them — for the
   * campaign's texts (F-035-h), which have no access rule of their own.
   * `draft: true` refuses anything past a draft (invariant 8).
   */
  async managed(actor: CampaignActor, id: string, options: { draft?: boolean } = {}) {
    const { owner, db } = await this.access(actor);
    const row = await this.loadManaged(actor, owner, db, id);
    if (options.draft && row.status !== CampaignStatus.draft) throw new CampaignAdminRefused('campaign_not_draft', id);
    return { db, campaign: toView(row) };
  }

  /**
   * Starts sending (F-035-d): `draft -> sending` and `sendStartedAt`, which fixes
   * the audience in time, with the audit row in the same transaction. The
   * fan-out on `worker-service` picks it up on its next tick. Checked in the
   * write's own `where`, as `update` is, so two clicks start one send.
   */
  async send(actor: CampaignActor, id: string, ip: string): Promise<CampaignView> {
    const { owner, db } = await this.access(actor);
    const before = await this.loadManaged(actor, owner, db, id);

    const run = async (tx: Prisma.TransactionClient) => {
      const { count } = await tx.notificationCampaign.updateMany({
        where: { id, status: CampaignStatus.draft },
        data: { status: CampaignStatus.sending, sendStartedAt: new Date() },
      });
      if (count === 0) throw new CampaignAdminRefused('campaign_not_draft', id);
      const after = await tx.notificationCampaign.findUnique({ where: { id } });
      await tx.adminAuditLog.create({
        data: {
          tenantId: before.tenantId ?? actor.tenantId,
          adminId: actor.adminId,
          action: AdminAction.campaign_send,
          targetEntityType: AuditTargetType.notification_campaign,
          targetEntityId: id,
          oldValue: { status: before.status },
          newValue: JSON.parse(JSON.stringify(toView(after))) as Prisma.InputJsonValue,
          adminIpAddress: ip,
        },
      });
      return after;
    };
    const row = owner ? await this.all.$transaction(run) : await tenantTransaction(this.prisma, run);
    return toView(row);
  }

  /**
   * Whether the caller is the platform owner, and the pool that serves them.
   * The only place that hands out {@link CrossTenantPrismaService} (ADR-0053).
   */
  private async access(actor: CampaignActor): Promise<{ owner: boolean; db: CampaignDb }> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    const owner = tenant?.tenantType === TenantType.platform_owner;
    return { owner, db: owner ? this.all : this.prisma };
  }

  private async ownerOfNew(actor: CampaignActor, owner: boolean, requested: string | null | undefined): Promise<string | null> {
    const tenantId = requested === undefined ? actor.tenantId : requested;
    if (tenantId === actor.tenantId) return tenantId;
    if (!owner) {
      throw new CampaignAdminRefused('not_platform_owner', tenantId === null ? 'a platform-wide campaign' : "another tenant's campaign");
    }
    if (tenantId !== null && !(await this.all.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      throw new CampaignAdminRefused('tenant_not_found', tenantId);
    }
    return tenantId;
  }

  /**
   * D-38 (invariant 10): the only SMS line and the only mail server are the
   * platform's, so an SMS or email campaign is the platform owner's own, to its
   * own users (F-035-f, F-035-h). Refused at the draft so an admin hears it
   * now, not as a campaign of `failed` rows.
   */
  private assertPlatformLine(channel: NotificationChannel, actor: CampaignActor, owner: boolean, tenantId: string | null): void {
    if (channel !== NotificationChannel.sms && channel !== NotificationChannel.email) return;
    if (!owner || tenantId !== actor.tenantId) {
      const reason = channel === NotificationChannel.sms ? 'sms_not_available' : 'email_not_available';
      throw new CampaignAdminRefused(reason, `only the platform owner has a ${channel} line, for its own users`);
    }
  }

  /** On the app pool `withTenant` already confined the read; the check repeats it for the owner's pool's sake. */
  private async loadManaged(actor: CampaignActor, owner: boolean, db: CampaignDb, id: string): Promise<CampaignRow> {
    const row = await db.notificationCampaign.findUnique({ where: { id } });
    if (!row) throw new CampaignAdminRefused('campaign_not_found', id);
    if (row.tenantId !== actor.tenantId && !owner) {
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
    subject: row.subject,
    sourceLang: row.sourceLang,
    status: row.status,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    createdAt: row.createdAt.toISOString(),
  };
}
