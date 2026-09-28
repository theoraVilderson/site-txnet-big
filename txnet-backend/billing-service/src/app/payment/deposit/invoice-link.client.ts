import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestHeaders } from '@txnet-backend/shared-core';

/** The Mini App's invoice, as `start` hands it to the bot that will be paid (F-104-q). */
export type InvoiceLinkRequest = {
  tenantId: string;
  platform: string;
  /** Comes back as the payload in `pre_checkout_query` / `successful_payment`, as in the chat. */
  paymentId: string;
  currency: string;
  /** In `currency`'s smallest unit. */
  amountMinor: string;
  /** The gateway's `secretKey` (Bale's wallet). Leaves billing only on this internal call. */
  providerToken: string | null;
  /** For the invoice's description, in `currencyCode` — the payment's, not `currency` (the charge's). */
  credited: string;
  currencyCode: string;
  lang: string;
};

const SEAM = '/api/internal/bots/invoice-link';

/**
 * `bot-service`'s service-only `POST internal/bots/invoice-link` (F-104-q).
 *
 * `billing` never holds a bot token, so a Mini App's invoice link is made where
 * the chat's invoice is sent: the tenant's bot, through `messenger`. The answer
 * is the link — Telegram's URL, or Bale's payment id — which the panel hands to
 * the SDK's `openInvoice` unchanged. Anything else, including an unset seam,
 * is `null`, and `start` fails the payment as it does a bank that will not mint.
 * Nothing about the request is logged: it carries the provider token.
 */
@Injectable()
export class InvoiceLinkClient {
  private readonly logger = new Logger(InvoiceLinkClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = String(config.get<string>('BOT_API_BASE_URL', '') ?? '').replace(/\/+$/, '');
    this.token = String(config.get<string>('SERVICE_AUTH_TOKEN', '') ?? '');
    this.timeoutMs = Number(config.get<number>('BOT_API_TIMEOUT_MS', 10_000));
  }

  async create(request: InvoiceLinkRequest): Promise<string | null> {
    if (!this.baseUrl || !this.token) {
      this.logger.error('BOT_API_BASE_URL or SERVICE_AUTH_TOKEN is not set: no Mini App invoice link');
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${SEAM}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.token },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const data = (answer && 'data' in answer ? answer['data'] : answer) as Record<string, unknown> | null;
      const link = data?.['link'];
      if (!response.ok || typeof link !== 'string' || !link) {
        this.logger.error(`${SEAM} answered ${response.status} for payment ${request.paymentId}: no link`);
        return null;
      }
      return link;
    } catch (e) {
      this.logger.error(`${SEAM} did not answer for payment ${request.paymentId} (${(e as Error).name})`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
