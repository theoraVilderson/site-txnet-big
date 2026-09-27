import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';
import { BrokerService } from '../broker/broker.service';
import { EventNoticeSender } from '../outbox/event-notice';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';

const TAKE_PATH = '/api/internal/notifications/retention/held/take';
const TOLD_PATH = '/api/internal/notifications/retention/held/told';

/** Rows one run takes; the rest wait five minutes. */
const TAKE_LIMIT = 200;

/** The held message's own marker segment: the ledger row's id is its "event". */
const CONSUMER = 'retention-held';

type Held = { id: string; tenantId: string; userId: string; template: string; params: Record<string, string> };

/**
 * The end of a user's quiet hours (F-601-m, spec 9.4). A retention notice
 * claimed inside them was written to the inbox at once, and its bot message
 * kept on its ledger row for the window's end; this tells those now due.
 *
 * **Every five minutes**: a window's end is on the minute, and a message five
 * minutes after it is still morning's first.
 *
 * **Safe to run twice** (ADR-0027): a take leases its rows for ten minutes, so
 * two runs never take one row; each message is marked per row id on the bot
 * channel before it is told (`EventNoticeSender`), so a run that died between
 * the tell and `told` repeats nothing when the lease lapses and the row is
 * taken again.
 *
 * **It never succeeds quietly**: an unset seam or a refused take throws. A
 * message whose tell failed is left leased, taken again after the lease, and
 * counted in `errorsCount`.
 */
@Injectable()
export class RetentionHeldNoticeJob implements Job {
  readonly key = 'retention_held_notice';
  readonly name = 'Quiet hours are over';
  readonly description =
    "Tells on the bot the retention notices held for their owner's quiet hours, once those hours end; their inbox rows were written when they came (F-601-m).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, a notice held for quiet hours reaches the inbox only. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' };

  private readonly logger = new Logger(RetentionHeldNoticeJob.name);
  private readonly sender: EventNoticeSender;
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(redis: RedisService, realtime: RealtimePublisher, config: ConfigService, broker: BrokerService) {
    this.sender = new EventNoticeSender(redis, realtime, config, broker);
    this.baseUrl = config.get<string>('NOTIFICATION_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('NOTIFICATION_API_TIMEOUT_MS', 60_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('NOTIFICATION_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const items = await this.post(TAKE_PATH, { limit: TAKE_LIMIT });
    if (!Array.isArray(items?.items)) throw new Error(`notification answered ${TAKE_PATH} without its items`);
    const held = items.items as Held[];

    const told: string[] = [];
    let errors = 0;
    for (const row of held) {
      try {
        await this.sender.send({
          consumer: CONSUMER,
          eventId: row.id,
          person: { tenantId: row.tenantId, userId: row.userId, template: row.template, params: row.params ?? {} },
          only: ['bot'],
        });
        told.push(row.id);
      } catch (err) {
        errors++;
        this.logger.warn(`held retention notice ${row.id} not told: ${(err as Error).message}`);
      }
    }
    if (told.length > 0) {
      await this.post(TOLD_PATH, { ids: told });
      this.logger.log(`told ${told.length} retention notice(s) held for quiet hours`);
    }
    return { itemsProcessed: told.length, errorsCount: errors, metrics: { taken: held.length, told: told.length } };
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`notification answered ${response.status} to ${path}`);
      return envelopeData(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }
}
