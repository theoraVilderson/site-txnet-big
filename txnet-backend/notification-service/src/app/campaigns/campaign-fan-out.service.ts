import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CampaignStatus, DeliveryStatus, Prisma, UserStatus } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { AudienceFilter, audienceFilterSchema } from './campaign-admin.schema';

/** Users read per batch; one batch is one transaction. */
export const FAN_OUT_BATCH = 500;
/** Recipient rows one call may write before it answers; the next tick carries on. */
export const FAN_OUT_BUDGET = 5_000;

export const FAN_OUT_OPTIONS = Symbol('FAN_OUT_OPTIONS');
export type FanOutOptions = { batchSize?: number };

export type FanOutResult = {
  /** Campaigns this call worked on. */
  campaigns: number;
  /** Recipient rows newly written; a replayed batch adds 0. */
  recipients: number;
  /** Campaigns whose audience is now fully written. */
  finished: number;
  /** Campaigns skipped because the stored filter or start time does not parse. */
  unreadable: number;
};

/** Where a `queued` row may go; never back (invariant 4). */
export const RECIPIENT_OUTCOMES = [DeliveryStatus.sent, DeliveryStatus.failed] as const;
export type RecipientOutcome = (typeof RECIPIENT_OUTCOMES)[number];

export class CampaignFanOutRefused extends Error {
  constructor(readonly reason: 'recipient_not_found', detail: string) {
    super(`${reason}: ${detail}`);
  }
}

type SendingCampaign = {
  id: string;
  tenantId: string | null;
  filterCriteria: Prisma.JsonValue;
  sendStartedAt: Date | null;
  fanOutCursor: string | null;
};

type Tx = Pick<Prisma.TransactionClient, 'notificationCampaign' | 'notificationCampaignRecipient'>;

/**
 * Sending a campaign (F-035-d): the audience becomes `notification_campaign_recipient`
 * rows, and a delivered or failed row moves with its campaign's counter.
 * `worker-service`'s `notification_campaign_fan_out` job drives {@link fanOut}
 * over `internal/notifications/campaigns/fan-out`; the adapters (F-035-e/f)
 * report through {@link recordOutcome}.
 *
 * **On the cross-tenant pool, with a reason.** No caller is a tenant here, and
 * a platform-wide campaign's audience is every tenant's users, which no tenant
 * binding can read. So RLS stands behind nothing on this path: the `tenantId`
 * in {@link audienceWhere} is the whole of invariant 1, and the spec asserts it.
 *
 * **Safe to run twice.** Each batch inserts with `skipDuplicates` on the
 * `(campaignId, userId)` unique index and moves `fanOutCursor` in the same
 * transaction, so a crash replays at most one batch and the replay writes nothing
 * (invariant 4). A counter only moves in the transaction that moved its one row
 * out of `queued` (invariant 2).
 */
@Injectable()
export class CampaignFanOutService {
  private readonly logger = new Logger(CampaignFanOutService.name);
  private readonly batchSize: number;

  constructor(
    private readonly db: CrossTenantPrismaService,
    @Optional() @Inject(FAN_OUT_OPTIONS) options?: FanOutOptions,
  ) {
    this.batchSize = options?.batchSize ?? FAN_OUT_BATCH;
  }

  async fanOut({ budget = FAN_OUT_BUDGET }: { budget?: number } = {}): Promise<FanOutResult> {
    const result: FanOutResult = { campaigns: 0, recipients: 0, finished: 0, unreadable: 0 };
    const due: SendingCampaign[] = await this.db.notificationCampaign.findMany({
      where: { status: CampaignStatus.sending, fannedOutAt: null },
      orderBy: [{ sendStartedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, tenantId: true, filterCriteria: true, sendStartedAt: true, fanOutCursor: true },
      take: 50,
    });

    for (const campaign of due) {
      if (budget <= 0) break;
      const filter = audienceFilterSchema.safeParse(campaign.filterCriteria);
      if (!filter.success || !campaign.sendStartedAt) {
        // Written only through the schema, so this is a fault, not an audience:
        // guessing would send to everybody. The campaign stays `sending`.
        this.logger.error(`campaign ${campaign.id} has no readable audience or start time; not fanned out`);
        result.unreadable++;
        continue;
      }
      result.campaigns++;
      const where = audienceWhere({ tenantId: campaign.tenantId, sendStartedAt: campaign.sendStartedAt }, filter.data);
      let cursor = campaign.fanOutCursor;

      while (budget > 0) {
        const take = Math.min(this.batchSize, budget);
        const users = await this.db.user.findMany({
          where: { AND: [...where.AND, ...(cursor ? [{ id: { gt: cursor } }] : [])] },
          orderBy: { id: 'asc' },
          select: { id: true },
          take,
        });
        const done = users.length < take;
        const last = users.length > 0 ? users[users.length - 1].id : null;

        const written = await this.db.$transaction(async (tx) => {
          let count = 0;
          if (users.length > 0) {
            ({ count } = await tx.notificationCampaignRecipient.createMany({
              data: users.map((u) => ({ campaignId: campaign.id, userId: u.id })),
              skipDuplicates: true,
            }));
          }
          const data: Prisma.NotificationCampaignUpdateManyMutationInput = {};
          if (last) data.fanOutCursor = last;
          if (done) data.fannedOutAt = new Date();
          await tx.notificationCampaign.updateMany({
            where: { id: campaign.id, status: CampaignStatus.sending, fannedOutAt: null },
            data,
          });
          if (done) await completeIfSettled(tx, campaign.id);
          return count;
        });

        result.recipients += written;
        budget -= users.length;
        cursor = last ?? cursor;
        if (done) {
          result.finished++;
          break;
        }
      }
    }
    return result;
  }

  /** Moves one `queued` row to `sent` or `failed`, with its counter. `changed: false` = it had moved already. */
  async recordOutcome(recipientId: string, outcome: RecipientOutcome): Promise<{ changed: boolean }> {
    if (outcome !== DeliveryStatus.sent && outcome !== DeliveryStatus.failed) {
      throw new Error(`a recipient never moves back to ${DeliveryStatus.queued} (invariant 4)`);
    }
    return this.db.$transaction(async (tx) => {
      const row = await tx.notificationCampaignRecipient.findUnique({ where: { id: recipientId }, select: { campaignId: true } });
      if (!row) throw new CampaignFanOutRefused('recipient_not_found', recipientId);

      const { count } = await tx.notificationCampaignRecipient.updateMany({
        where: { id: recipientId, deliveryStatus: DeliveryStatus.queued },
        data: { deliveryStatus: outcome },
      });
      if (count === 0) return { changed: false };

      await tx.notificationCampaign.update({
        where: { id: row.campaignId },
        data: outcome === DeliveryStatus.sent ? { sentCount: { increment: 1 } } : { failedCount: { increment: 1 } },
      });
      await completeIfSettled(tx, row.campaignId);
      return { changed: true };
    });
  }
}

/** `sending -> completed` once the audience is written and nothing is left `queued`. */
async function completeIfSettled(tx: Tx, campaignId: string): Promise<void> {
  const queued = await tx.notificationCampaignRecipient.count({
    where: { campaignId, deliveryStatus: DeliveryStatus.queued },
  });
  if (queued > 0) return;
  await tx.notificationCampaign.updateMany({
    where: { id: campaignId, status: CampaignStatus.sending, fannedOutAt: { not: null } },
    data: { status: CampaignStatus.completed },
  });
}

/**
 * The stored audience as a user query — exactly `audienceFilterSchema`'s keys
 * and nothing else (`contract.md` "Campaigns"). A new key lands here and in the
 * schema in one change.
 */
export function audienceWhere(
  campaign: { tenantId: string | null; sendStartedAt: Date },
  filter: AudienceFilter,
): { AND: Prisma.UserWhereInput[] } {
  const and: Prisma.UserWhereInput[] = [];
  // Invariant 1. `null` is platform-wide: every tenant's users, by definition.
  if (campaign.tenantId !== null) and.push({ tenantId: campaign.tenantId });
  and.push({ status: { in: filter.statuses ?? [UserStatus.active] } });
  and.push({ deletedAt: null });
  and.push({ createdAt: { lte: campaign.sendStartedAt } });
  if (filter.languages) and.push({ languagePreference: { in: filter.languages } });
  if (filter.registeredFrom) and.push({ createdAt: { gte: new Date(filter.registeredFrom) } });
  if (filter.registeredTo) and.push({ createdAt: { lt: new Date(filter.registeredTo) } });

  // A user with no wallet has a balance of 0 (C-02: compared as Decimal, never a float).
  const noWallet: Prisma.UserWhereInput = { wallet: { is: null } };
  if (filter.minBalance) {
    const min = new Prisma.Decimal(filter.minBalance);
    const funded: Prisma.UserWhereInput = { wallet: { is: { cachedBalance: { gte: min } } } };
    and.push(min.lte(0) ? { OR: [noWallet, funded] } : funded);
  }
  if (filter.maxBalance) {
    const max = new Prisma.Decimal(filter.maxBalance);
    and.push({ OR: [noWallet, { wallet: { is: { cachedBalance: { lte: max } } } }] });
  }
  return { AND: and };
}
