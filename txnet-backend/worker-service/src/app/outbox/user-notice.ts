import { IdentityHeaders, RequestHeaders } from '@txnet-backend/shared-core';
import { ConfigService } from '@nestjs/config';

/** auth-service's seam for messaging a user on their linked bot (ADR-0045 decision 2). */
const NOTIFY_PATH = '/api/internal/notify/user';

/** A named message for one user; the words are auth-service's, in the user's language. */
export type UserNotice = { tenantId: string; userId: string; template: string; params: Record<string, string> };

/**
 * Ask auth-service to message a user on their linked bot — the half every
 * payer notice shares (F-067-l, F-067-m). Throws on an unset seam or a
 * refusal, so the caller gives its marker back and the event stays owed.
 */
export class UserNoticeSender {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('AUTH_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async send(notice: UserNotice): Promise<void> {
    if (!this.baseUrl) throw new Error('AUTH_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${NOTIFY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RequestHeaders.serviceToken]: this.serviceToken,
          [IdentityHeaders.tenantId]: notice.tenantId,
        },
        body: JSON.stringify({ userId: notice.userId, template: notice.template, params: notice.params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`auth-api answered ${response.status} to ${NOTIFY_PATH}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
