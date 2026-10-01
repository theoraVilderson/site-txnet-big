import { Injectable } from '@nestjs/common';
import { AdminAction, AuditTargetType, CampaignStatus, DeliveryStatus, Language, NotificationChannel, Prisma, TenantStatus, TenantType } from '@prisma/client';
import { ResellerQuota, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AudienceFilter } from './campaign-admin.schema';
import { completeIfSettled } from './campaign-fan-out.service';
import { SmsLineSource } from './sms-line';

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

/** The heads-up before a reseller is suspended or terminated (F-018-q). */
export type SendingSummary = {
  tenantId: string;
  /** Campaigns `sending` now. */
  campaigns: number;
  /** Their recipient rows not yet sent or failed. */
  recipientsQueued: number;
  /** Of those campaigns, the ones whose audience is still being written — `recipientsQueued` can still grow. */
  campaignsStillFanningOut: number;
};

export type CampaignAdminRejection =
  | 'not_platform_owner'
  | 'tenant_not_found'
  | 'campaign_not_found'
  | 'campaign_not_draft'
  | 'sms_not_available'
  | 'email_not_available'
  | 'text_is_source'
  | 'text_not_found'
  | 'campaign_not_stopped'
  | 'tenant_not_open';

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
    /** Whether a reseller has its own SMS line (F-035-i-a). */
    private readonly smsLines: SmsLineSource,
  ) {}

  async create(actor: CampaignActor, input: CreateCampaignInput): Promise<CampaignView> {
    const { owner, db } = await this.access(actor);
    const tenantId = await this.ownerOfNew(actor, owner, input.tenantId);
    await this.assertLine(input.channel, actor, owner, tenantId);
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
    if (patch.channel !== undefined) await this.assertLine(patch.channel, actor, owner, current.tenantId);

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
      // One send is one unit of the reseller's campaign_sends_daily_max quota
      // (F-019-v4, ADR-0107): counted per fixed day, sold past or stopped by the
      // engine, committed with the flip. The platform owner's people pass; a
      // tenant that is not a reseller is exempt.
      if (!owner) {
        const tenantId = before.tenantId ?? actor.tenantId;
        await ResellerQuota.consume(tx, { tenantId, meter: 'campaign_sends_daily_max', qty: 1, sourceRef: `campaign_send:${id}` });
      }
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
   * Sends a stopped campaign again (F-018-q): `stopped -> sending`, audited
   * (`campaign_resume`), checked in the write's own `where` as `send` is. Its
   * queued rows go out on the next delivery run and the fan-out carries on from
   * its cursor. Refused while the campaign's tenant is suspended or terminated,
   * so the send stopped with a suspension is not reopened beside it; a campaign
   * with nothing left is completed at once.
   */
  async resume(actor: CampaignActor, id: string, ip: string): Promise<CampaignView> {
    const { owner, db } = await this.access(actor);
    const before = await this.loadManaged(actor, owner, db, id);
    if (before.status !== CampaignStatus.stopped) throw new CampaignAdminRefused('campaign_not_stopped', id);
    if (before.tenantId !== null) {
      const tenant = await (owner ? this.all : this.prisma).tenant.findUnique({ where: { id: before.tenantId }, select: { status: true } });
      if (tenant?.status === TenantStatus.suspended || tenant?.status === TenantStatus.terminated) {
        throw new CampaignAdminRefused('tenant_not_open', before.tenantId);
      }
    }

    const run = async (tx: Prisma.TransactionClient) => {
      const { count } = await tx.notificationCampaign.updateMany({
        where: { id, status: CampaignStatus.stopped },
        data: { status: CampaignStatus.sending, stoppedAt: null },
      });
      if (count === 0) throw new CampaignAdminRefused('campaign_not_stopped', id);
      await completeIfSettled(tx, id);
      const after = await tx.notificationCampaign.findUnique({ where: { id } });
      await tx.adminAuditLog.create({
        data: {
          tenantId: before.tenantId ?? actor.tenantId,
          adminId: actor.adminId,
          action: AdminAction.campaign_resume,
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
   * The platform owner stops every `sending` campaign of one tenant (F-018-x,
   * ADR-0058 (5)) — after a suspension, or for a reseller suspended earlier.
   * `sending -> stopped` and nothing else (invariant 12): recipient rows stay
   * `queued`, none failed or deleted, and fan-out and delivery select only
   * `sending`, so both halt at their next run. On the cross-tenant pool, and the
   * only way in since F-018-w retired the outbox path — a failure reaches the
   * owner at once and is retried by asking again. Audited against the
   * tenant (`campaign_stop`) only when something stopped: a repeat is a no-op.
   */
  async stopTenant(actor: CampaignActor, tenantId: string, ip: string): Promise<{ stopped: number }> {
    const { owner } = await this.access(actor);
    if (!owner) throw new CampaignAdminRefused('not_platform_owner', "stopping a tenant's campaigns");
    if (!(await this.all.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      throw new CampaignAdminRefused('tenant_not_found', tenantId);
    }
    return this.all.$transaction(async (tx) => {
      const { count } = await tx.notificationCampaign.updateMany({
        where: { tenantId, status: CampaignStatus.sending },
        data: { status: CampaignStatus.stopped, stoppedAt: new Date() },
      });
      if (count > 0) {
        await tx.adminAuditLog.create({
          data: {
            tenantId,
            adminId: actor.adminId,
            action: AdminAction.campaign_stop,
            targetEntityType: AuditTargetType.tenant,
            targetEntityId: tenantId,
            newValue: { stopped: count },
            adminIpAddress: ip,
          },
        });
      }
      return { stopped: count };
    });
  }

  /**
   * How much of a reseller's sending is still to go (F-018-q) — what the
   * platform owner is told before suspending or terminating it. Owner only, on
   * the cross-tenant pool.
   */
  async sendingSummary(actor: CampaignActor, tenantId: string): Promise<SendingSummary> {
    const { owner } = await this.access(actor);
    if (!owner) throw new CampaignAdminRefused('not_platform_owner', 'the sending summary of a tenant');
    const sending = { tenantId, status: CampaignStatus.sending };
    const campaigns = await this.all.notificationCampaign.count({ where: sending });
    const campaignsStillFanningOut = await this.all.notificationCampaign.count({ where: { ...sending, fannedOutAt: null } });
    const recipientsQueued = await this.all.notificationCampaignRecipient.count({
      where: { deliveryStatus: DeliveryStatus.queued, campaign: sending },
    });
    return { tenantId, campaigns, recipientsQueued, campaignsStillFanningOut };
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
   * D-38 (invariant 10): an SMS or email campaign goes to the campaign tenant's
   * own users on a line that tenant sends on — the platform owner's for its own
   * (F-035-f, F-035-h), a reseller's own SMS line for its own (F-035-i-a). A
   * platform-wide campaign, or the owner's draft for another tenant, has none.
   * Refused at the draft so an admin hears it now, not as a campaign of
   * `failed` rows. Delivery asks the same of `SmsLineResolver` again.
   */
  private async assertLine(channel: NotificationChannel, actor: CampaignActor, owner: boolean, tenantId: string | null): Promise<void> {
    if (channel !== NotificationChannel.sms && channel !== NotificationChannel.email) return;
    if (tenantId !== null && tenantId === actor.tenantId) {
      if (owner) return;
      if (channel === NotificationChannel.sms && (await this.smsLines.ownLineAvailable(tenantId))) return;
    }
    const reason = channel === NotificationChannel.sms ? 'sms_not_available' : 'email_not_available';
    throw new CampaignAdminRefused(reason, `no ${channel} line for this tenant's campaign to its own users`);
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
