import { type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { BrokerService } from '../broker/broker.service';
import { type OnlyChannel } from './event-notice';
import { HomeNotices } from './home-notices';

/** This consumer's segment of the processed-event key — not the live push's. */
const CONSUMER = 'analytics-report';
/** auth-service's words for it (`analytics-notices.ts`). */
const TEMPLATE = 'analyticsReport';
/** The payload fields auth-service writes the report from; an empty change is "nothing compared". */
const PARAMS = ['tab', 'link', 'from', 'to', 'currencyCode', 'net', 'netDelta', 'topUps', 'topUpsDelta', 'orders', 'ordersDelta', 'buyers', 'buyersDelta'] as const;
const CHANNELS: readonly OnlyChannel[] = ['bot', 'email'];

/**
 * Tell a scheduled analytics report (F-1006-a, billing
 * `contract.analytics-reports.md`): the person the schedule names, on exactly
 * the channels it names — `only`, each under its own marker and never joined
 * to a burst, so two reports due at one hour are two messages, never "2
 * reports". Told in the tenant the person lives in (F-067-q): a reseller's
 * owner is a platform user. Its own queue: the morning's reports never hold
 * up a person notice. The page's re-read is `LivePushConsumer`'s, on the
 * same event.
 */
@Injectable()
export class AnalyticsReportConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AnalyticsReportConsumer.name);
  constructor(
    private readonly broker: BrokerService,
    private readonly home: HomeNotices,
  ) {}

  async onApplicationBootstrap() {
    await this.broker.consumeAnalyticsReports((event) => this.handle(event));
    this.logger.log('consuming billing.analytics.report for the scheduled report');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const tenantId = typeof p.tenantId === 'string' ? p.tenantId : null;
    const userId = typeof p.userId === 'string' ? p.userId : null;
    const asked = p.channels;
    const only = Array.isArray(asked) ? CHANNELS.filter((c) => asked.includes(c)) : [];
    // Whose report and where it goes are never guessed.
    if (!tenantId || !userId || only.length === 0) throw new Error(`outbox event ${event.id} is a report without its tenant, person or channel`);
    const params = Object.fromEntries(PARAMS.flatMap((k) => (typeof p[k] === 'string' ? [[k, p[k]]] : [])));
    await this.home.send({ consumer: CONSUMER, eventId: event.id, person: { tenantId, userId, template: TEMPLATE, params }, only });
  }
}
