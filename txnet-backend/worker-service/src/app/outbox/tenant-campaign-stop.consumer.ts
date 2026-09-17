import { RequestHeaders, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { envelopeData } from '../automation/internal-answer';
import { BrokerService } from '../broker/broker.service';

/** Waits between attempts: a notification-service restart is seconds, so ~30s covers one before the event dead-letters. */
export const STOP_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

/**
 * The platform owner suspended or terminated a reseller and chose to stop its
 * sending campaigns too (F-018-q): `tenant.campaigns.stop_requested` ->
 * notification-service's `POST /api/internal/notifications/campaigns/tenants/:tenantId/stop`.
 * The stop repeats safely, so there is no marker. A failed call is retried here
 * with backoff, then throws and dead-letters — the monitoring alert is how a
 * person learns the reseller's campaigns are still sending.
 */
@Injectable()
export class TenantCampaignStopConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantCampaignStopConsumer.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly broker: BrokerService,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('NOTIFICATION_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('NOTIFICATION_API_TIMEOUT_MS', 60_000);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeTenantCampaignStops((event) => this.handle(event));
    this.logger.log('consuming tenant.campaigns.stop_requested to stop a reseller\'s campaigns');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const tenantId = typeof payload.tenantId === 'string' && payload.tenantId !== '' ? payload.tenantId : null;
    if (!tenantId) throw new Error(`outbox event ${event.id} has a payload without its tenant`);
    if (!this.baseUrl) throw new Error('NOTIFICATION_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    for (let attempt = 0; ; attempt++) {
      try {
        const stopped = await this.stop(tenantId);
        this.logger.log(`tenant ${tenantId}: ${stopped} sending campaign(s) stopped`);
        return;
      } catch (err) {
        if (attempt >= STOP_RETRY_DELAYS_MS.length) throw err;
        this.logger.warn(`stopping tenant ${tenantId}'s campaigns failed, retrying: ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, STOP_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  private async stop(tenantId: string): Promise<number> {
    const path = `/api/internal/notifications/campaigns/tenants/${encodeURIComponent(tenantId)}/stop`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`notification answered ${response.status} to ${path}`);
      const stopped = envelopeData(await response.json())?.stopped;
      if (typeof stopped !== 'number') throw new Error(`notification answered ${path} without 'stopped'`);
      return stopped;
    } finally {
      clearTimeout(timer);
    }
  }
}
