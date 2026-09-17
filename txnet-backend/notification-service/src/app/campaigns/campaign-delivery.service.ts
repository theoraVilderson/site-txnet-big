import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DeliveryStatus, NotificationChannel, Prisma } from '@prisma/client';
import { BotClientRegistry, BotPlatform, TelegramLikeBotClient } from '@txnet-backend/messenger';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { CampaignFanOutService } from './campaign-fan-out.service';

/** Rows one run claims. Sends are sequential, so this bounds a run's length with the deadline. */
export const DELIVERY_BUDGET = 100;
/** A run stops sending after this long and gives the rest back; the worker's call times out at 60s. */
export const DELIVERY_DEADLINE_MS = 40_000;
/** How long a claim holds a row; a run that died mid-send frees its rows after this. */
export const DELIVERY_LEASE_SEC = 300;
/** What the vault audit row names for every token this reads (F-1215). */
export const DELIVERY_CALLER = 'notification:CampaignDelivery';

/**
 * Which channel `messenger` delivers (D-10). `null` is not this row's: email and
 * SMS are `notification`'s own adapters (F-035-f), `push` has none yet.
 * Exhaustive, so a new channel does not compile until someone says where it goes.
 */
export const CHANNEL_PLATFORM: Record<NotificationChannel, BotPlatform | null> = {
  telegram_bot: 'telegram',
  bale_bot: 'bale',
  push: null,
  sms: null,
};

export const DELIVERY_OPTIONS = Symbol('DELIVERY_OPTIONS');
export type DeliveryOptions = { budget?: number; deadlineMs?: number; now?: () => Date };

export type DeliveryResult = {
  /** Rows this run took. */
  claimed: number;
  sent: number;
  /** Final refusals: no verified chat, no bot, a blocked bot, a chat that is gone. */
  failed: number;
  /** Still `queued`: the platform asked to wait, or the run ran out of time. */
  deferred: number;
  /** Still `queued` because a bot could not be resolved or its token read — an operator's problem. */
  stalled: number;
};

type Claimed = { id: string; campaignId: string; userId: string };

/** One tenant's bot on one platform, as this run found it. */
type Bot =
  | { kind: 'ready'; client: TelegramLikeBotClient }
  | { kind: 'none' }
  | { kind: 'stalled' }
  | { kind: 'throttled'; until: Date };

/**
 * Delivering a campaign to Telegram and Bale (F-035-e). `worker-service`'s
 * `notification_campaign_delivery` job drives {@link deliver} over
 * `internal/notifications/campaigns/deliver`.
 *
 * **This unit owns state; `messenger` owns the driver** (D-10, invariant 3).
 * Nothing here knows a platform's URL, token or error shape: it asks
 * `BotClientRegistry` for the recipient's tenant's primary bot, whose token
 * comes from `auth-service` over the seam and is audited per read.
 *
 * **Whose bot, and which chat** (invariant 9). A chat id belongs to the bot the
 * user talked to, and a user links a chat per tenant, so a message goes out as
 * the *recipient's* tenant's primary bot — for a platform-wide campaign too — to
 * a chat that user linked **in that tenant** with a verified contact, as
 * `identity`'s `UserNotifier` does. On the cross-tenant pool that `tenantId`
 * comparison is the whole guard.
 *
 * **At most one sender per row.** The claim takes rows with `FOR UPDATE SKIP
 * LOCKED` and stamps a lease, so an overlapping run skips them; a run that
 * crashed after sending and before recording frees them when the lease ends,
 * and that one row may be sent twice — the at-least-once every job accepts
 * (ADR-0027). Recording goes through {@link CampaignFanOutService.recordOutcome},
 * which moves a row and its counter together (invariants 2, 4).
 *
 * **Only a refusal is final.** A missing chat, a missing or disabled bot and a
 * 400/403 from the platform are `failed`. A 429, a network error, an
 * unreachable `auth-service` or an unreadable token leave the row `queued`, so
 * an outage delays a campaign rather than burning it.
 */
@Injectable()
export class CampaignDeliveryService {
  private readonly logger = new Logger(CampaignDeliveryService.name);
  private readonly budget: number;
  private readonly deadlineMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: CrossTenantPrismaService,
    private readonly bots: BotClientRegistry,
    private readonly outcomes: CampaignFanOutService,
    @Optional() @Inject(DELIVERY_OPTIONS) options?: DeliveryOptions,
  ) {
    this.budget = options?.budget ?? DELIVERY_BUDGET;
    this.deadlineMs = options?.deadlineMs ?? DELIVERY_DEADLINE_MS;
    this.now = options?.now ?? (() => new Date());
  }

  async deliver(): Promise<DeliveryResult> {
    const result: DeliveryResult = { claimed: 0, sent: 0, failed: 0, deferred: 0, stalled: 0 };
    const started = this.now().getTime();
    const rows = await this.claim();
    result.claimed = rows.length;
    if (rows.length === 0) return result;

    const [campaigns, users, links] = await Promise.all([
      this.db.notificationCampaign.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.campaignId))] } },
        select: { id: true, channel: true, messageBody: true },
      }),
      this.db.user.findMany({
        where: { id: { in: rows.map((r) => r.userId) } },
        select: { id: true, tenantId: true },
      }),
      this.db.linkedBotAccount.findMany({
        where: { userId: { in: rows.map((r) => r.userId) }, contactVerifiedAt: { not: null } },
        select: { userId: true, tenantId: true, platform: true, platformUserId: true },
      }),
    ]);
    const campaignById = new Map(campaigns.map((c) => [c.id, c]));
    const tenantOf = new Map(users.map((u) => [u.id, u.tenantId]));
    const bots = new Map<string, Bot>();
    /** Rows handed back still `queued`, keyed by when they may be claimed again ('' = at once). */
    const released = new Map<string, string[]>();
    const release = (until: Date | null, rowId: string) => {
      const key = until ? until.toISOString() : '';
      released.set(key, [...(released.get(key) ?? []), rowId]);
    };

    for (const row of rows) {
      const campaign = campaignById.get(row.campaignId);
      const platform = campaign ? CHANNEL_PLATFORM[campaign.channel] : null;
      const tenantId = tenantOf.get(row.userId);
      // The claim only takes bot channels of existing campaigns; a miss is a row
      // whose user is gone. Invariant 9: the link must be in the user's own tenant.
      const link = links.find((l) => l.userId === row.userId && l.platform === platform && l.tenantId === tenantId);
      if (!campaign || !platform || !tenantId || !link) {
        await this.record(row.id, DeliveryStatus.failed, result);
        continue;
      }
      if (this.now().getTime() - started >= this.deadlineMs) {
        release(null, row.id);
        result.deferred++;
        continue;
      }

      const bot = await this.botFor(bots, tenantId, platform);
      if (bot.kind === 'none') {
        await this.record(row.id, DeliveryStatus.failed, result);
        continue;
      }
      if (bot.kind === 'stalled') {
        release(null, row.id);
        result.stalled++;
        continue;
      }
      if (bot.kind === 'throttled') {
        release(bot.until, row.id);
        result.deferred++;
        continue;
      }

      const sent = await bot.client.sendText(link.platformUserId, campaign.messageBody);
      // `in`, not `ok`: this project does not narrow a union on a boolean literal.
      if (!('permanent' in sent)) {
        await this.record(row.id, DeliveryStatus.sent, result);
      } else if (sent.permanent) {
        this.logger.warn(`campaign ${row.campaignId}: recipient ${row.id} refused by ${platform}: ${sent.description}`);
        await this.record(row.id, DeliveryStatus.failed, result);
      } else {
        // Anything but a refusal is worth another run. A rate limit holds every
        // row of that bot until the platform's own `retry_after`.
        const until = new Date(this.now().getTime() + (sent.retryAfterSec ?? 0) * 1000);
        if (sent.retryAfterSec !== null) bots.set(`${tenantId}:${platform}`, { kind: 'throttled', until });
        this.logger.warn(`campaign ${row.campaignId}: ${platform} send deferred: ${sent.description}`);
        release(sent.retryAfterSec !== null ? until : null, row.id);
        result.deferred++;
      }
    }

    for (const [key, ids] of released) {
      await this.db.notificationCampaignRecipient.updateMany({
        where: { id: { in: ids }, deliveryStatus: DeliveryStatus.queued },
        data: { claimedUntil: key ? new Date(key) : null },
      });
    }
    if (result.stalled > 0) {
      this.logger.error(`${result.stalled} recipient(s) left queued: their tenant's bot could not be resolved or its token read`);
    }
    return result;
  }

  /** Queued rows of `sending` bot campaigns that no run holds, leased to this one. */
  private claim(): Promise<Claimed[]> {
    const channels = (Object.keys(CHANNEL_PLATFORM) as NotificationChannel[]).filter((c) => CHANNEL_PLATFORM[c] !== null);
    return this.db.$queryRaw<Claimed[]>(Prisma.sql`
      UPDATE "notification"."notification_campaign_recipient" AS t
      SET "claimedUntil" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${DELIVERY_LEASE_SEC})
      WHERE t."id" IN (
        SELECT r."id"
        FROM "notification"."notification_campaign_recipient" r
        JOIN "notification"."notification_campaign" c ON c."id" = r."campaignId"
        WHERE r."deliveryStatus" = 'queued'
          AND (r."claimedUntil" IS NULL OR r."claimedUntil" < (now() AT TIME ZONE 'UTC'))
          AND c."status" = 'sending'
          AND c."channel"::text IN (${Prisma.join(channels)})
        ORDER BY r."id"
        LIMIT ${this.budget}
        FOR UPDATE OF r SKIP LOCKED
      )
      RETURNING t."id", t."campaignId", t."userId"`);
  }

  /** Resolved once per run per `(tenant, platform)`: one primary lookup and one audited token read. */
  private async botFor(bots: Map<string, Bot>, tenantId: string, platform: BotPlatform): Promise<Bot> {
    const key = `${tenantId}:${platform}`;
    const known = bots.get(key);
    if (known) return known;

    let bot: Bot;
    try {
      const integration = await this.bots.primaryFor(tenantId, platform);
      if (!integration || integration.status === 'disabled') {
        bot = { kind: 'none' };
      } else {
        const client = await this.bots.client(integration, DELIVERY_CALLER);
        bot = client ? { kind: 'ready', client } : { kind: 'stalled' };
      }
    } catch (err) {
      this.logger.error(`tenant ${tenantId} ${platform} bot not resolved: ${(err as Error).message}`);
      bot = { kind: 'stalled' };
    }
    bots.set(key, bot);
    return bot;
  }

  private async record(recipientId: string, outcome: 'sent' | 'failed', result: DeliveryResult): Promise<void> {
    await this.outcomes.recordOutcome(recipientId, outcome);
    result[outcome]++;
  }
}
