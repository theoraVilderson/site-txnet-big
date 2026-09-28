import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestHeaders } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';

/**
 * billing-service's internal answer to "which currencies do this tenant's
 * gateways charge in" (F-116-j, `ChargeCurrenciesController`). Billing owns
 * the gateways and each provider's charge currency; this service only asks.
 *
 * **Never throws.** Billing down, slow, or misconfigured is `[]` with a
 * warning: the tenant can then still pin its operating currency, and only the
 * gateway currencies wait for billing to answer.
 */
@Injectable()
export class BillingClient {
  private readonly logger = new Logger(BillingClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.baseUrl = config.get('BILLING_API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.token = config.get('SERVICE_AUTH_TOKEN', { infer: true });
    this.timeoutMs = config.get('BILLING_API_TIMEOUT_MS', { infer: true });
  }

  async chargeCurrencies(tenantId: string): Promise<string[]> {
    if (!this.baseUrl || !this.token) {
      this.logger.warn('BILLING_API_BASE_URL or SERVICE_AUTH_TOKEN unset — no gateway currency can be pinned');
      return [];
    }
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/billing/tenants/${tenantId}/charge-currencies`, {
        headers: { [RequestHeaders.serviceToken]: this.token, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      const body = (await response.json()) as { currencies?: unknown; data?: { currencies?: unknown } };
      const list = body.currencies ?? body.data?.currencies;
      return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
    } catch (err) {
      this.logger.warn(`charge currencies of ${tenantId} unavailable: ${(err as Error).message}`);
      return [];
    }
  }
}
