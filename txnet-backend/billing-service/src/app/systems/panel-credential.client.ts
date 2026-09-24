import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestHeaders } from '@txnet-backend/shared-core';

import type { PanelCredentialState, PanelCredentialWriter } from './panel-registration';

/** The seam on `tenant-service` (F-027-ar). Service callers only; 404 otherwise. */
const SEAM = '/api/internal/vault/panel-credential';

/** The seam could not answer: unset, unreachable, or a status it should never give. The message names no value. */
export class PanelCredentialUnavailable extends Error {
  constructor(detail: string) {
    super(`panel credential unavailable: ${detail}`);
    this.name = 'PanelCredentialUnavailable';
  }
}

/** `tenant-service` refused on a rule of its own — the owner it re-derived is not the one named, or the row is gone. */
export class PanelCredentialRefused extends Error {
  constructor(readonly status: 400 | 403 | 404, readonly reason: string) {
    super(`panel credential refused: ${reason}`);
    this.name = 'PanelCredentialRefused';
  }
}

const REFUSALS = new Set([400, 403, 404]);

/**
 * `PanelCredentialWriter` over HTTP: `VaultSecretClient`'s shape for a
 * panel's login (F-102-c's rules, restated because they are the point): the
 * answer is **picked** field by field, so a value added to the other side's
 * reply by mistake stops here, and **no error carries the request**, whose
 * body is the login.
 */
@Injectable()
export class PanelCredentialClient implements PanelCredentialWriter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = String(config.get<string>('TENANT_API_BASE_URL', '') ?? '').replace(/\/+$/, '');
    this.token = String(config.get<string>('SERVICE_AUTH_TOKEN', '') ?? '');
    this.timeoutMs = Number(config.get<number>('TENANT_API_TIMEOUT_MS', 10_000));
  }

  async set(target: { tenantId: string; panelId: string }, credentials: string, actorId: string): Promise<PanelCredentialState> {
    if (!this.baseUrl) throw new PanelCredentialUnavailable('TENANT_API_BASE_URL is not set');
    if (!this.token) throw new PanelCredentialUnavailable('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${SEAM}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.token },
        body: JSON.stringify({ ...target, credentials, actorId }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new PanelCredentialUnavailable(`${SEAM} did not answer (${(e as Error).name})`);
    } finally {
      clearTimeout(timer);
    }

    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      if (REFUSALS.has(response.status)) {
        throw new PanelCredentialRefused(response.status as 400 | 403 | 404, this.reasonOf(answer) ?? `status_${response.status}`);
      }
      throw new PanelCredentialUnavailable(`${SEAM} answered ${response.status}`);
    }

    // tenant-service wraps answers in the shared envelope; accept both shapes.
    const data = (answer && typeof answer === 'object' && 'data' in answer ? answer['data'] : answer) as Record<string, unknown> | null;
    return {
      configured: data?.['configured'] === true,
      version: typeof data?.['version'] === 'number' ? data['version'] : null,
      rotatedAt: typeof data?.['rotatedAt'] === 'string' ? data['rotatedAt'] : null,
    };
  }

  /** A refusal's reason code — a short identifier, so nothing else from the body can pass as one. */
  private reasonOf(answer: Record<string, unknown> | null): string | null {
    const candidates = [answer?.['reason'], (answer?.['error'] as Record<string, unknown> | undefined)?.['reason']];
    const found = candidates.find((c) => typeof c === 'string' && /^[a-z_]{1,64}$/.test(c));
    return (found as string | undefined) ?? null;
  }
}
