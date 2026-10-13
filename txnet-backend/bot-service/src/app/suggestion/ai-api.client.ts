import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { serviceCallHeaders } from '@txnet-backend/shared-core';

export type OptOutSubject = { tenantId: string; subjectKind: 'user'; subjectId: string };
export type OptOutAnswer = { ok: boolean; status: number; actionType?: string };

/**
 * The one ai-service seam the bot calls (F-038-g4): the opt-out tap of
 * F-1505, `POST /api/internal/ai/actions/:id/opt-out`, as a service caller
 * with the subject this chat authenticated as. Unset `AI_API_BASE_URL` answers
 * 503 — the button says "no longer available", never "done".
 */
@Injectable()
export class AiApiClient {
  private readonly logger = new Logger(AiApiClient.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('AI_API_BASE_URL') ?? '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 8000);
  }

  async optOut(actionId: string, subject: OptOutSubject): Promise<OptOutAnswer> {
    if (!this.baseUrl) return { ok: false, status: 503 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/ai/actions/${actionId}/opt-out`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...serviceCallHeaders(this.serviceToken) },
        body: JSON.stringify(subject),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, status: response.status };
      const body = (await response.json()) as { data?: { actionType?: string } };
      return { ok: true, status: response.status, actionType: body.data?.actionType };
    } catch (err) {
      this.logger.warn(`ai opt-out for ${actionId} failed: ${(err as Error).message}`);
      return { ok: false, status: 503 };
    } finally {
      clearTimeout(timer);
    }
  }
}
