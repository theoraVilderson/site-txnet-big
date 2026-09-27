import { RequestHeaders, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { envelopeData } from '../automation/internal-answer';
import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender } from './event-notice';
import { RETENTION_NOTICES, type RetentionNotice } from './retention-notices';

/** This consumer's segment of its per-channel markers (F-067-o). */
const CONSUMER = 'retention-notice';

/** notification-service's ledger: one (Grant, notice, period) row, held by the event that wrote it. */
const CLAIM_PATH = '/api/internal/notifications/retention/claim';

/**
 * Tell a user what their service needs them to know before it lapses
 * (F-601-a, spec 9.2): the domains emit, this only delivers. Each type in
 * {@link RETENTION_NOTICES} is one notice, told to the user's inbox and bot
 * through `EventNoticeSender` (ADR-0084) — no live push, the inbox row brings
 * its own (F-035-b).
 *
 * **Once per Grant period.** Before anything is told, notification-service's
 * ledger is asked to claim the (Grant, notice, period) row for this event's
 * id. `claimed: false` means another event already told this period — acked,
 * nothing sent. The same event claims again on a redelivery, so a send that
 * failed after its claim is still owed, and the sender's markers keep a
 * channel that landed from repeating.
 *
 * A payload that does not name its user, Grant or period throws before the
 * claim: a period claimed for a notice never told is that notice lost.
 *
 * **Two notices due the same day are one message** (F-601-f). A usage event
 * may carry the time level due within 24 h; once its own row is claimed, the
 * carried one is claimed for the same event, and both are told in one
 * combined text. The sweep's own event for that level later finds the row
 * held and tells nothing. A carried row already told leaves the usage notice
 * told alone.
 */
@Injectable()
export class RetentionNoticeConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionNoticeConsumer.name);
  private readonly sender: EventNoticeSender;
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;
  /** The table told from; a field so a spec can name a type no producer emits yet. */
  notices: Partial<Record<string, RetentionNotice>> = RETENTION_NOTICES;

  constructor(
    private readonly broker: BrokerService,
    redis: RedisService,
    realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.sender = new EventNoticeSender(redis, realtime, config, broker);
    this.baseUrl = config.get<string>('NOTIFICATION_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('NOTIFICATION_API_TIMEOUT_MS', 60_000);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeRetentionNotices((event) => this.handle(event));
    this.logger.log(`consuming ${Object.keys(this.notices).join(', ') || 'no retention events yet'} for retention notices`);
  }

  async handle(event: OutboxMessage): Promise<void> {
    const notice = this.notices[event.type];
    if (!notice) throw new Error(`outbox event ${event.id} is ${event.type}, which has no retention notice`);
    const retention = retentionOf(event, notice);

    if (!(await this.claim(event, retention, event.type, retention.period))) {
      this.logger.debug(`grant ${retention.grantId} already told ${event.type} this period`);
      return;
    }
    let told = { template: notice.template, params: retention.params };
    const ahead = retention.ahead;
    if (ahead && (await this.claim(event, retention, ahead.notice, ahead.period))) {
      told = { template: ahead.template, params: { ...retention.params, ...ahead.params } };
    }
    await this.sender.send({
      consumer: CONSUMER,
      eventId: event.id,
      person: { tenantId: retention.tenantId, userId: retention.userId, ...told },
    });
  }

  private async claim(event: OutboxMessage, r: Retention, notice: string, period: string): Promise<boolean> {
    if (!this.baseUrl) throw new Error('NOTIFICATION_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${CLAIM_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: JSON.stringify({ eventId: event.id, userId: r.userId, grantId: r.grantId, notice, period }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`notification answered ${response.status} to ${CLAIM_PATH}`);
      const claimed = envelopeData(await response.json())?.claimed;
      if (typeof claimed !== 'boolean') throw new Error(`notification answered ${CLAIM_PATH} without 'claimed'`);
      return claimed;
    } finally {
      clearTimeout(timer);
    }
  }
}

type Retention = {
  tenantId: string;
  userId: string;
  grantId: string;
  period: string;
  params: Record<string, string>;
  /** The carried notice (F-601-f): its type and period, and the combined text told when both rows are held. */
  ahead: { notice: string; period: string; template: string; params: Record<string, string> } | null;
};

/** The payload, or a throw: whose Grant and which period are never guessed. */
function retentionOf(event: OutboxMessage, notice: RetentionNotice): Retention {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  const tenantId = str('tenantId');
  const userId = str('userId');
  const grantId = str('grantId');
  const period = str('period');
  if (!tenantId || !userId || !grantId || !period) {
    throw new Error(`outbox event ${event.id} has a payload without its tenant, user, Grant or period`);
  }
  const params: Record<string, string> = {};
  for (const name of notice.params) {
    const value = str(name);
    if (value === null) throw new Error(`outbox event ${event.id} has a payload without '${name}'`);
    params[name] = value;
  }
  for (const name of notice.optional ?? []) {
    const value = str(name);
    if (value !== null) params[name] = value;
  }
  return { tenantId, userId, grantId, period, params, ahead: aheadOf(event, notice, str) };
}

/** The carried notice, all of it or a throw — a half-named one would claim a row it cannot tell. */
function aheadOf(event: OutboxMessage, notice: RetentionNotice, str: (k: string) => string | null): Retention['ahead'] {
  const type = str('endNotice');
  if (!notice.ahead || type === null) return null;
  const period = str('endPeriod');
  const days = str('days');
  if (!notice.ahead.types.includes(type) || period === null || days === null) {
    throw new Error(`outbox event ${event.id} has a payload carrying '${type}' without a period and days it can tell`);
  }
  const told = notice.ahead.told(days);
  const params: Record<string, string> = {};
  for (const name of told.params) {
    const value = str(name);
    if (value === null) throw new Error(`outbox event ${event.id} has a payload without '${name}'`);
    params[name] = value;
  }
  return { notice: type, period, template: told.template, params };
}
