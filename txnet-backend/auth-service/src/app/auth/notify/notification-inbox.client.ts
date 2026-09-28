import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityHeaders, RequestHeaders } from '@txnet-backend/shared-core';

/** notification-service's seam for putting a row in a user's inbox (`notification/contract.md`). */
const INBOX_PATH = '/api/internal/notifications';
/** notification-service's seam for one notice's SMS on the tenant's line (F-601-t). */
const SMS_PATH = '/api/internal/notifications/sms';

export type InboxEntry = { tenantId: string; userId: string; title: string; body: string };
export type SmsEntry = { tenantId: string; userId: string; to: string; text: string };

/**
 * Put a rendered message in a user's panel inbox (F-019-c) — for a notice that
 * must reach someone who may have no linked bot, such as a reseller's owner
 * told that its renewal is unpaid — or send it by SMS (F-601-t). Throws on an
 * unset seam or a refusal, so the worker's event stays owed.
 */
@Injectable()
export class NotificationInboxClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('NOTIFICATION_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('NOTIFICATION_API_TIMEOUT_MS', 30_000);
  }

  async put(entry: InboxEntry): Promise<void> {
    await this.post(INBOX_PATH, entry.tenantId, { userId: entry.userId, type: 'system_alert', title: entry.title, body: entry.body });
  }

  /**
   * A notice's SMS (F-601-t) on the line notification-service picks for the
   * tenant. `false`: the tenant has no line, or the gateway refused the
   * number — answers, not failures. A line that could not send throws.
   */
  async sms(entry: SmsEntry): Promise<{ sent: boolean }> {
    const body = (await this.post(SMS_PATH, entry.tenantId, entry)) as { data?: { sent?: unknown }; sent?: unknown } | null;
    return { sent: (body?.data?.sent ?? body?.sent) === true };
  }

  private async post(path: string, tenantId: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.baseUrl) throw new Error('NOTIFICATION_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RequestHeaders.serviceToken]: this.serviceToken,
          [IdentityHeaders.tenantId]: tenantId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`notification-api answered ${response.status} to ${path}`);
      return await response.json().catch((): null => null);
    } finally {
      clearTimeout(timer);
    }
  }
}
